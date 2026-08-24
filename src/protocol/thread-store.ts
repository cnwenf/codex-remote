import type { RpcMessage } from "./types";
import { permissionStateFromProtocol, type PermissionState } from "./permissions";

export type ThreadStatus = "running" | "idle" | "error" | "unknown";
export type TurnStatus = "inProgress" | "completed" | "interrupted" | "failed" | "unknown";
export type TodoStatus = "pending" | "inProgress" | "completed";

export type CodexTodoList = {
  turnId?: string;
  explanation?: string;
  items: Array<{ step: string; status: TodoStatus }>;
};

export type CodexItem = {
  id: string;
  type: string;
  text: string;
  status?: string;
  imageIds?: string[];
};

export type CodexTurn = {
  id: string;
  status: TurnStatus;
  itemOrder: string[];
  items: Record<string, CodexItem>;
  startedAt?: number;
  completedAt?: number;
  durationMs?: number;
};

export type CodexThread = PermissionState & {
  id: string;
  title: string;
  cwd?: string;
  projectId?: string;
  projectName?: string;
  projectRootPaths?: string[];
  updatedAt?: number;
  status: ThreadStatus;
  turnOrder: string[];
  turns: Record<string, CodexTurn>;
  diff?: string;
  activeTurnId?: string;
  model?: string;
  reasoningEffort?: string;
  sectionId?: string;
  sectionName?: string;
  sectionEnteredAt?: number;
  desktopMirror?: boolean;
  todoList?: CodexTodoList;
};

export type CodexState = {
  threadOrder: string[];
  threads: Record<string, CodexThread>;
  stale: boolean;
};

export const initialCodexState: CodexState = {
  threadOrder: [],
  threads: {},
  stale: false,
};

