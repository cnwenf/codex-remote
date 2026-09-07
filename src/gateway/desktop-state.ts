import { closeSync, mkdirSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { permissionStateFromProtocol } from "../protocol/permissions";
import { displayUserInput } from "../protocol/user-message-identity";
import { itemText, messageKind } from "../protocol/message-content";
import { isToolActivity, MAX_PENDING_TOOL_OUTPUTS, MAX_TOOL_OUTPUT_IMAGES, TOOL_TEXT_LIMIT, toolDetailsFromProtocol, toolOutputFromProtocol, type ToolDetails, type PendingToolOutput } from "../protocol/tool-content";
import { ImageUploadStore, MAX_IMAGE_BYTES } from "./image-upload-store";
import { registerAssistantImages } from "./assistant-images";
import { delegatedInputFromProtocol } from "../protocol/delegated-input";
import { mapToolOutputImages, PROJECTED_IMAGE_URL_PREFIX, registerToolOutputImages } from "./tool-output-images";
import { QuestionIndex } from "./question-index";
import type { QuestionContextRequest } from "../protocol/question-context";

const MAX_THREAD_IDS = 100;
const MAX_THREADS = 500;
const DEFAULT_HISTORY_TURNS = 8;
const MAX_HISTORY_TURNS = 8;
const DEFAULT_HISTORY_BYTES = 2 * 1024 * 1024;
const MAX_HISTORY_BYTES = 2 * 1024 * 1024;
const MAX_HISTORY_SCAN_BYTES = 8 * 1024 * 1024;
// Four supported 10 MiB attachments occupy about 54 MiB as base64.
const MAX_HISTORY_RECORD_BYTES = 64 * 1024 * 1024;
// Includes boundary searches, prefixes, and streaming image projection reads.
const MAX_HISTORY_PAGE_READ_BYTES = 4 * MAX_HISTORY_RECORD_BYTES;
const MAX_ITEM_TEXT = 4_000;
const MAX_TITLE_TEXT = 80;
const STATUS_TAIL_BYTES = 512 * 1024;
const MAX_STATUS_APPEND_BYTES = 4 * 1024 * 1024;
const TODO_TAIL_BYTES = 4 * 1024 * 1024;
const MAX_SESSION_INDEX_BYTES = 4 * 1024 * 1024;
const MAX_GLOBAL_STATE_BYTES = 8 * 1024 * 1024;
const MAX_IMAGE_DATA_URL_BYTES = 32 + 4 * Math.ceil(MAX_IMAGE_BYTES / 3);

type ThreadRow = {
  id: string;
  rollout_path: string;
  name: string | null;
  title: string;
  preview: string;
  cwd: string;
  is_pinned: number;
  model: string | null;
  reasoning_effort: string | null;
  sandbox_policy: string;
  approval_mode: string;
  updated_at_ms: number | null;
  recency_at_ms: number | null;
};

type DesktopProject = {
  id: string;
  name: string;
  rootPaths: string[];
};

type ParsedItem = ToolDetails & {
  toolOutputFromPending?: boolean;
  id: string;
  type: string;
  text: string;
  phase?: string;
  status?: string;
  imageIds?: string[];
  localImages?: Record<string, string>;
  sourceThreadId?: string;
  delegatedInputIsReplay?: boolean;
  explanation?: string;
  plan?: Array<{ step: string; status: string }>;
};
type RolloutSettings = {
  model?: string;
  reasoningEffort?: string;
  permissionProtocol?: Record<string, unknown>;
};
type ParsedTurn = {
  id: string;
  status: "inProgress" | "completed" | "interrupted" | "failed" | "unknown";
  error?: { message: string; additionalDetails?: string | null };
  items: ParsedItem[];
  completeFromTurnStart?: boolean;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
};
type ParsedTodoList = {
  explanation?: string;
  plan: Array<{ step: string; status: string }>;
};

export class DesktopState {
  private readonly database: DatabaseSync;
  private readonly allowedRolloutRoot: string;
  private readonly globalStatePath: string;
  private readonly sessionIndexPath: string;
  private readonly imageStore: ImageUploadStore;
  private readonly questionIndex: QuestionIndex;
  private sessionNamesCache: {
    mtimeMs: number;
    size: number;
    names: Map<string, string>;
  } | undefined;
  private readonly rolloutCache = new Map<string, {
    mtimeMs: number;
    size: number;
    isPinned: boolean;
    title: string;
    permissionKey: string;
    value: unknown;
  }>();
  private readonly statusCache = new Map<string, {
    mtimeMs: number;
    size: number;
    status: string;
  }>();
  private readonly settingsCache = new Map<string, {
    mtimeMs: number;
    size: number;
    settings?: RolloutSettings;
  }>();
  private readonly todoCache = new Map<string, {
    mtimeMs: number;
    size: number;
    todoList?: ParsedTodoList;
  }>();

  constructor(private readonly databasePath: string) {
    this.database = new DatabaseSync(databasePath, { readOnly: true });
    this.allowedRolloutRoot = resolve(dirname(databasePath), "sessions");
    this.globalStatePath = resolve(dirname(databasePath), ".codex-global-state.json");
    this.sessionIndexPath = resolve(dirname(databasePath), "session_index.jsonl");
    const cacheRoot = resolve(dirname(databasePath), "codex-remote");
    mkdirSync(cacheRoot, { recursive: true, mode: 0o700 });
    this.imageStore = new ImageUploadStore(
      resolve(cacheRoot, "uploads"),
    );
    this.questionIndex = new QuestionIndex(resolve(cacheRoot, "questions.sqlite"));
  }

  request(method: string, params: unknown) {
    if (method === "desktopState/listThreads") {
      return { data: this.listThreads(asRecord(params).archived === true) };
    }
    if (method === "desktopState/listThreadMetadata") {
      return { data: this.listThreadMetadata(asThreadIds(params)) };
    }
    if (method === "desktopState/readThread") {
      const request = asRecord(params);
      const threadId = stringValue(request.threadId);
      if (!threadId) throw new Error("threadId is required");
      const history = asRecord(request.history);
      if (request.history && typeof request.history === "object") {
        return this.readThreadPage(threadId, history);
      }
      const value = this.readThread(threadId);
      return request.incremental === true ? incrementalSnapshot(value) : value;
    }
    if (method === "desktopState/readQuestionContext") {
      const request = questionContextRequest(params);
      const row = this.readThreadRow(request.threadId);
      if (!row) throw new Error("Desktop thread not found");
      return this.questionIndex.read(this.validateRolloutPath(row.rollout_path), request);
    }
    if (method === "desktopState/readPermissionModeVisibility") {
      const visibility = asRecord(this.readDesktopAtomState()["composer-permission-mode-visibility"]);
      return {
        guardianApprovals: visibility["guardian-approvals"] !== false,
        fullAccess: visibility["full-access"] !== false,
      };
    }
    throw new Error("Unsupported Desktop state method");
  }

  close() {
    this.questionIndex.close();
    this.database.close();
  }

  private listThreadMetadata(threadIds: string[]) {
    if (threadIds.length === 0) return [];
    const placeholders = threadIds.map(() => "?").join(", ");
    const rows = this.database.prepare(`SELECT id, rollout_path, name, title, preview, cwd,
      is_pinned, model, reasoning_effort, sandbox_policy, approval_mode,
      updated_at_ms, recency_at_ms
      FROM threads
      WHERE archived = 0
        AND (thread_source IS NULL OR thread_source NOT IN ('subagent', 'guardian_review'))
        AND id IN (${placeholders})`).all(...threadIds) as ThreadRow[];
    const pinnedThreadIds = this.readPinnedThreadIds();
    const pinned = pinnedThreadIds === undefined ? undefined : new Set(pinnedThreadIds);
    const sessionNames = this.readSessionThreadNames();
    const atomState = this.readDesktopAtomState();
    const projects = this.readDesktopProjects();
    const byId = new Map(rows.map((row) => [
      row.id,
      this.threadMetadata(row, undefined, pinned?.has(row.id), sessionNames.get(row.id), atomState, projects),
    ]));
    return threadIds.flatMap((id) => byId.get(id) ?? []);
  }

  private listThreads(archived = false) {
    const rows = this.database.prepare(`SELECT id, rollout_path, name, title, preview, cwd,
      is_pinned, model, reasoning_effort, sandbox_policy, approval_mode,
      updated_at_ms, recency_at_ms
      FROM threads
      WHERE archived = ?
        AND (thread_source IS NULL OR thread_source NOT IN ('subagent', 'guardian_review'))
      ORDER BY COALESCE(recency_at_ms, updated_at_ms, created_at_ms) DESC
      LIMIT ?`).all(archived ? 1 : 0, MAX_THREADS) as ThreadRow[];
    const pinnedThreadIds = this.readPinnedThreadIds();
    const pinned = pinnedThreadIds === undefined ? undefined : new Set(pinnedThreadIds);
    const sessionNames = this.readSessionThreadNames();
    const atomState = this.readDesktopAtomState();
    const projects = this.readDesktopProjects();
    const orderedRows = archived || pinnedThreadIds === undefined
      ? rows
      : [
          ...pinnedThreadIds.flatMap((id) => rows.find((row) => row.id === id) ?? []),
          ...rows.filter((row) => !pinnedThreadIds.includes(row.id)),
        ];
    return orderedRows.map((row) => this.threadMetadata(
      row,
      this.rolloutStatus(row.rollout_path),
      archived ? false : pinned?.has(row.id),
      sessionNames.get(row.id),
      atomState,
      projects,
    ));
  }

  private readThread(threadId: string) {
    const row = this.readThreadRow(threadId);
    if (!row) throw new Error("Desktop thread not found");
    const rolloutPath = this.validateRolloutPath(row.rollout_path);
    const stat = statSync(rolloutPath);
    const pinnedThreadIds = this.readPinnedThreadIds();
    const isPinned = pinnedThreadIds === undefined
      ? row.is_pinned === 1
      : pinnedThreadIds.includes(row.id);
    const title = displayTitle(row, this.readSessionThreadNames().get(row.id));
    const latestSettings = this.readRolloutSettings(row.rollout_path);
    const permissionProtocol = latestSettings?.permissionProtocol ?? this.readThreadPermissionProtocol(row);
    const permissionKey = JSON.stringify(permissionProtocol);
    const cached = this.rolloutCache.get(threadId);
    if (
      cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size &&
      cached.isPinned === isPinned && cached.title === title &&
      cached.permissionKey === permissionKey
    ) return cached.value;
    const page = readConversationPage(
      rolloutPath,
      stat.size,
      DEFAULT_HISTORY_TURNS,
      DEFAULT_HISTORY_BYTES,
      this.imageStore,
    );
    const value = {
      ...threadSnapshot(
        row,
        page.turns,
        isPinned,
        title,
        permissionProtocol,
        latestSettings,
        matchDesktopProject(row.cwd, this.readDesktopProjects()),
        this.readLatestTodoList(row.rollout_path),
        page.pendingToolOutputs,
        page.toolOutputOverflow,
      ),
      history: page.start > 0
        ? { hasMoreBefore: true, beforeCursor: String(page.start) }
        : { hasMoreBefore: false },
    };
    this.rolloutCache.set(threadId, {
      mtimeMs: stat.mtimeMs,
      size: stat.size,
      isPinned,
      title,
      permissionKey,
      value,
    });
    return value;
  }

  private readThreadPage(threadId: string, history: Record<string, unknown>) {
    const row = this.readThreadRow(threadId);
    if (!row) throw new Error("Desktop thread not found");
    const rolloutPath = this.validateRolloutPath(row.rollout_path);
    const stat = statSync(rolloutPath);
    const before = historyCursor(history.beforeCursor, stat.size);
    const limitTurns = clampInteger(history.limitTurns, DEFAULT_HISTORY_TURNS, 1, MAX_HISTORY_TURNS);
    const maxBytes = clampInteger(history.maxBytes, DEFAULT_HISTORY_BYTES, 64 * 1024, MAX_HISTORY_BYTES);
    const page = readConversationPage(rolloutPath, before, limitTurns, maxBytes, this.imageStore);
    const pinnedThreadIds = this.readPinnedThreadIds();
    const isPinned = pinnedThreadIds === undefined
      ? row.is_pinned === 1
      : pinnedThreadIds.includes(row.id);
    const title = displayTitle(row, this.readSessionThreadNames().get(row.id));
    const latestSettings = this.readRolloutSettings(row.rollout_path);
    return {
      ...threadSnapshot(
        row,
        page.turns,
        isPinned,
        title,
        latestSettings?.permissionProtocol ?? this.readThreadPermissionProtocol(row),
        latestSettings,
        matchDesktopProject(row.cwd, this.readDesktopProjects()),
        this.readLatestTodoList(row.rollout_path),
        page.pendingToolOutputs,
        page.toolOutputOverflow,
      ),
      history: page.start > 0
        ? { hasMoreBefore: true, beforeCursor: String(page.start) }
        : { hasMoreBefore: false },
    };
  }

  private readThreadRow(threadId: string) {
    return this.database.prepare(`SELECT id, rollout_path, name, title, preview, cwd,
      is_pinned, model, reasoning_effort, sandbox_policy, approval_mode,
      updated_at_ms, recency_at_ms
      FROM threads
      WHERE archived = 0
        AND (thread_source IS NULL OR thread_source NOT IN ('subagent', 'guardian_review'))
        AND id = ?`).get(threadId) as ThreadRow | undefined;
  }

  private readPinnedThreadIds(): string[] | undefined {
    try {
      const value = readBoundedJson(this.globalStatePath, MAX_GLOBAL_STATE_BYTES);
      const pinned = asRecord(value)["pinned-thread-ids"];
      if (!Array.isArray(pinned)) return undefined;
      return [...new Set(pinned.filter((id): id is string => typeof id === "string"))]
        .slice(0, MAX_THREADS);
    } catch {
      // Older Codex builds can still use the SQLite pin column.
      return undefined;
    }
  }

  private readDesktopAtomState() {
    try {
      const value = asRecord(readBoundedJson(this.globalStatePath, MAX_GLOBAL_STATE_BYTES));
      return asRecord(value["electron-persisted-atom-state"]);
    } catch {
      return {};
    }
  }

  private readDesktopProjects(): DesktopProject[] {
    try {
      const value = asRecord(readBoundedJson(this.globalStatePath, MAX_GLOBAL_STATE_BYTES));
      return Object.entries(asRecord(value["local-projects"])).flatMap(([key, raw]) => {
        const project = asRecord(raw);
        const id = stringValue(project.id) ?? key;
        const name = stringValue(project.name);
        const rootPaths = Array.isArray(project.rootPaths)
          ? [...new Set(project.rootPaths.filter((path): path is string => typeof path === "string" && path.length > 0))]
          : [];
        return name && rootPaths.length > 0 ? [{ id, name, rootPaths }] : [];
      });
    } catch {
      return [];
    }
  }

  private readThreadPermissionProtocol(
    row: ThreadRow,
    atomState = this.readDesktopAtomState(),
  ): Record<string, unknown> {
    const byThread = asRecord(atomState["heartbeat-thread-permissions-by-id"]);
    const heartbeat = asRecord(byThread[row.id]);
    const activePermissionProfile = asRecord(heartbeat.activePermissionProfile);
    const sandboxPolicy = asRecord(heartbeat.sandboxPolicy);
    if (
      Object.hasOwn(heartbeat, "approvalPolicy") ||
      Object.hasOwn(heartbeat, "approvalsReviewer") ||
      Object.hasOwn(heartbeat, "sandboxPolicy") ||
      Object.hasOwn(heartbeat, "activePermissionProfile")
    ) {
      return {
        approvalPolicy: sanitizeApprovalPolicy(heartbeat.approvalPolicy),
        approvalsReviewer: stringValue(heartbeat.approvalsReviewer),
        sandboxPolicy: stringValue(sandboxPolicy.type)
          ? { type: stringValue(sandboxPolicy.type) }
          : undefined,
        activePermissionProfile: stringValue(activePermissionProfile.id)
          ? { id: stringValue(activePermissionProfile.id) }
          : null,
      };
    }
    return storedPermissionProtocol(row);
  }

  private threadMetadata(
    row: ThreadRow,
    status?: { type: string },
    pinnedOverride?: boolean,
    preferredTitle?: string,
    atomState = this.readDesktopAtomState(),
    projects = this.readDesktopProjects(),
  ) {
    const settings = this.readRolloutSettings(row.rollout_path);
    return metadata(
      row,
      status,
      pinnedOverride,
      preferredTitle,
      settings?.permissionProtocol ?? this.readThreadPermissionProtocol(row, atomState),
      settings,
      matchDesktopProject(row.cwd, projects),
    );
  }

  private readRolloutSettings(path: string): RolloutSettings | undefined {
    try {
      const rolloutPath = this.validateRolloutPath(path);
      const stat = statSync(rolloutPath);
      const cached = this.settingsCache.get(rolloutPath);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        return cached.settings;
      }
      if (cached && stat.size >= cached.size) {
        const appendedBytes = stat.size - cached.size;
        if (appendedBytes <= MAX_STATUS_APPEND_BYTES) {
          const appendedSettings = settingsFromRolloutText(
            readFileRange(rolloutPath, cached.size, appendedBytes),
          );
          const settings = appendedSettings ?? cached.settings;
          this.settingsCache.set(rolloutPath, {
            mtimeMs: stat.mtimeMs,
            size: stat.size,
            settings,
          });
          return settings;
        }
      }
      const length = Math.min(stat.size, STATUS_TAIL_BYTES);
      const settings = settingsFromRolloutText(
        readFileRange(rolloutPath, stat.size - length, length),
      );
      this.settingsCache.set(rolloutPath, { mtimeMs: stat.mtimeMs, size: stat.size, settings });
      return settings;
    } catch {
      return undefined;
    }
  }

  private readLatestTodoList(path: string) {
    try {
      const rolloutPath = this.validateRolloutPath(path);
      const stat = statSync(rolloutPath);
      const cached = this.todoCache.get(rolloutPath);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        return cached.todoList;
      }
      if (cached && stat.size >= cached.size) {
        const appendedBytes = stat.size - cached.size;
        if (appendedBytes <= MAX_STATUS_APPEND_BYTES) {
          const appendedTodoList = todoListFromRolloutText(
            readFileRange(rolloutPath, cached.size, appendedBytes),
          );
          const todoList = appendedTodoList ?? cached.todoList;
          this.todoCache.set(rolloutPath, { mtimeMs: stat.mtimeMs, size: stat.size, todoList });
          return todoList;
        }
      }
      const length = Math.min(stat.size, TODO_TAIL_BYTES);
      const todoList = todoListFromRolloutText(
        readFileRange(rolloutPath, stat.size - length, length),
      );
      this.todoCache.set(rolloutPath, { mtimeMs: stat.mtimeMs, size: stat.size, todoList });
      return todoList;
    } catch {
      return undefined;
    }
  }

  private readSessionThreadNames() {
    try {
      const stat = statSync(this.sessionIndexPath);
      if (
        this.sessionNamesCache?.mtimeMs === stat.mtimeMs &&
        this.sessionNamesCache.size === stat.size
      ) return this.sessionNamesCache.names;
      const names = new Map<string, string>();
      const length = Math.min(stat.size, MAX_SESSION_INDEX_BYTES);
      let raw = readFileRange(this.sessionIndexPath, stat.size - length, length);
      if (stat.size > length) raw = raw.slice(Math.max(0, raw.indexOf("\n") + 1));
      for (const line of raw.split("\n")) {
        if (!line.trim()) continue;
        let entry: Record<string, unknown>;
        try { entry = asRecord(JSON.parse(line)); } catch { continue; }
        const id = stringValue(entry.id);
        const name = stringValue(entry.thread_name)?.trim();
        if (id && name) names.set(id, name);
      }
      this.sessionNamesCache = { mtimeMs: stat.mtimeMs, size: stat.size, names };
      return names;
    } catch {
      return new Map<string, string>();
    }
  }

  private validateRolloutPath(path: string) {
    const real = realpathSync(path);
    const root = realpathSync(this.allowedRolloutRoot);
    if (real !== root && !real.startsWith(`${root}${sep}`)) {
      throw new Error("Desktop rollout path is outside the Codex sessions directory");
    }
    return real;
  }

  private rolloutStatus(path: string) {
    try {
      const rolloutPath = this.validateRolloutPath(path);
      const stat = statSync(rolloutPath);
      const cached = this.statusCache.get(rolloutPath);
      if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
        return { type: cached.status };
      }
      if (cached && stat.size >= cached.size) {
        const appendedBytes = stat.size - cached.size;
        if (appendedBytes <= MAX_STATUS_APPEND_BYTES) {
          const appendedStatus = statusFromRolloutText(
            readFileRange(rolloutPath, cached.size, appendedBytes),
          );
          const status = appendedStatus === "unknown" ? cached.status : appendedStatus;
          this.statusCache.set(rolloutPath, { mtimeMs: stat.mtimeMs, size: stat.size, status });
          return { type: status };
        }
      }
      const length = Math.min(stat.size, STATUS_TAIL_BYTES);
      const tailStatus = statusFromRolloutText(
        readFileRange(rolloutPath, stat.size - length, length),
      );
      const status = tailStatus;
      this.statusCache.set(rolloutPath, { mtimeMs: stat.mtimeMs, size: stat.size, status });
      return { type: status };
    } catch {
      // A moved or deleted rollout should not hide the rest of the Desktop list.
    }
    return { type: "unknown" };
  }
}

