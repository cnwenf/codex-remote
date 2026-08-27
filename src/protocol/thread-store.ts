import type { RpcMessage } from "./types";
import { permissionStateFromProtocol, type PermissionState } from "./permissions";
import { displayUserInput, sameUserInput } from "./user-message-identity";

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
  clientMessageId?: string;
  lifecycle?: "pending" | "queued" | "promoting" | "accepted" | "confirmed" | "failed";
  streamedText?: string;
  visibleText?: string;
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
        const priorStream = previous.streamedText ?? (previous.visibleText === undefined ? previous.text : "");
        const retransmittedFullDelta = delta.length >= 8 &&
          previous.streamedText === delta &&
          previous.text === delta;
        const streamedText = retransmittedFullDelta ? priorStream : `${priorStream}${delta}`;
        const text = reconcileAssistantDelta(previous, streamedText, delta);
        return {
          ...turn,
          status: "inProgress",
          itemOrder: appendUnique(turn.itemOrder, itemId),
          items: {
            ...turn.items,
            [itemId]: { ...previous, text, streamedText, status: "running" },
          },
        };
      }, "inProgress", true);
    });
  }

  if (message.method === "desktop/visibleAgentMessage" && threadId) {
    const itemId = stringValue(params.itemId);
    const text = stringValue(params.text);
    if (!itemId || text === undefined) return state;
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
          itemOrder: appendUnique(turn.itemOrder, itemId),
          items: {
            ...turn.items,
            [itemId]: {
              ...previous,
              type: "agentMessage",
              text: reconcileVisibleAssistantText(previous, text),
              visibleText: text,
              status: previous.status ?? "running",
            },
          },
        };
      });
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
    return updateThread(state, threadId, (thread) => {
      const status = normalizeStatus(params.status);
      return {
        ...thread,
        status: thread.activeTurnId && status !== "running" ? "running" : status,
      };
    });
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
    return updateThread(state, threadId, (thread) => {
      if (isTerminalTurnStatus(thread.turns[turnId]?.status)) return thread;
      return {
        ...updateTurn(thread, turnId, (turn) => ({
          ...turn,
          status: "inProgress",
          startedAt: numberValue(turnValue.startedAt) ?? turn.startedAt,
        }), "inProgress"),
        status: "running",
        activeTurnId: turnId,
      };
    });
  }

  if (message.method === "turn/completed" && threadId) {
    const turnValue = asRecord(params.turn);
    const turnId = stringValue(turnValue.id) ?? stringValue(params.turnId);
    return updateThread(state, threadId, (thread) => {
      const completedTurnId = turnId ?? thread.activeTurnId;
      const next = completedTurnId
        ? updateTurn(thread, completedTurnId, (turn) => ({
            ...turn,
            status: normalizeTurnStatus(turnValue.status, "completed"),
            completedAt: numberValue(turnValue.completedAt) ?? turn.completedAt,
            durationMs: numberValue(turnValue.durationMs) ?? turn.durationMs,
          }))
        : thread;
      const completesActiveTurn = !thread.activeTurnId || completedTurnId === thread.activeTurnId;
      return {
        ...next,
        status: completesActiveTurn ? "idle" : next.status,
        activeTurnId: completesActiveTurn ? undefined : next.activeTurnId,
        todoList: completedTurnId && next.todoList &&
            (!next.todoList.turnId || next.todoList.turnId === completedTurnId)
          ? undefined
          : next.todoList,
      };
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
    return updateThread(state, threadId, (thread) => {
      const todoTurnId = stringValue(params.turnId) ?? thread.activeTurnId;
      const terminal = todoTurnId ? isTerminalTurnStatus(thread.turns[todoTurnId]?.status) : false;
      if (items.length === 0 || items.every((item) => item.status === "completed") || terminal) {
        return { ...thread, todoList: undefined };
      }
      return {
        ...thread,
        todoList: {
          turnId: todoTurnId,
          explanation: stringValue(params.explanation),
          items,
        },
      };
    });
  }

  const item = asRecord(params.item);
  if ((message.method === "item/started" || message.method === "item/completed") && threadId) {
    const itemId = stringValue(item.id);
    if (!itemId) return state;
    return updateThread(state, threadId, (thread) => {
      const turnId = resolveTurnId(thread, params);
      const itemType = stringValue(item.type) ?? thread.turns[turnId]?.items[itemId]?.type ?? "item";
      const rawText = itemText(item);
      const text = isUserMessageType(itemType) ? displayUserInput(rawText) : rawText;
      const clientMessageId = messageIdentity(item);
      const optimisticMatch = isUserMessageType(itemType)
        ? findMatchingOptimisticUserMessage(thread, text, turnId, itemId, clientMessageId)
        : undefined;
      const confirmedDuplicate = isUserMessageType(itemType) && !optimisticMatch
        ? findRecentConfirmedUserMessage(
          thread,
          text,
          itemId,
          stringArray(item.imageIds).length > 0,
          clientMessageId,
        )
        : undefined;
      const reconciledMatch = optimisticMatch ?? confirmedDuplicate;
      const withoutOptimistic = reconciledMatch
        ? removeItemFromTurn(thread, reconciledMatch.turnId, reconciledMatch.item.id)
        : thread;
      const baseThread = removeItemFromOtherTurns(withoutOptimistic, turnId, itemId);
      return updateTurn(baseThread, turnId, (turn) => {
        const previous = turn.items[itemId];
        const resolvedText = text || previous?.text || "";
        const nextItems = { ...turn.items };
        const imageIds = [...new Set([
          ...(previous?.imageIds ?? []),
          ...(reconciledMatch?.item.imageIds ?? []),
          ...stringArray(item.imageIds),
        ])];
        nextItems[itemId] = {
          id: itemId,
          type: itemType,
          text: resolvedText,
          clientMessageId: clientMessageId ?? previous?.clientMessageId ?? reconciledMatch?.item.clientMessageId,
          lifecycle: isUserMessageType(itemType) ? "confirmed" : previous?.lifecycle,
          ...(imageIds.length > 0 ? { imageIds } : {}),
          status: message.method === "item/completed"
            ? stringValue(item.status) ?? "completed"
            : stringValue(item.status) ?? "running",
        };
        return {
          ...turn,
          status: message.method === "item/completed" ? turn.status : "inProgress",
          itemOrder: appendUnique(turn.itemOrder, itemId),
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
  const terminal = isTerminalTurnStatus(current.status);
  const updated = update(current);
  const normalized = terminal || isTerminalTurnStatus(updated.status)
    ? {
        ...updated,
        status: terminal ? current.status : updated.status,
        items: Object.fromEntries(Object.entries(updated.items).map(([itemId, item]) => [
          itemId,
          item.status === "running" || item.status === "inProgress"
            ? { ...item, status: "completed" }
            : item,
        ])),
      }
    : updated;
  return {
    ...thread,
    status: markRunning && !terminal ? "running" : thread.status,
    activeTurnId: markRunning && !terminal ? turnId : thread.activeTurnId,
    turnOrder: appendUnique(thread.turnOrder, turnId),
    turns: { ...thread.turns, [turnId]: normalized },
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
  thread: CodexThread,
  text: string,
  authoritativeTurnId: string,
  authoritativeId: string,
  clientMessageId?: string,
) {
  const candidates: Array<{ turnId: string; item: CodexItem }> = [];
  const confirmed: Array<{ itemId: string; item: CodexItem }> = [];
  for (const turnId of thread.turnOrder) {
    const turn = thread.turns[turnId];
    for (const itemId of turn?.itemOrder ?? []) {
      const candidate = turn.items[itemId];
      if (Boolean(candidate) && isOptimisticMessage(candidate, itemId) &&
        isUserMessageType(candidate?.type) &&
        sameUserInput(
          candidate?.text ?? "",
          text,
          Boolean(candidate?.imageIds?.length),
          /<image\b/i.test(text),
        )) {
        candidates.push({ turnId, item: candidate });
      }
      if (candidate && !isOptimisticMessage(candidate, itemId) && isUserMessageType(candidate.type)) {
        confirmed.push({ itemId, item: candidate });
      }
    }
  }
  const exact = clientMessageId
    ? candidates.find(({ item }) => item.clientMessageId === clientMessageId)
    : undefined;
  if (exact) return exact;
  if (clientMessageId && confirmed.some(({ item }) => item.clientMessageId === clientMessageId)) {
    return undefined;
  }
  const representedById = confirmed.find(({ itemId }) => itemId === authoritativeId);
  if (representedById && sameUserInput(
    representedById.item.text,
    text,
    Boolean(representedById.item.imageIds?.length),
    /<image\b/i.test(text),
  )) return undefined;
  const fallback = candidates[0];
  if (!fallback) return undefined;
  if (!clientMessageId && !representedById && confirmed.some(({ item }) => sameUserInput(
    item.text,
    text,
    Boolean(item.imageIds?.length),
    /<image\b/i.test(text),
  ))) {
    const authoritativeTurnIndex = thread.turnOrder.indexOf(authoritativeTurnId);
    const pendingTurnIndex = thread.turnOrder.indexOf(fallback.turnId);
    if (authoritativeTurnIndex >= 0 && pendingTurnIndex > authoritativeTurnIndex) return undefined;
  }
  return fallback;
}

function findRecentConfirmedUserMessage(
  thread: CodexThread,
  text: string,
  authoritativeId: string,
  incomingHasImages: boolean,
  clientMessageId?: string,
) {
  if (thread.turnOrder.some((turnId) => thread.turns[turnId]?.items[authoritativeId])) return undefined;
  for (const turnId of [...thread.turnOrder].reverse()) {
    const turn = thread.turns[turnId];
    for (const itemId of [...(turn?.itemOrder ?? [])].reverse()) {
      const candidate = turn.items[itemId];
      if (!candidate) continue;
      if (isUserMessageType(candidate.type)) {
        if (!identitiesMatch(candidate, clientMessageId)) return undefined;
        return sameUserInput(
          candidate.text,
          text,
          Boolean(candidate.imageIds?.length),
          incomingHasImages,
        ) ? { turnId, item: candidate } : undefined;
      }
      if (candidate.type.toLocaleLowerCase().includes("agentmessage")) return undefined;
    }
  }
  return undefined;
}

function isOptimisticMessage(item: CodexItem | undefined, itemId: string) {
  return Boolean(item) && (
    itemId.startsWith("web-steer-") ||
    item?.lifecycle === "pending" ||
    item?.lifecycle === "promoting" ||
    item?.lifecycle === "accepted"
  );
}

function identitiesMatch(item: CodexItem | undefined, clientMessageId?: string) {
  if (!clientMessageId) return !item?.clientMessageId;
  return item?.clientMessageId === clientMessageId;
}

function messageIdentity(item: Record<string, unknown>) {
  return stringValue(item.clientMessageId) ??
    stringValue(item.clientUserMessageId) ??
    stringValue(item.client_message_id);
}

function reconcileAssistantDelta(previous: CodexItem, streamedText: string, delta: string) {
  const visibleText = previous.visibleText;
  if (visibleText === undefined) return streamedText;
  const normalizedStream = streamedText.trim();
  if (normalizedStream && visibleText.includes(normalizedStream)) return visibleText;
  if (streamedText.includes(visibleText)) return streamedText;
  const priorStream = previous.streamedText ?? "";
  if (priorStream && visibleText.startsWith(priorStream)) {
    return visibleText.endsWith(delta) ? visibleText : `${visibleText}${delta}`;
  }
  if (visibleText.endsWith(delta)) return visibleText;
  return streamedText.length > visibleText.length ? streamedText : visibleText;
}

function reconcileVisibleAssistantText(previous: CodexItem, visibleText: string) {
  const streamedText = previous.streamedText;
  if (!streamedText) return visibleText;
  if (visibleText.startsWith(streamedText)) return visibleText;
  if (streamedText.startsWith(visibleText)) return streamedText;
  return visibleText.length >= streamedText.length ? visibleText : streamedText;
}

function isTerminalTurnStatus(status: TurnStatus | undefined) {
  return status === "completed" || status === "interrupted" || status === "failed";
}

function removeItemFromTurn(thread: CodexThread, turnId: string, itemId: string): CodexThread {
  const turn = thread.turns[turnId];
  if (!turn?.items[itemId]) return thread;
  const items = { ...turn.items };
  delete items[itemId];
  return {
    ...thread,
    turns: {
      ...thread.turns,
      [turnId]: {
        ...turn,
        itemOrder: turn.itemOrder.filter((id) => id !== itemId),
        items,
      },
    },
  };
}

function removeItemFromOtherTurns(thread: CodexThread, targetTurnId: string, itemId: string) {
  return thread.turnOrder.reduce((next, turnId) => (
    turnId !== targetTurnId && next.turns[turnId]?.items[itemId]
      ? removeItemFromTurn(next, turnId, itemId)
      : next
  ), thread);
}

function isUserMessageType(value: string | undefined) {
  return value?.toLocaleLowerCase().includes("user") === true;
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function stringArray(value: unknown) {
  return Array.isArray(value) ? value.filter((entry): entry is string => typeof entry === "string") : [];
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