export function reduceCodexState(state: CodexState, message: RpcMessage): CodexState {
  if (!("method" in message)) return state;
  const params = asRecord(message.params);
  const threadId = stringValue(params.threadId);

  if (message.method === "item/agentMessage/delta" && threadId) {
    const itemId = stringValue(params.itemId);
    const delta = stringValue(params.delta) ?? "";
    if (!itemId) return state;
    return updateThread(state, threadId, (thread) => {
      const turnId = resolveTurnId(thread, params);
      return updateTurn(thread, turnId, (turn) => {
        const previous = turn.items[itemId] ?? {
          id: itemId,
          type: "agentMessage",
          text: "",
        };
        return {
          ...turn,
          status: "inProgress",
          itemOrder: appendUnique(turn.itemOrder, itemId),
          items: {
            ...turn.items,
            [itemId]: { ...previous, text: previous.text + delta, status: "running" },
          },
        };
      }, "inProgress", true);
    });
  }

  if (
    (message.method === "item/reasoning/summaryTextDelta" ||
      message.method === "item/reasoning/textDelta") &&
    threadId
  ) {
    const itemId = stringValue(params.itemId);
    const delta = stringValue(params.delta) ?? "";
    if (!itemId) return state;
    return updateThread(state, threadId, (thread) => {
      const turnId = resolveTurnId(thread, params);
      return updateTurn(thread, turnId, (turn) => {
        const previous = turn.items[itemId] ?? { id: itemId, type: "reasoning", text: "" };
        return {
          ...turn,
          status: "inProgress",
          itemOrder: appendUnique(turn.itemOrder, itemId),
          items: {
            ...turn.items,
            [itemId]: { ...previous, text: previous.text + delta, status: "running" },
          },
        };
      }, "inProgress", true);
    });
  }

  const streamedActivity = activityDelta(message.method, params);
  if (streamedActivity && threadId) {
    const itemId = stringValue(params.itemId);
    if (!itemId) return state;
    return updateThread(state, threadId, (thread) => {
      const turnId = resolveTurnId(thread, params);
      return updateTurn(thread, turnId, (turn) => {
        const previous = turn.items[itemId] ?? {
          id: itemId,
          type: streamedActivity.type,
          text: "",
        };
        const separator = previous.text && streamedActivity.separate ? "\n" : "";
        return {
          ...turn,
          status: "inProgress",
          itemOrder: appendUnique(turn.itemOrder, itemId),
          items: {
            ...turn.items,
            [itemId]: {
              ...previous,
              type: streamedActivity.type,
              text: `${previous.text}${separator}${streamedActivity.text}`,
              status: "running",
            },
          },
        };
      }, "inProgress", true);
    });
  }

  if (message.method === "item/fileChange/patchUpdated" && threadId) {
    const itemId = stringValue(params.itemId);
    if (!itemId) return state;
    const changes = Array.isArray(params.changes) ? params.changes : [];
    const text = changes.map((change) => {
      const record = asRecord(change);
      const path = stringValue(record.path) ?? stringValue(record.filePath) ?? "unknown file";
      const kind = stringValue(record.kind) ?? stringValue(record.type) ?? "update";
      return `${kind} ${path}`;
    }).join("\n");
    return updateThread(state, threadId, (thread) => {
      const turnId = resolveTurnId(thread, params);
      return updateTurn(thread, turnId, (turn) => ({
        ...turn,
        status: "inProgress",
        itemOrder: appendUnique(turn.itemOrder, itemId),
        items: {
          ...turn.items,
          [itemId]: {
            ...(turn.items[itemId] ?? { id: itemId, text: "" }),
            type: "fileChange",
            text,
            status: "running",
          },
        },
      }), "inProgress", true);
    });
  }

  if (message.method === "thread/status/changed" && threadId) {
    return updateThread(state, threadId, (thread) => ({
      ...thread,
      status: normalizeStatus(params.status),
    }));
  }

  if (message.method === "thread/name/updated" && threadId) {
    return updateThread(state, threadId, (thread) => ({
      ...thread,
      title: stringValue(params.name) ?? thread.title,
    }));
  }

  if (message.method === "thread/settings/updated" && threadId) {
    const settings = asRecord(params.threadSettings);
    return updateThread(state, threadId, (thread) => ({
      ...thread,
      cwd: stringValue(settings.cwd) ?? thread.cwd,
      model: stringValue(settings.model) ?? thread.model,
      reasoningEffort: stringValue(settings.effort) ?? thread.reasoningEffort,
      ...permissionStateFromProtocol(settings, thread),
    }));
  }

  if (message.method === "turn/started" && threadId) {
    const turnValue = asRecord(params.turn);
    const turnId = stringValue(turnValue.id) ?? stringValue(params.turnId);
    if (!turnId) return state;
    return updateThread(state, threadId, (thread) => ({
      ...updateTurn(thread, turnId, (turn) => ({
        ...turn,
        status: "inProgress",
        startedAt: numberValue(turnValue.startedAt) ?? turn.startedAt,
      }), "inProgress"),
      status: "running",
      activeTurnId: turnId,
    }));
  }

  if (message.method === "turn/completed" && threadId) {
    const turnValue = asRecord(params.turn);
    const turnId = stringValue(turnValue.id) ?? stringValue(params.turnId);
    return updateThread(state, threadId, (thread) => {
      const next = turnId
        ? updateTurn(thread, turnId, (turn) => ({
            ...turn,
            status: normalizeTurnStatus(turnValue.status, "completed"),
            completedAt: numberValue(turnValue.completedAt) ?? turn.completedAt,
            durationMs: numberValue(turnValue.durationMs) ?? turn.durationMs,
          }))
        : thread;
      return { ...next, status: "idle", activeTurnId: undefined };
    });
  }

  if (message.method === "turn/diff/updated" && threadId) {
    return updateThread(state, threadId, (thread) => ({
      ...thread,
      diff: stringValue(params.diff) ?? thread.diff,
    }));
  }

  if (message.method === "turn/plan/updated" && threadId) {
    const items = todoItems(params.plan);
    if (items.length === 0) return state;
    return updateThread(state, threadId, (thread) => ({
      ...thread,
      todoList: {
        turnId: stringValue(params.turnId),
        explanation: stringValue(params.explanation),
        items,
      },
    }));
  }

  const item = asRecord(params.item);
  if ((message.method === "item/started" || message.method === "item/completed") && threadId) {
    const itemId = stringValue(item.id);
    if (!itemId) return state;
    return updateThread(state, threadId, (thread) => {
      const turnId = resolveTurnId(thread, params);
      return updateTurn(thread, turnId, (turn) => {
        const previous = turn.items[itemId];
        const text = itemText(item) || previous?.text || "";
        const itemType = stringValue(item.type) ?? previous?.type ?? "item";
        const optimisticId = itemType === "userMessage"
          ? findMatchingOptimisticUserMessage(turn, text, itemId)
          : undefined;
        const optimistic = optimisticId ? turn.items[optimisticId] : undefined;
        const nextItems = { ...turn.items };
        if (optimisticId) delete nextItems[optimisticId];
        nextItems[itemId] = {
          id: itemId,
          type: itemType,
          text,
          ...(previous?.imageIds || optimistic?.imageIds
            ? { imageIds: previous?.imageIds ?? optimistic?.imageIds }
            : {}),
          status: message.method === "item/completed"
            ? stringValue(item.status) ?? "completed"
            : stringValue(item.status) ?? "running",
        };
        return {
          ...turn,
          status: message.method === "item/completed" ? turn.status : "inProgress",
          itemOrder: replaceOrAppendItemId(turn.itemOrder, optimisticId, itemId),
          items: nextItems,
        };
      }, "inProgress", message.method === "item/started");
    });
  }

  return state;
}

export function markCodexStateStale(state: CodexState): CodexState {
  return { ...state, stale: true };
}

function updateThread(
  state: CodexState,
  id: string,
  update: (thread: CodexThread) => CodexThread,
): CodexState {
  const current = state.threads[id] ?? emptyThread(id);
  return {
    ...state,
    threadOrder: appendUnique(state.threadOrder, id),
    threads: { ...state.threads, [id]: update(current) },
  };
}