function readFileRange(path: string, position: number, length: number) {
  return readBufferRange(path, position, length).toString("utf8");
}

function readBoundedJson(path: string, maxBytes: number) {
  const stat = statSync(path);
  if (stat.size > maxBytes) throw new Error("Desktop state file is too large");
  return JSON.parse(readFileSync(path, "utf8")) as unknown;
}

function readBufferRange(path: string, position: number, length: number) {
  if (length <= 0) return Buffer.alloc(0);
  const buffer = Buffer.allocUnsafe(length);
  const descriptor = openSync(path, "r");
  try {
    const bytesRead = readSync(descriptor, buffer, 0, length, position);
    return buffer.subarray(0, bytesRead);
  } finally {
    closeSync(descriptor);
  }
}

function turnBoundaries(buffer: Buffer, baseOffset: number) {
  const boundaries: Array<{ id: string; offset: number }> = [];
  const seen = new Set<string>();
  let lineStart = 0;
  while (lineStart < buffer.length) {
    const newline = buffer.indexOf(10, lineStart);
    const lineEnd = newline >= 0 ? newline : buffer.length;
    const line = buffer.subarray(lineStart, lineEnd).toString("utf8");
    let entry: Record<string, unknown>;
    try { entry = asRecord(JSON.parse(line)); } catch {
      lineStart = newline >= 0 ? newline + 1 : buffer.length;
      continue;
    }
    const payload = asRecord(entry.payload);
    // Context records can repeat inside a turn after compaction/resume.
    // Only the task-start event is a trustworthy prefix boundary.
    const id = entry.type === "event_msg" && stringValue(payload.type) === "task_started"
      ? stringValue(payload.turn_id)
      : undefined;
    if (id && !seen.has(id)) {
      seen.add(id);
      boundaries.push({ id, offset: baseOffset + lineStart });
    }
    lineStart = newline >= 0 ? newline + 1 : buffer.length;
  }
  return boundaries;
}

