import { closeSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { permissionStateFromProtocol } from "../protocol/permissions";
import { ImageUploadStore } from "./image-upload-store";

const MAX_THREAD_IDS = 100;
const MAX_THREADS = 500;
const DEFAULT_HISTORY_TURNS = 8;
const MAX_HISTORY_TURNS = 8;
const DEFAULT_HISTORY_BYTES = 2 * 1024 * 1024;
const MAX_HISTORY_BYTES = 2 * 1024 * 1024;
const MAX_ITEM_TEXT = 4_000;
const MAX_TITLE_TEXT = 80;
const STATUS_TAIL_BYTES = 512 * 1024;
const MAX_STATUS_APPEND_BYTES = 4 * 1024 * 1024;
const TODO_TAIL_BYTES = 4 * 1024 * 1024;
const MAX_SESSION_INDEX_BYTES = 4 * 1024 * 1024;
const MAX_GLOBAL_STATE_BYTES = 8 * 1024 * 1024;

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

type ParsedItem = {
  id: string;
  type: string;
  text: string;
  status?: string;
  imageIds?: string[];
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
  status: "inProgress" | "completed" | "interrupted" | "failed";
  items: ParsedItem[];
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
    this.imageStore = new ImageUploadStore(
      resolve(dirname(databasePath), "codex-remote", "uploads"),
    );
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
        AND (thread_source IS NULL OR thread_source <> 'subagent')
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
        AND (thread_source IS NULL OR thread_source <> 'subagent')
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
        AND (thread_source IS NULL OR thread_source <> 'subagent')
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
    const id = entry.type === "turn_context"
      ? stringValue(payload.turn_id)
      : entry.type === "event_msg" && stringValue(payload.type) === "task_started"
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
  while (cursor > 0) {
    const rangeStart = Math.max(0, cursor - maxBytes);
    const buffer = readBufferRange(path, rangeStart, cursor - rangeStart);
    let alignedStart = rangeStart;
    let relativeStart = 0;
    if (rangeStart > 0) {
      const newline = buffer.indexOf(10);
      if (newline < 0) {
        cursor = rangeStart;
        continue;
      }
      relativeStart = newline + 1;
      alignedStart += relativeStart;
    }
    const aligned = buffer.subarray(relativeStart);
    const boundaries = turnBoundaries(aligned, alignedStart);
    const selectedBoundary = boundaries.length >= limitTurns
      ? boundaries[boundaries.length - limitTurns]
      : boundaries[0];
    const pageStart = selectedBoundary?.offset ?? alignedStart;
    const pageRelativeStart = Math.max(0, pageStart - rangeStart);
    const turns = parseRollout(buffer.subarray(pageRelativeStart).toString("utf8"), imageStore);
    if (turns.length > 0 || pageStart === 0) return { start: pageStart, turns };
    cursor = pageStart < cursor ? pageStart : rangeStart;
  }
  return { start: 0, turns: [] as ParsedTurn[] };
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
) {
  const active = turns.at(-1)?.status === "inProgress";
  return {
    desktopMirror: true,
    thread: {
      id: row.id,
      name: title,
      cwd: row.cwd,
      projectId: project?.id,
      projectName: project?.name,
      projectRootPaths: project?.rootPaths,
      status: { type: active ? "active" : "idle" },
      section: isPinned ? { id: "desktop-pinned", name: "Pinned" } : null,
      todoList,
      turns,
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
    const type = stringValue(asRecord(entry.payload).type);
    if (type === "task_started") return "active";
    if (type === "task_complete" || type === "turn_aborted") return "idle";
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
  const raw = preferredTitle?.trim() || row.name?.trim() || row.title.trim() || row.preview.trim();
  if (!raw) return "新对话";
  const normalized = raw.replace(/\s+/g, " ");
  return normalized.length <= MAX_TITLE_TEXT
    ? normalized
    : `${normalized.slice(0, MAX_TITLE_TEXT)}…`;
}

function parseRollout(raw: string, imageStore: ImageUploadStore): ParsedTurn[] {
  const turns = new Map<string, ParsedTurn>();
  const order: string[] = [];
  let currentTurnId: string | undefined;
  let pendingUserImageIds: string[] = [];
  const ensureTurn = (id: string) => {
    let turn = turns.get(id);
    if (!turn) {
      turn = { id, status: "inProgress", items: [] };
      turns.set(id, turn);
      order.push(id);
    }
    return turn;
  };

  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    let entry: Record<string, unknown>;
    try {
      entry = asRecord(JSON.parse(line));
    } catch {
      continue;
    }
    const payload = asRecord(entry.payload);
    if (entry.type === "turn_context") {
      currentTurnId = stringValue(payload.turn_id) ?? currentTurnId;
      if (currentTurnId) ensureTurn(currentTurnId);
      continue;
    }
    if (entry.type === "event_msg") {
      const eventType = stringValue(payload.type);
      const turnId = stringValue(payload.turn_id) ?? currentTurnId;
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
        currentTurnId = turnId;
        const turn = ensureTurn(turnId);
        turn.status = "inProgress";
        turn.startedAt = timestampValue(payload.started_at);
      } else if ((eventType === "task_complete" || eventType === "turn_aborted") && turnId) {
        const turn = ensureTurn(turnId);
        turn.status = eventType === "task_complete" ? "completed" : "interrupted";
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
    const itemTurnId = stringValue(asRecord(payload.internal_chat_message_metadata_passthrough).turn_id) ?? currentTurnId;
    if (!itemTurnId) continue;
    const item = rolloutItem(payload, pendingUserImageIds);
    if (!item) continue;
    if (item.type === "userMessage") pendingUserImageIds = [];
    const turn = ensureTurn(itemTurnId);
    const index = turn.items.findIndex((candidate) => candidate.id === item.id);
    if (index >= 0) turn.items[index] = item;
    else turn.items.push(item);
  }
  return order.map((id) => turns.get(id) as ParsedTurn).filter((turn) => turn.items.length > 0);
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
  pendingUserImageIds: string[] = [],
): ParsedItem | undefined {
  const id = stringValue(payload.id) ?? stringValue(payload.call_id);
  const type = stringValue(payload.type);
  if (!id || !type) return undefined;
  if (type === "message") {
    const role = stringValue(payload.role);
    if (role !== "user" && role !== "assistant") return undefined;
    const text = textContent(payload.content);
    if (!text && (role !== "user" || pendingUserImageIds.length === 0)) return undefined;
    return {
      id,
      type: role === "user" ? "userMessage" : "agentMessage",
      text,
      ...(role === "user" && pendingUserImageIds.length > 0
        ? { imageIds: pendingUserImageIds }
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
        id,
        type: "todoList",
        text: "",
        explanation: todoList.explanation,
        plan: todoList.plan,
      };
    }
    return {
      id,
      type: "toolCall",
      text: truncate(input ? `${name}\n${input}` : name),
      status: stringValue(payload.status) ?? "completed",
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

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown) {
  return typeof value === "number" ? value : undefined;
}