function updateTurn(
  thread: CodexThread,
  turnId: string,
  update: (turn: CodexTurn) => CodexTurn,
  initialStatus: TurnStatus = "unknown",
  markRunning = false,
): CodexThread {
  const current = thread.turns[turnId] ?? emptyTurn(turnId, initialStatus);
  return {
    ...thread,
    status: markRunning ? "running" : thread.status,
    activeTurnId: markRunning ? turnId : thread.activeTurnId,
    turnOrder: appendUnique(thread.turnOrder, turnId),
    turns: { ...thread.turns, [turnId]: update(current) },
  };
}

function resolveTurnId(thread: CodexThread, params: Record<string, unknown>) {
  return stringValue(params.turnId) ?? thread.activeTurnId ?? `live-${thread.id}`;
}

function emptyThread(id: string): CodexThread {
  return { id, title: "Untitled task", status: "unknown", turnOrder: [], turns: {} };
}

function emptyTurn(id: string, status: TurnStatus = "unknown"): CodexTurn {
  return { id, status, itemOrder: [], items: {} };
}

function appendUnique(values: string[], value: string) {
  return values.includes(value) ? values : [...values, value];
}

function findMatchingOptimisticUserMessage(
  turn: CodexTurn,
  text: string,
  authoritativeId: string,
) {
  if (turn.items[authoritativeId]) return undefined;
  const expected = normalizeUserMessageText(text);
  return turn.itemOrder.find((id) => {
    const candidate = turn.items[id];
    return id.startsWith("web-steer-") &&
      candidate?.type === "userMessage" &&
      normalizeUserMessageText(candidate.text) === expected;
  });
}

function replaceOrAppendItemId(values: string[], replacedId: string | undefined, value: string) {
  if (!replacedId) return appendUnique(values, value);
  const next = values.filter((id) => id !== value);
  return next.map((id) => id === replacedId ? value : id);
}

function normalizeUserMessageText(value: string) {
  return value.trim().replace(/\s+/g, " ");
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function numberValue(value: unknown) {
  return typeof value === "number" ? value : undefined;
}

export function todoItems(value: unknown) {
  if (!Array.isArray(value)) return [];
  return value.flatMap((entry) => {
    const record = asRecord(entry);
    const step = stringValue(record.step)?.trim();
    if (!step) return [];
    const rawStatus = stringValue(record.status);
    const status: TodoStatus = rawStatus === "completed"
      ? "completed"
      : rawStatus === "inProgress" || rawStatus === "in_progress"
        ? "inProgress"
        : "pending";
    return [{ step, status }];
  });
}

function activityDelta(method: string, params: Record<string, unknown>) {
  if (method === "item/plan/delta") {
    return { type: "plan", text: stringValue(params.delta) ?? "", separate: false };
  }
  if (method === "item/commandExecution/outputDelta") {
    return { type: "commandExecution", text: stringValue(params.delta) ?? "", separate: false };
  }
  if (method === "item/commandExecution/terminalInteraction") {
    return { type: "commandExecution", text: `> ${stringValue(params.stdin) ?? ""}`, separate: false };
  }
  if (method === "item/fileChange/outputDelta") {
    return { type: "fileChange", text: stringValue(params.delta) ?? "", separate: false };
  }
  if (method === "item/mcpToolCall/progress") {
    return { type: "mcpToolCall", text: stringValue(params.message) ?? "", separate: true };
  }
  return undefined;
}

function normalizeStatus(value: unknown): ThreadStatus {
  const raw = typeof value === "string" ? value : stringValue(asRecord(value).type);
  if (raw === "running" || raw === "active") return "running";
  if (raw === "idle" || raw === "completed" || raw === "notLoaded") return "idle";
  if (raw === "error" || raw === "failed" || raw === "systemError") return "error";
  return "unknown";
}

function normalizeTurnStatus(value: unknown, fallback: TurnStatus = "unknown"): TurnStatus {
  if (
    value === "inProgress" || value === "completed" || value === "interrupted" || value === "failed"
  ) return value;
  return fallback;
}

function itemText(item: Record<string, unknown>) {
  const direct = stringValue(item.text) ?? stringValue(item.command) ?? stringValue(item.query);
  if (direct) return direct;
  const content = item.content;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content
      .map((part) => typeof part === "string" ? part : stringValue(asRecord(part).text) ?? "")
      .filter(Boolean)
      .join("\n");
  }
  const summary = item.summary;
  if (Array.isArray(summary)) return summary.filter((part): part is string => typeof part === "string").join("\n");
  if (stringValue(item.tool)) {
    const server = stringValue(item.server);
    return server ? `${server} / ${stringValue(item.tool)}` : stringValue(item.tool) ?? "";
  }
  const changes = item.changes;
  if (Array.isArray(changes)) {
    return changes
      .map((change) => stringValue(asRecord(change).path) ?? stringValue(asRecord(change).filePath) ?? "")
      .filter(Boolean)
      .join("\n");
  }
  return "";
}