function readConversationPage(
  path: string,
  before: number,
  limitTurns: number,
  maxBytes: number,
  imageStore: ImageUploadStore,
) {
  let cursor = before;
  let pendingRaw = "";
  let recoveryCount = 0;
  let remainingReadBytes = MAX_HISTORY_PAGE_READ_BYTES;
  const tooLarge = () => new Error("History page is too large to resolve its turn context safely; cursor was not advanced. Open this history in Codex Desktop.");
  const readRange = (start: number, length: number) => {
    if (length > remainingReadBytes) throw tooLarge();
    remainingReadBytes -= length;
    return readBufferRange(path, start, length);
  };
  const scanFloor = Math.max(0, before - MAX_HISTORY_SCAN_BYTES);
  while (cursor > 0 && (pendingRaw || cursor > scanFloor)) {
    // The record limit applies to each record, not the entire pending page:
    // multiple supported image records can share an older turn context.
    const recordFloor = Math.max(0, cursor - MAX_HISTORY_RECORD_BYTES);
    const rangeStart = Math.max(pendingRaw ? recordFloor : scanFloor, cursor - maxBytes);
    const buffer = readRange(rangeStart, cursor - rangeStart);
    let alignedStart = rangeStart;
    let relativeStart = 0;
    if (rangeStart > 0) {
      const newline = buffer.indexOf(10);
      if (newline < 0) {
        relativeStart = buffer.length;
        alignedStart = cursor;
      } else {
        relativeStart = newline + 1;
        alignedStart += relativeStart;
      }
    }
    const aligned = buffer.subarray(relativeStart);
    const boundaries = turnBoundaries(aligned, alignedStart);
    const selectedBoundary = boundaries.length >= limitTurns
      ? boundaries[boundaries.length - limitTurns]
      : boundaries[0];
    const pageStart = rangeStart === 0 && boundaries.length <= limitTurns
      ? 0
      : selectedBoundary?.offset ?? alignedStart;
    const pageRelativeStart = Math.max(0, pageStart - rangeStart);
    const parsed = parseRollout(buffer.subarray(pageRelativeStart).toString("utf8") + pendingRaw, imageStore);
    if (((parsed.turns.length > 0 || parsed.pendingToolOutputs.length > 0) && !parsed.hasUnassignedItems) || pageStart === 0) {
      return { start: pageStart, ...parsed };
    }
    // The next older page can end immediately after a single image record.
    // Keep its original byte offsets, but never materialize its base64 body.
    if (rangeStart > 0) {
      // ponytail: bound context recovery to eight records and 256 MiB total
      // I/O; a resumable context cursor is needed to support larger fragments.
      if (++recoveryCount > MAX_HISTORY_TURNS) throw tooLarge();
      const recordEnd = relativeStart > 0 ? alignedStart : cursor;
      let position = rangeStart;
      let recordStart: number | undefined;
      while (position > recordFloor) {
        const start = Math.max(recordFloor, position - maxBytes);
        const preceding = readRange(start, position - start);
        const newline = preceding.lastIndexOf(10);
        if (newline >= 0) { recordStart = start + newline + 1; break; }
        position = start;
      }
      if (recordStart === undefined && position === 0) recordStart = 0;
      if (recordStart !== undefined) {
        const prefixStart = Math.max(0, recordStart - maxBytes);
        const prefix = readRange(prefixStart, recordStart - prefixStart);
        const prefixNewline = prefix.indexOf(10);
        const prefixOffset = prefixStart > 0 ? (prefixNewline < 0 ? prefix.length : prefixNewline + 1) : 0;
        const prefixBoundaries = turnBoundaries(prefix.subarray(prefixOffset), prefixStart + prefixOffset);
        const boundary = prefixBoundaries.length >= limitTurns
          ? prefixBoundaries[prefixBoundaries.length - limitTurns]
          : prefixBoundaries[0];
        const start = prefixStart === 0 && prefixBoundaries.length <= limitTurns
          ? 0 : boundary?.offset ?? prefixStart + prefixOffset;
        const projected = projectHistoryRecord(readRange, recordStart, recordEnd, imageStore);
        if (projected === undefined) {
          // An unsupported text message is not disposable metadata. Classify
          // with bounded string prefixes, never exposing a truncated message.
          const classified = projectToolHistoryRecord(readRange, recordStart, recordEnd, true);
          const record = classified ? asRecord(JSON.parse(classified)) : {};
          const firstCharacter = readRange(recordStart, Math.min(64, recordEnd - recordStart)).toString("utf8").trimStart()[0];
          const ignoredEvent = record.type === "event_msg" &&
            ["agent_reasoning", "token_count"].includes(String(asRecord(record.payload).type));
          if ((!record.type && (!firstCharacter || firstCharacter === "{")) ||
            record.type === "response_item" || record.type === "turn_context" ||
            (record.type === "event_msg" && !ignoredEvent)) throw tooLarge();
        }
        const raw = prefix.subarray(start - prefixStart).toString("utf8") +
          (projected ?? "invalid-oversized-record\n") + aligned.toString("utf8") + pendingRaw;
        const recovered = parseRollout(raw, imageStore);
        if (((recovered.turns.length > 0 || recovered.pendingToolOutputs.length > 0) && !recovered.hasUnassignedItems) || start === 0) {
          return { start, ...recovered };
        }
        // Anonymous messages may precede an image with its own turn id. Keep
        // the bounded projection until older context identifies the prefix.
        if (Buffer.byteLength(raw) > MAX_HISTORY_BYTES) throw tooLarge();
        pendingRaw = raw;
        cursor = start;
        continue;
      }
      // No complete record boundary within the budget: advancing here could
      // silently skip a tool result. Readable newer items already returned above.
      throw tooLarge();
    }
    cursor = pageStart < cursor ? pageStart : rangeStart;
  }
  if (pendingRaw) throw tooLarge();
  return { start: Math.min(cursor, scanFloor), turns: [] as ParsedTurn[], pendingToolOutputs: [] as PendingToolOutput[], toolOutputOverflow: false };
}

