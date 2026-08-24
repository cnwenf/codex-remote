import { closeSync, openSync, readFileSync, readSync, realpathSync, statSync } from "node:fs";
import { dirname, resolve, sep } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { permissionStateFromProtocol } from "../protocol/permissions";

const MAX_THREAD_IDS = 100;
const MAX_THREADS = 500;
const MAX_ROLLOUT_BYTES = 64 * 1024 * 1024;
const DEFAULT_HISTORY_TURNS = 8;
const MAX_HISTORY_TURNS = 8;
const DEFAULT_HISTORY_BYTES = 2 * 1024 * 1024;
const MAX_HISTORY_BYTES = 2 * 1024 * 1024;
const MAX_ITEM_TEXT = 4_000;
const MAX_TITLE_TEXT = 80;
const STATUS_TAIL_BYTES = 512 * 1024;
const MAX_STATUS_APPEND_BYTES = 4 * 1024 * 1024;
const RECENT_ROLLOUT_MS = 10 * 60 * 1_000;

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

type ParsedItem = { id: string; type: string; text: string; status?: string };
type ParsedTurn = {
  id: string;
  status: "inProgress" | "completed" | "interrupted" | "failed";
  items: ParsedItem[];
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
};

export class DesktopState {
  private readonly database: DatabaseSync;
  private readonly allowedRolloutRoot: string;
  private readonly globalStatePath: string;
  private readonly sessionIndexPath: string;
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

  constructor(private readonly databasePath: string) {
    this.database = new DatabaseSync(databasePath, { readOnly: true });
    this.allowedRolloutRoot = resolve(dirname(databasePath), "sessions");
    this.globalStatePath = resolve(dirname(databasePath), ".codex-global-state.json");
    this.sessionIndexPath = resolve(dirname(databasePath), "session_index.jsonl");
  }