/** @internal Exported only for bounded projector regression tests. */
export function projectHistoryRecord(
  readRange: (start: number, length: number) => Buffer,
  start: number,
  end: number,
  imageStore: ImageUploadStore,
): string | undefined {
  const toolRecord = projectToolHistoryRecord(readRange, start, end);
  if (toolRecord) return toolRecord;
  const output = Buffer.allocUnsafe(MAX_HISTORY_BYTES);
  type DeferredString = {
    sourceStart: number;
    sourceEnd: number;
  };
  const containers: ("object" | "array")[] = [];
  const deferredStrings = new Map<string, DeferredString>();
  let length = 0;
  let inString = false;
  let escaped = false;
  let stringStart = 0;
  let stringSourceStart = 0;
  let stringProperty = "";
  let omit = false;
  let lastString = "";
  let lastToken = 0;
  let sourceOffset = start;
  const deferredBytes = (deferred: DeferredString, limit: number) => {
    const deferredLength = deferred.sourceEnd - deferred.sourceStart;
    return deferredLength <= limit ? readRange(deferred.sourceStart, deferredLength) : undefined;
  };
  for (let position = start; position < end; position += 64 * 1024) {
    const chunk = readRange(position, Math.min(64 * 1024, end - position));
    for (let chunkOffset = 0; chunkOffset < chunk.length; chunkOffset++) {
      const byte = chunk[chunkOffset];
      sourceOffset = position + chunkOffset;
      if (!omit) {
        if (length >= output.length) return undefined;
        output[length++] = byte;
      }
      if (inString) {
        const closesString = byte === 34 && !escaped;
        if (escaped) { escaped = false; continue; }
        if (byte === 92) {
          escaped = true;
          continue;
        }
        if (closesString) {
          if (omit) {
            // Every string-valued data/image_url is replaced, so source values
            // cannot impersonate these local span keys. The bounded output also
            // bounds their count; no image bytes are retained while scanning.
            const key = String(deferredStrings.size);
            deferredStrings.set(key, {
              sourceStart: stringSourceStart,
              sourceEnd: sourceOffset,
            });
            if (length + key.length + 1 > output.length) return undefined;
            length += output.write(key, length, "ascii");
            output[length++] = byte;
          }
          const closedString = length - stringStart < 128
            ? output.subarray(stringStart, length - 1).toString("utf8") : "";
          try { lastString = closedString ? JSON.parse(`"${closedString}"`) as string : ""; }
          catch { return undefined; }
          lastToken = 34;
          inString = false;
          omit = false;
          stringProperty = "";
        }
      } else if (byte === 34) {
        inString = true;
        stringStart = length;
        stringSourceStart = sourceOffset + 1;
        stringProperty = lastToken === 58 ? lastString : "";
        omit = containers.at(-1) === "object" && (stringProperty === "data" || stringProperty === "image_url");
      } else if (byte > 32) {
        if (byte === 123) {
          if (containers.length >= 512) return undefined;
          containers.push("object");
        } else if (byte === 91) {
          if (containers.length >= 512) return undefined;
          containers.push("array");
        } else if (byte === 125) {
          if (containers.pop() !== "object") return undefined;
        } else if (byte === 93) {
          if (containers.pop() !== "array") return undefined;
        }
        lastToken = byte;
      }
    }
  }
  if (containers.length || inString) return undefined;
  let record: Record<string, unknown>;
  try { record = asRecord(JSON.parse(output.subarray(0, length).toString("utf8"))); }
  catch { return undefined; }
  const payload = asRecord(record.payload);
  const tool = isToolActivity(String(payload.type ?? ""));
  const span = (value: unknown) => typeof value === "string" ? deferredStrings.get(value) : undefined;
  const isDataImageUrl = (deferred: DeferredString) => readRange(deferred.sourceStart,
    Math.min(11, deferred.sourceEnd - deferred.sourceStart)).toString("ascii") === "data:image/";
  const imageUrl = (part: Record<string, unknown>) => {
    const urlSpan = span(part.image_url);
    const dataSpan = span(part.data);
    const deferred = urlSpan ?? (part.type === "image" ? dataSpan : undefined);
    const encoded = deferred && deferredBytes(deferred, MAX_IMAGE_DATA_URL_BYTES);
    if (!encoded) throw historyImageError("image-too-large");
    const value = JSON.parse(`"${encoded.toString("utf8")}"`) as string;
    return urlSpan || value.startsWith(PROJECTED_IMAGE_URL_PREFIX) ? value
      : `data:${String(part.mimeType ?? "")};base64,${value}`;
  };
  let imageCount = 0;
  if (tool) {
    // Classify complete ancestors before reading image bodies. This is exactly
    // registration's traversal and field order, including its stop at images.
    record.payload = mapToolOutputImages(payload, (part) => {
      let marker = `${PROJECTED_IMAGE_URL_PREFIX}invalid`;
      if (++imageCount <= MAX_TOOL_OUTPUT_IMAGES) {
        try { marker = `${PROJECTED_IMAGE_URL_PREFIX}${restoreHistoryImage(imageStore, imageUrl(part))}`; }
        catch { /* Registration marks the invalid stored-image marker incomplete. */ }
      }
      return part.type === "image" ? { type: part.type, data: marker, mimeType: part.mimeType }
        : { type: part.type, image_url: marker };
    });
  }
  let restoredBytes = length;
  let unsupported = false;
  const projected = JSON.stringify(record, function (key, value: unknown): unknown {
    if (!tool && value && typeof value === "object" && !Array.isArray(value)) {
      const part = value as Record<string, unknown>;
      // Preserve legacy message input_image recovery, including its errors.
      const deferred = span(part.image_url);
      if (part.type === "input_image" && deferred && isDataImageUrl(deferred)) {
        return { ...part, image_url: `${PROJECTED_IMAGE_URL_PREFIX}${restoreHistoryImage(imageStore, imageUrl(part))}` };
      }
    }
    if (key !== "data" && key !== "image_url") return value;
    const deferred = span(value);
    if (!deferred) return value;
    // Undeclared image_url bytes remain transport-only noise, as before.
    const size = deferred.sourceEnd - deferred.sourceStart;
    if (key === "image_url" && isDataImageUrl(deferred)) return "";
    if (size > MAX_HISTORY_BYTES - restoredBytes) { unsupported = true; return ""; }
    restoredBytes += size;
    const encoded = deferredBytes(deferred, size)!;
    try { return JSON.parse(`"${encoded.toString("utf8")}"`) as string; }
    catch { unsupported = true; return ""; }
  });
  return !unsupported && Buffer.byteLength(projected) + 1 <= MAX_HISTORY_BYTES ? `${projected}\n` : undefined;
}

function projectToolHistoryRecord(
  readRange: (start: number, length: number) => Buffer,
  start: number,
  end: number,
  classifyOnly = false,
): string | undefined {
  const output = Buffer.allocUnsafe(MAX_HISTORY_BYTES);
  const truncated = new Set<string>();
  let length = 0;
  let depth = 0;
  let inString = false;
  let escaped = false;
  let unicodeRemaining = 0;
  let stringStart = 0;
  let property = "";
  let omit = false;
  let lastString = "";
  let lastToken = 0;
  for (let position = start; position < end; position += 64 * 1024) {
    const chunk = readRange(position, Math.min(64 * 1024, end - position));
    for (const byte of chunk) {
      // Six JSON bytes per UTF-16 code unit covers even escaped Unicode.
      // Cut only between complete escapes and UTF-8 characters; the shared
      // details helper applies the final 16K-character limit after decoding.
      if (property && !omit && length - stringStart >= TOOL_TEXT_LIMIT * 6 &&
        !escaped && unicodeRemaining === 0 && (byte & 0xc0) !== 0x80) {
        omit = true;
        truncated.add(property);
      }
      const closesString = inString && !escaped && unicodeRemaining === 0 && byte === 34;
      if (!omit || closesString) {
        if (length >= output.length) return undefined;
        output[length++] = byte;
      }
      if (inString) {
        if (unicodeRemaining > 0) { unicodeRemaining--; continue; }
        if (escaped) { escaped = false; if (byte === 117) unicodeRemaining = 4; continue; }
        if (byte === 92) { escaped = true; continue; }
        if (closesString) {
          try {
            lastString = length - stringStart < 128
              ? JSON.parse(output.subarray(stringStart - 1, length).toString("utf8")) as string : "";
          } catch { return undefined; }
          lastToken = 34;
          inString = false;
          omit = false;
          property = "";
        }
      } else if (byte === 34) {
        inString = true;
        stringStart = length;
        property = classifyOnly ? "value"
          : lastToken === 58 && (depth === 2 && ["arguments", "input", "output"].includes(lastString) ||
            depth === 3 && ["toolOutput", "aggregatedOutput", "output", "result", "content",
              "aggregated_output", "formatted_output", "stdout", "stderr"].includes(lastString))
            ? lastString : "";
      } else if (byte > 32) {
        if (byte === 123 || byte === 91) depth++;
        if (byte === 125 || byte === 93) depth--;
        lastToken = byte;
      }
    }
  }
  let record: Record<string, unknown>;
  try { record = asRecord(JSON.parse(output.subarray(0, length).toString("utf8"))); } catch { return undefined; }
  const payload = asRecord(record.payload);
  if (classifyOnly) return JSON.stringify(record);
  const nativeCommand = asRecord(payload.item);
  const isNativeCommand = record.type === "event_msg" && payload.type === "item_completed" &&
    String(nativeCommand.type ?? "").replace(/[_-]/g, "").toLowerCase() === "commandexecution";
  if (isNativeCommand) {
    const selectedOutput = toolOutputFromProtocol(nativeCommand);
    if (selectedOutput && truncated.has(selectedOutput.key)) nativeCommand.outputTruncated = true;
    return `${JSON.stringify(record)}\n`;
  }
  if (record.type !== "response_item" ||
    !["function_call", "custom_tool_call", "function_call_output", "custom_tool_call_output"].includes(String(payload.type))) return undefined;
  // Delegation wrappers are messages, not disposable tool-output prefixes.
  if (truncated.has("output") && payload.type === "function_call_output" &&
    payload.namespace === "codex_app" && payload.name === "send_message_to_thread" &&
    payload.call_id === undefined && payload.callId === undefined &&
    typeof payload.output === "string" && /^\s*<codex_delegation>/.test(payload.output)) return undefined;
  if (truncated.has("output")) payload.outputTruncated = true;
  if (truncated.has("input") || truncated.has("arguments")) payload.inputTruncated = true;
  return `${JSON.stringify(record)}\n`;
}

function historyImageError(message: string) {
  return new Error(`History image could not be restored: ${message}`);
}

function hasRolloutError(value: unknown) {
  return typeof value === "string" ? value.trim().length > 0
    : Boolean(value && typeof value === "object" && Object.keys(value).length > 0);
}

function rolloutTurnError(value: unknown) {
  const error = asRecord(value);
  const message = stringValue(error.message);
  if (!message) return undefined;
  return {
    message,
    ...(error.additionalDetails === null || typeof error.additionalDetails === "string"
      ? { additionalDetails: error.additionalDetails }
      : {}),
  };
}

function restoreHistoryImage(imageStore: ImageUploadStore, imageUrl: string) {
  try {
    if (imageUrl.startsWith(PROJECTED_IMAGE_URL_PREFIX)) {
      const id = imageStore.referenceForStoredId(imageUrl.slice(PROJECTED_IMAGE_URL_PREFIX.length));
      if (!id) throw new Error("image-upload-not-found");
      return id;
    }
    return imageStore.referenceForDataUrl(imageUrl);
  } catch (cause) {
    throw historyImageError(cause instanceof Error ? cause.message : "image-unreadable");
  }
}

function threadSnapshot(
  row: ThreadRow,
  turns: ParsedTurn[],
  isPinned: boolean,
  title = displayTitle(row),
  permissionProtocol: Record<string, unknown> = storedPermissionProtocol(row),
  settings?: RolloutSettings,
  project?: DesktopProject,
  todoList?: ParsedTodoList,
  pendingToolOutputs: PendingToolOutput[] = [],
  toolOutputOverflow = false,
) {
  const latestStatus = turns.at(-1)?.status;
  const active = latestStatus === "inProgress";
  return {
    desktopMirror: true,
    thread: {
      id: row.id,
      name: title,
      cwd: row.cwd,
      projectId: project?.id,
      projectName: project?.name,
      projectRootPaths: project?.rootPaths,
      status: { type: active ? "active" : latestStatus === "failed" ? "error" : "idle" },
      section: isPinned ? { id: "desktop-pinned", name: "Pinned" } : null,
      todoList,
      turns,
      pendingToolOutputs,
      toolOutputOverflow,
    },
    model: settings?.model ?? row.model ?? undefined,
    reasoningEffort: settings?.reasoningEffort ?? row.reasoning_effort ?? undefined,
    ...permissionStateFromProtocol(permissionProtocol),
    ...permissionProtocol,
    sandbox: permissionProtocol.sandboxPolicy,
  };
}