  request(method: string, params: unknown) {
    if (method === "desktopState/listThreads") {
      return { data: this.listThreads() };
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
    const byId = new Map(rows.map((row) => [
      row.id,
      metadata(
        row,
        undefined,
        pinned?.has(row.id),
        sessionNames.get(row.id),
        this.readThreadPermissionProtocol(row, atomState),
      ),
    ]));
    return threadIds.flatMap((id) => byId.get(id) ?? []);
  }

  private listThreads() {
    const rows = this.database.prepare(`SELECT id, rollout_path, name, title, preview, cwd,
      is_pinned, model, reasoning_effort, sandbox_policy, approval_mode,
      updated_at_ms, recency_at_ms
      FROM threads
      WHERE archived = 0
        AND (thread_source IS NULL OR thread_source <> 'subagent')
      ORDER BY COALESCE(recency_at_ms, updated_at_ms, created_at_ms) DESC
      LIMIT ?`).all(MAX_THREADS) as ThreadRow[];
    const pinnedThreadIds = this.readPinnedThreadIds();
    const pinned = pinnedThreadIds === undefined ? undefined : new Set(pinnedThreadIds);
    const sessionNames = this.readSessionThreadNames();
    const atomState = this.readDesktopAtomState();
    const orderedRows = pinnedThreadIds === undefined
      ? rows
      : [
          ...pinnedThreadIds.flatMap((id) => rows.find((row) => row.id === id) ?? []),
          ...rows.filter((row) => !pinnedThreadIds.includes(row.id)),
        ];
    return orderedRows.map((row) => metadata(
      row,
      this.rolloutStatus(row.rollout_path),
      pinned?.has(row.id),
      sessionNames.get(row.id),
      this.readThreadPermissionProtocol(row, atomState),
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
    const permissionProtocol = this.readThreadPermissionProtocol(row);
    const permissionKey = JSON.stringify(permissionProtocol);
    if (stat.size > MAX_ROLLOUT_BYTES) throw new Error("Desktop thread history is too large");
    const cached = this.rolloutCache.get(threadId);
    if (
      cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size &&
      cached.isPinned === isPinned && cached.title === title &&
      cached.permissionKey === permissionKey
    ) return cached.value;
    const turns = parseRollout(readFileSync(rolloutPath, "utf8"));
    const value = threadSnapshot(row, turns, isPinned, title, permissionProtocol);
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
    const page = readConversationPage(rolloutPath, before, limitTurns, maxBytes);
    const pinnedThreadIds = this.readPinnedThreadIds();
    const isPinned = pinnedThreadIds === undefined
      ? row.is_pinned === 1
      : pinnedThreadIds.includes(row.id);
    const title = displayTitle(row, this.readSessionThreadNames().get(row.id));
    return {
      ...threadSnapshot(row, page.turns, isPinned, title, this.readThreadPermissionProtocol(row)),
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
      const value = JSON.parse(readFileSync(this.globalStatePath, "utf8")) as unknown;
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
      const value = asRecord(JSON.parse(readFileSync(this.globalStatePath, "utf8")));
      return asRecord(value["electron-persisted-atom-state"]);
    } catch {
      return {};
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

  private readSessionThreadNames() {
    try {
      const stat = statSync(this.sessionIndexPath);
      if (
        this.sessionNamesCache?.mtimeMs === stat.mtimeMs &&
        this.sessionNamesCache.size === stat.size
      ) return this.sessionNamesCache.names;
      const names = new Map<string, string>();
      for (const line of readFileSync(this.sessionIndexPath, "utf8").split("\n")) {
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
      let status = tailStatus;
      if (Date.now() - stat.mtimeMs < RECENT_ROLLOUT_MS) {
        if (status === "unknown") status = statusFromRolloutText(readFileSync(rolloutPath, "utf8"));
      }
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

function readConversationPage(path: string, before: number, limitTurns: number, maxBytes: number) {
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
    const turns = parseRollout(buffer.subarray(pageRelativeStart).toString("utf8"));
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
) {
  const active = turns.at(-1)?.status === "inProgress";
  return {
    desktopMirror: true,
    thread: {
      id: row.id,
      name: title,
      cwd: row.cwd,
      status: { type: active ? "active" : "idle" },
      section: isPinned ? { id: "desktop-pinned", name: "Pinned" } : null,
      turns,
    },
    model: row.model ?? undefined,
    reasoningEffort: row.reasoning_effort ?? undefined,
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
) {
  const permission = permissionStateFromProtocol(permissionProtocol);
  return {
    id: row.id,
    title: displayTitle(row, preferredTitle),
    cwd: row.cwd,
    isPinned: pinnedOverride ?? row.is_pinned === 1,
    model: row.model ?? undefined,
    reasoningEffort: row.reasoning_effort ?? undefined,
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

function parseRollout(raw: string): ParsedTurn[] {
  const turns = new Map<string, ParsedTurn>();
  const order: string[] = [];
  let currentTurnId: string | undefined;
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
      }
      continue;
    }
    if (entry.type !== "response_item") continue;
    const itemTurnId = stringValue(asRecord(payload.internal_chat_message_metadata_passthrough).turn_id) ?? currentTurnId;
    if (!itemTurnId) continue;
    const item = rolloutItem(payload);
    if (!item) continue;
    const turn = ensureTurn(itemTurnId);
    const index = turn.items.findIndex((candidate) => candidate.id === item.id);
    if (index >= 0) turn.items[index] = item;
    else turn.items.push(item);
  }
  return order.map((id) => turns.get(id) as ParsedTurn).filter((turn) => turn.items.length > 0);
}

function rolloutItem(payload: Record<string, unknown>): ParsedItem | undefined {
  const id = stringValue(payload.id) ?? stringValue(payload.call_id);
  const type = stringValue(payload.type);
  if (!id || !type) return undefined;
  if (type === "message") {
    const role = stringValue(payload.role);
    if (role !== "user" && role !== "assistant") return undefined;
    const text = textContent(payload.content);
    if (!text) return undefined;
    return { id, type: role === "user" ? "userMessage" : "agentMessage", text };
  }
  if (type === "reasoning") {
    const text = textContent(payload.summary) || textContent(payload.content);
    return text ? { id, type: "reasoning", text, status: "completed" } : undefined;
  }
  if (type === "custom_tool_call" || type === "function_call") {
    const name = stringValue(payload.name) ?? "tool";
    const input = stringValue(payload.input);
    return {
      id,
      type: "toolCall",
      text: truncate(input ? `${name}\n${input}` : name),
      status: stringValue(payload.status) ?? "completed",
    };
  }
  return undefined;
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