function historyCursor(value: unknown, fileSize: number) {
  if (value === undefined) return fileSize;
  if (typeof value !== "string" || !/^\d+$/.test(value)) throw new Error("Invalid history cursor");
  const cursor = Number(value);
  if (!Number.isSafeInteger(cursor) || cursor < 0 || cursor > fileSize) {
    throw new Error("Invalid history cursor");
  }
  return cursor;
}

function clampInteger(value: unknown, fallback: number, minimum: number, maximum: number) {
  if (typeof value !== "number" || !Number.isFinite(value)) return fallback;
  return Math.min(maximum, Math.max(minimum, Math.floor(value)));
}

function statusFromRolloutText(raw: string) {
  const lines = raw.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let entry: Record<string, unknown>;
    try { entry = asRecord(JSON.parse(lines[index])); } catch { continue; }
    if (entry.type !== "event_msg") continue;
    const payload = asRecord(entry.payload);
    const type = stringValue(payload.type);
    if (type === "task_started") return "active";
    if (type === "task_complete") return hasRolloutError(payload.error) ? "error" : "idle";
    if (type === "turn_aborted") return "idle";
  }
  return "unknown";
}

function settingsFromRolloutText(raw: string): RolloutSettings | undefined {
  const lines = raw.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let entry: Record<string, unknown>;
    try { entry = asRecord(JSON.parse(lines[index])); } catch { continue; }
    if (entry.type !== "event_msg") continue;
    const payload = asRecord(entry.payload);
    if (payload.type !== "thread_settings_applied") continue;
    const settings = asRecord(payload.thread_settings);
    const activeProfile = asRecord(settings.active_permission_profile);
    const permissionProfile = asRecord(settings.permission_profile);
    const permissionType = stringValue(permissionProfile.type);
    const sandboxPolicy = permissionType === "disabled"
      ? { type: "dangerFullAccess" }
      : permissionType === "readOnly" || permissionType === "read-only"
        ? { type: "readOnly" }
        : permissionType
          ? { type: "workspaceWrite" }
          : undefined;
    const permissionProtocol = {
      approvalPolicy: sanitizeApprovalPolicy(settings.approval_policy),
      approvalsReviewer: stringValue(settings.approvals_reviewer),
      sandboxPolicy,
      activePermissionProfile: stringValue(activeProfile.id)
        ? { id: stringValue(activeProfile.id) }
        : null,
    };
    return {
      model: stringValue(settings.model),
      reasoningEffort: stringValue(settings.reasoning_effort),
      permissionProtocol,
    };
  }
  return undefined;
}

function incrementalSnapshot(value: unknown) {
  const outer = asRecord(value);
  const thread = asRecord(outer.thread);
  const turns = Array.isArray(thread.turns) ? thread.turns : [];
  return {
    ...outer,
    thread: {
      ...thread,
      turns: turns.length > 0 ? [turns[turns.length - 1]] : [],
    },
  };
}

function metadata(
  row: ThreadRow,
  status?: { type: string },
  pinnedOverride?: boolean,
  preferredTitle?: string,
  permissionProtocol: Record<string, unknown> = storedPermissionProtocol(row),
  settings?: RolloutSettings,
  project?: DesktopProject,
) {
  const permission = permissionStateFromProtocol(permissionProtocol);
  return {
    id: row.id,
    title: displayTitle(row, preferredTitle),
    cwd: row.cwd,
    projectId: project?.id,
    projectName: project?.name,
    projectRootPaths: project?.rootPaths,
    isPinned: pinnedOverride ?? row.is_pinned === 1,
    model: settings?.model ?? row.model ?? undefined,
    reasoningEffort: settings?.reasoningEffort ?? row.reasoning_effort ?? undefined,
    permission: permission.permission,
    permissionProfile: permission.permissionProfile,
    approvalPolicy: permission.approvalPolicy,
    approvalsReviewer: permission.approvalsReviewer,
    sandboxPolicy: permission.sandboxPolicy,
    updatedAt: row.updated_at_ms ?? undefined,
    recencyAt: row.recency_at_ms ?? undefined,
    status,
  };
}

function matchDesktopProject(cwd: string, projects: DesktopProject[]) {
  const normalizedCwd = resolve(cwd);
  let best: { project: DesktopProject; length: number } | undefined;
  for (const project of projects) {
    for (const rootPath of project.rootPaths) {
      const normalizedRoot = resolve(rootPath);
      if (normalizedCwd !== normalizedRoot && !normalizedCwd.startsWith(`${normalizedRoot}${sep}`)) continue;
      if (!best || normalizedRoot.length > best.length) best = { project, length: normalizedRoot.length };
    }
  }
  return best?.project;
}

function displayTitle(
  row: Pick<ThreadRow, "name" | "title" | "preview">,
  preferredTitle?: string,
) {
  const raw = [preferredTitle, row.name, row.title, row.preview]
    .map((value) => value?.trim() ?? "")
    .find((value) => value && !isInjectedContextTitle(value));
  if (!raw) return "新对话";
  const normalized = raw.replace(/\s+/g, " ");
  return normalized.length <= MAX_TITLE_TEXT
    ? normalized
    : `${normalized.slice(0, MAX_TITLE_TEXT)}…`;
}

function isInjectedContextTitle(value: string) {
  const normalized = value.trimStart().toLowerCase();
  return /^#{1,3}\s*agents\.md instructions\b/i.test(value) ||
    normalized.startsWith("## 你的运行上下文(本次执行自动注入)") ||
    normalized.startsWith("the following is externally-sourced assignment context.") ||
    normalized.startsWith("<environment_context>");
}

function parseRollout(raw: string, imageStore: ImageUploadStore) {
  const turns = new Map<string, ParsedTurn>();
  const order: string[] = [];
  let currentTurnId: string | undefined;
  let pendingUserImageIds: string[] = [];
  let unassignedItems: ParsedItem[] = [];
  let unassignedContextTurnId: string | undefined;
  const pendingToolOutputs = new Map<string, PendingToolOutput>();
  let toolOutputOverflow = false;
  const ensureTurn = (id: string, fromItem = false, historicalFragment = false) => {
    let turn = turns.get(id);
    if (!turn) {
      const olderFragment = fromItem && (historicalFragment || currentTurnId !== undefined && currentTurnId !== id);
      turn = { id, status: olderFragment ? "unknown" : "inProgress", items: [],
        ...(olderFragment ? { completeFromTurnStart: false } : {}),
      };
      turns.set(id, turn);
      // A late item attributed to a missing turn is an incomplete historical
      // fragment, not evidence of a new active turn or a reason to block this page.
      if (olderFragment && currentTurnId) order.splice(Math.max(0, order.indexOf(currentTurnId)), 0, id);
      else order.push(id);
    }
    if (historicalFragment && turn.status === "inProgress" && turn.completeFromTurnStart !== true) {
      turn.status = "unknown";
      turn.completeFromTurnStart = false;
    }
    return turn;
  };
  const upsertItem = (turn: ParsedTurn, item: ParsedItem) => {
    const index = turn.items.findIndex((candidate) => candidate.id === item.id);
    if (index < 0) {
      turn.items.push(item);
      return;
    }
    const previous = turn.items[index];
    turn.items[index] = {
      ...previous, ...item,
      type: previous.type === "todoList" && item.type === "toolCall" ? previous.type : item.type,
      text: previous.text.startsWith(item.text) ? previous.text : item.text,
      phase: item.phase ?? previous.phase,
      delegatedInputIsReplay: previous.delegatedInputIsReplay === false ? false
        : item.delegatedInputIsReplay ?? previous.delegatedInputIsReplay,
      status: item.status ?? previous.status,
      ...(item.toolOutput !== undefined ? {
        toolOutputImageIds: item.toolOutputImageIds, toolOutputImagesIncomplete: item.toolOutputImagesIncomplete,
      } : {}),
    };
  };
  const recoverUnassignedItems = (turn: ParsedTurn, explicitTurnId: string | undefined) => {
    if (unassignedItems.length === 0 ||
      (unassignedContextTurnId && unassignedContextTurnId !== explicitTurnId)) return;
    // A bounded prefix predates the items parsed after its context record.
    const items = [...unassignedItems, ...turn.items];
    turn.items = [];
    for (const item of items) upsertItem(turn, item);
    unassignedItems = [];
    unassignedContextTurnId = undefined;
  };

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = asRecord(JSON.parse(line));
    } catch {
      if (currentTurnId) {
        const turn = turns.get(currentTurnId);
        if (turn) turn.completeFromTurnStart = false;
      }
      continue;
    }
    const payload = asRecord(entry.payload);
    if (entry.type === "turn_context") {
      const contextTurnId = stringValue(payload.turn_id);
      if (unassignedItems.length > 0 && contextTurnId) {
        if (unassignedContextTurnId && unassignedContextTurnId !== contextTurnId) unassignedItems = [];
        // Context is only a candidate; a matching completion must confirm it.
        unassignedContextTurnId = unassignedItems.length > 0 ? contextTurnId : undefined;
      }
      currentTurnId = contextTurnId ?? currentTurnId;
      if (currentTurnId) ensureTurn(currentTurnId);
      continue;
    }
    if (entry.type === "event_msg") {
      const eventType = stringValue(payload.type);
      const turnId = stringValue(payload.turn_id) ?? currentTurnId;
      if (eventType === "item_completed" && turnId) {
        // The bounded tail may not contain turn_context/task_started. Desktop
        // completion records carry their own turn and item identities.
        const value = asRecord(payload.item);
        const id = stringValue(value.id);
        const delegated = delegatedInputFromProtocol(value);
        const nativeCommand = id && stringValue(value.type)?.replace(/[_-]/g, "").toLowerCase() === "commandexecution"
          ? { ...value, type: "commandExecution" }
          : undefined;
        // An explicitly attributed replay updates its target, never a different
        // current turn's context. Only a recognized item can recover a prefix.
        if (!currentTurnId && (delegated || (id && messageKind(stringValue(value.type) ?? "") === "agent"))) {
          currentTurnId = turnId;
          recoverUnassignedItems(ensureTurn(turnId), stringValue(payload.turn_id));
        }
        if (delegated) upsertItem(ensureTurn(turnId, true), { ...delegated, delegatedInputIsReplay: true, status: "completed" });
        if (nativeCommand && id) upsertItem(ensureTurn(turnId, true, true), {
          id,
          type: "commandExecution",
          text: truncate(itemText(nativeCommand)),
          status: stringValue(value.status) ?? "completed",
          ...toolDetailsFromProtocol(nativeCommand),
        });
        if (id && messageKind(stringValue(value.type) ?? "") === "agent") {
          const text = itemText(value);
          if (text) {
            const turn = ensureTurn(turnId, true);
            const item: ParsedItem = {
              id, type: "agentMessage", text, phase: stringValue(value.phase), status: "completed",
              localImages: registerAssistantImages(text, imageStore),
            };
            upsertItem(turn, item);
          }
        }
      }
      if (eventType === "user_message") {
        const imageIds = Array.isArray(payload.local_images)
          ? payload.local_images.flatMap((value) => {
              const path = stringValue(value);
              const id = path ? imageStore.referenceForPath(path) : undefined;
              return id ? [id] : [];
            })
          : [];
        const turn = turnId ? turns.get(turnId) : undefined;
        const userItem = turn
          ? [...turn.items].reverse().find((item) => item.type === "userMessage")
          : undefined;
        if (userItem && imageIds.length > 0) {
          userItem.imageIds = [...new Set([...(userItem.imageIds ?? []), ...imageIds])];
          pendingUserImageIds = [];
        } else {
          pendingUserImageIds = imageIds;
        }
      }
      if (eventType === "task_started" && turnId) {
        unassignedItems = [];
        unassignedContextTurnId = undefined;
        currentTurnId = turnId;
        const turn = ensureTurn(turnId);
        turn.status = "inProgress";
        turn.completeFromTurnStart = true;
        turn.startedAt = timestampValue(payload.started_at);
      } else if ((eventType === "task_complete" || eventType === "turn_aborted") && turnId) {
        const turn = ensureTurn(turnId);
        recoverUnassignedItems(turn, stringValue(payload.turn_id));
        const error = eventType === "task_complete" ? rolloutTurnError(payload.error) : undefined;
        turn.status = eventType === "turn_aborted" ? "interrupted"
          : hasRolloutError(payload.error) ? "failed" : "completed";
        if (error) turn.error = error;
        turn.completedAt = timestampValue(payload.completed_at);
        turn.durationMs = numberValue(payload.duration_ms);
      } else if (eventType === "plan_update" && turnId) {
        const plan = rolloutPlan(payload.plan);
        if (plan.length > 0) {
          const turn = ensureTurn(turnId);
          const item: ParsedItem = {
            id: `${turnId}-todo-list`,
            type: "todoList",
            text: "",
            explanation: stringValue(payload.explanation),
            plan,
          };
          const index = turn.items.findIndex((candidate) => candidate.id === item.id);
          if (index >= 0) turn.items[index] = item;
          else turn.items.push(item);
        }
      }
      continue;
    }
    if (entry.type !== "response_item") continue;
    const isToolOutput = payload.type === "function_call_output" || payload.type === "custom_tool_call_output";
    const explicitTurnId = stringValue(asRecord(payload.internal_chat_message_metadata_passthrough).turn_id);
    const item = rolloutItem(payload, imageStore, pendingUserImageIds);
    if (!item) continue;
    if (isToolOutput && item.type !== "delegatedInput") {
      const matches = [...turns.values()].filter((turn) =>
        (!explicitTurnId || turn.id === explicitTurnId) &&
        turn.items.some((call) => call.id === item.id && call.toolInput !== undefined));
      if (matches.length === 1) upsertItem(matches[0], { ...item, toolOutputFromPending: !explicitTurnId || undefined });
      else {
        const key = JSON.stringify([explicitTurnId, item.id]);
        pendingToolOutputs.delete(key);
        pendingToolOutputs.set(key, { id: item.id, turnId: explicitTurnId,
          toolOutput: item.toolOutput, toolOutputTruncated: item.toolOutputTruncated,
          toolOutputLength: item.toolOutputLength, toolOutputImageIds: item.toolOutputImageIds,
          toolOutputImagesIncomplete: item.toolOutputImagesIncomplete });
        if (pendingToolOutputs.size > MAX_PENDING_TOOL_OUTPUTS) {
          pendingToolOutputs.delete(pendingToolOutputs.keys().next().value as string);
          toolOutputOverflow = true;
        }
      }
      continue;
    }
    const itemTurnId = explicitTurnId ?? currentTurnId;
    if (!itemTurnId) { unassignedItems.push(item); continue; }
    currentTurnId ??= itemTurnId;
    if (item.type === "userMessage") pendingUserImageIds = [];
    const turn = ensureTurn(itemTurnId, true);
    upsertItem(turn, item);
  }
  return {
    turns: order.map((id) => turns.get(id) as ParsedTurn)
      .filter((turn) => turn.items.length > 0 || turn.completeFromTurnStart === true),
    hasUnassignedItems: unassignedItems.length > 0,
    pendingToolOutputs: [...pendingToolOutputs.values()],
    toolOutputOverflow,
  };
}

function rolloutPlan(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.slice(0, 100).flatMap((entry) => {
    const record = asRecord(entry);
    const step = stringValue(record.step)?.trim();
    if (!step) return [];
    return [{ step: truncate(step), status: stringValue(record.status) ?? "pending" }];
  });
}

function rolloutItem(
  payload: Record<string, unknown>,
  imageStore: ImageUploadStore,
  pendingUserImageIds: string[] = [],
): ParsedItem | undefined {
  const delegated = delegatedInputFromProtocol(payload);
  if (delegated) return { ...delegated, status: "completed" };
  const id = stringValue(payload.id) ?? stringValue(payload.call_id);
  const type = stringValue(payload.type);
  if (!id || !type) return undefined;
  if (type === "message") {
    const role = stringValue(payload.role);
    if (role !== "user" && role !== "assistant") return undefined;
    const metadata = asRecord(payload.internal_chat_message_metadata_passthrough);
    const contentKinds = Array.isArray(metadata.content_item_kinds)
      ? metadata.content_item_kinds.filter((value): value is string => typeof value === "string")
      : [];
    if (role === "user" && contentKinds.length > 0 && !contentKinds.some((kind) => kind.startsWith("user."))) {
      return undefined;
    }
    const rawText = itemText(payload);
    const text = role === "user" ? displayUserInput(rawText) : rawText;
    const persistedImageIds = role === "user"
      ? [...rawText.matchAll(/<image\b[^>]*\bpath=(?:"([^"]+)"|'([^']+)')[^>]*>/gi)]
          .flatMap((match) => {
            const path = match[1] ?? match[2];
            const id = path ? imageStore.referenceForStoredUploadPath(path) : undefined;
            return id ? [id] : [];
          })
      : [];
    const knownImageIds = [...pendingUserImageIds, ...persistedImageIds];
    const nativeImageIds = role === "user" && knownImageIds.length === 0 && Array.isArray(payload.content)
      ? payload.content.flatMap((value) => {
          const content = asRecord(value);
          if (stringValue(content.type) !== "input_image") return [];
          const imageUrl = stringValue(content.image_url);
          if (!imageUrl || (!imageUrl.startsWith("data:image/") && !imageUrl.startsWith(PROJECTED_IMAGE_URL_PREFIX))) {
            return [];
          }
          return [restoreHistoryImage(imageStore, imageUrl)];
        })
      : [];
    const imageIds = [...new Set([...knownImageIds, ...nativeImageIds])];
    if (!text && (role !== "user" || imageIds.length === 0)) return undefined;
    return {
      id,
      type: role === "user" ? "userMessage" : "agentMessage",
      text,
      ...(role === "assistant" ? { status: "completed", localImages: registerAssistantImages(text, imageStore) } : {}),
      ...(role === "assistant" && stringValue(payload.phase)
        ? { phase: stringValue(payload.phase) }
        : {}),
      ...(role === "user" && imageIds.length > 0
        ? { imageIds }
        : {}),
    };
  }
  if (type === "reasoning") {
    const text = textContent(payload.summary) || textContent(payload.content);
    return text ? { id, type: "reasoning", text, status: "completed" } : undefined;
  }
  if (type === "custom_tool_call" || type === "function_call") {
    const name = stringValue(payload.name) ?? "tool";
    const input = stringValue(payload.input);
    const todoList = name === "exec" && input ? todoListFromExecInput(input) : undefined;
    if (todoList) {
      return {
        id: stringValue(payload.call_id) ?? id,
        type: "todoList",
        text: "",
        explanation: todoList.explanation,
        plan: todoList.plan,
        toolInput: "",
        ...toolDetailsFromProtocol(payload),
      };
    }
    return {
      id: stringValue(payload.call_id) ?? id,
      type: "toolCall",
      text: truncate(input ? `${name}\n${input}` : name),
      status: stringValue(payload.status) ?? "completed",
      toolInput: "",
      ...toolDetailsFromProtocol(payload),
    };
  }
  if (type === "custom_tool_call_output" || type === "function_call_output") {
    const callId = stringValue(payload.call_id);
    if (!callId) return undefined;
    return {
      id: callId,
      type: "toolCall",
      text: "",
      status: "completed",
      ...toolDetailsFromProtocol(registerToolOutputImages(payload, imageStore)),
    };
  }
  return undefined;
}

function todoListFromExecInput(input: string) {
  if (input.length > 1024 * 1024 || !/await\s+tools\.update_plan\s*\(/.test(input)) return undefined;
  const callStart = input.search(/await\s+tools\.update_plan\s*\(/);
  const prefix = input.slice(0, callStart).trim();
  if (prefix && !/^const\s+[A-Za-z_$][\w$]*\s*=\s*$/.test(prefix)) return undefined;
  const source = input.slice(callStart);
  const planStart = /(?:\bplan|"plan")\s*:\s*\[/.exec(source);
  if (!planStart) return undefined;
  const arrayStart = planStart.index + planStart[0].length;
  const arrayEnd = findClosingBracket(source, arrayStart);
  if (arrayEnd < 0) return undefined;
  const plan = [...source.slice(arrayStart, arrayEnd).matchAll(/\{[^{}]*\}/g)].flatMap((match) => {
    const step = quotedField(match[0], "step")?.trim();
    const status = quotedField(match[0], "status");
    return step && status ? [{ step: truncate(step), status }] : [];
  }).slice(0, 100);
  if (plan.length === 0) return undefined;
  const explanation = quotedField(source.slice(0, planStart.index), "explanation");
  return { explanation, plan };
}

function todoListFromRolloutText(raw: string): ParsedTodoList | undefined {
  const lines = raw.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    let entry: Record<string, unknown>;
    try { entry = asRecord(JSON.parse(lines[index])); } catch { continue; }
    const payload = asRecord(entry.payload);
    if (entry.type === "event_msg" && payload.type === "plan_update") {
      const plan = rolloutPlan(payload.plan);
      if (plan.length > 0) {
        return { explanation: stringValue(payload.explanation), plan };
      }
    }
    if (
      entry.type === "response_item" &&
      payload.type === "custom_tool_call" &&
      payload.name === "exec"
    ) {
      const input = stringValue(payload.input);
      const todoList = input ? todoListFromExecInput(input) : undefined;
      if (todoList) return todoList;
    }
  }
  return undefined;
}

function findClosingBracket(source: string, start: number) {
  let inString = false;
  let escaped = false;
  for (let index = start; index < source.length; index += 1) {
    const character = source[index];
    if (inString) {
      if (escaped) escaped = false;
      else if (character === "\\") escaped = true;
      else if (character === '"') inString = false;
      continue;
    }
    if (character === '"') inString = true;
    else if (character === "]") return index;
  }
  return -1;
}

function quotedField(source: string, field: string) {
  const match = new RegExp(`(?:\\b${field}|"${field}")\\s*:\\s*("(?:\\\\.|[^"\\\\])*")`).exec(source);
  if (!match) return undefined;
  try {
    const value = JSON.parse(match[1]);
    return typeof value === "string" ? value : undefined;
  } catch {
    return undefined;
  }
}

function textContent(value: unknown) {
  if (typeof value === "string") return truncate(value);
  if (!Array.isArray(value)) return "";
  return truncate(value.map((part) => {
    if (typeof part === "string") return part;
    const record = asRecord(part);
    return stringValue(record.text) ?? "";
  }).filter(Boolean).join("\n"));
}

function truncate(value: string) {
  return value.length <= MAX_ITEM_TEXT ? value : `${value.slice(0, MAX_ITEM_TEXT)}…`;
}

function permissionFromSandbox(value: string) {
  let type: string | undefined;
  try { type = stringValue(asRecord(JSON.parse(value)).type); } catch { type = value; }
  if (type === "disabled" || type === "danger-full-access") return ":danger-full-access";
  if (type === "read-only" || type === "readOnly") return ":read-only";
  return ":workspace";
}

function storedPermissionProtocol(row: Pick<ThreadRow, "sandbox_policy" | "approval_mode">) {
  return {
    approvalPolicy: row.approval_mode || undefined,
    approvalsReviewer: "user",
    sandboxPolicy: storedSandboxPolicy(row.sandbox_policy),
    activePermissionProfile: { id: permissionFromSandbox(row.sandbox_policy) },
  };
}

function storedSandboxPolicy(value: string) {
  let type: string | undefined;
  try { type = stringValue(asRecord(JSON.parse(value)).type); } catch { type = value; }
  if (type === "disabled" || type === "danger-full-access" || type === "dangerFullAccess") {
    return { type: "dangerFullAccess" };
  }
  if (type === "read-only" || type === "readOnly") return { type: "readOnly" };
  return { type: "workspaceWrite" };
}

function sanitizeApprovalPolicy(value: unknown) {
  if (typeof value === "string") return value;
  const granular = asRecord(asRecord(value).granular);
  if (Object.keys(granular).length === 0) return undefined;
  const allowedKeys = [
    "sandbox_approval",
    "rules",
    "skill_approval",
    "request_permissions",
    "mcp_elicitations",
  ];
  return {
    granular: Object.fromEntries(allowedKeys.flatMap((key) =>
      typeof granular[key] === "boolean" ? [[key, granular[key]]] : []
    )),
  };
}

function timestampValue(value: unknown) {
  if (typeof value === "number") return value;
  if (typeof value !== "string") return undefined;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? undefined : parsed;
}

function asThreadIds(value: unknown) {
  const ids = asRecord(value).threadIds;
  if (!Array.isArray(ids)) return [];
  return ids.filter((id): id is string => typeof id === "string").slice(0, MAX_THREAD_IDS);
}

function questionContextRequest(value: unknown): QuestionContextRequest {
  const request = asRecord(value);
  const threadId = stringValue(request.threadId);
  const turnId = stringValue(request.turnId);
  const anchorItemId = request.anchorItemId === undefined
    ? undefined
    : stringValue(request.anchorItemId);
  const textOffset = request.textOffset;
  if (!threadId || threadId.length > 1024 || !turnId || turnId.length > 1024 ||
    (request.anchorItemId !== undefined && (!anchorItemId || anchorItemId.length > 1024)) ||
    (textOffset !== undefined && (!Number.isSafeInteger(textOffset) || Number(textOffset) < 0))) {
    throw new Error("Question context params are invalid");
  }
  return { threadId, turnId, ...(anchorItemId ? { anchorItemId } : {}),
    ...(textOffset !== undefined ? { textOffset: Number(textOffset) } : {}) };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown) {
  return typeof value === "number" ? value : undefined;
}
