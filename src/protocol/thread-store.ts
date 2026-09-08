import type { RpcMessage } from "./types";
import { permissionStateFromProtocol, type PermissionState } from "./permissions";
import { compatibleUserImages, displayUserInput, sameUserInput, userMessageAliases, userMessageHasIdentity } from "./user-message-identity";
import { appendAssistantText, itemText, localImagesFromProtocol, messageKind, visibleAssistantText } from "./message-content";
import { mergeMessageOrder } from "./message-order";
import { delegatedInputFromProtocol } from "./delegated-input";
import { MAX_PENDING_TOOL_OUTPUTS, boundedToolText, toolDetailsFromProtocol, type ToolDetails, type PendingToolOutput } from "./tool-content";

export type ThreadStatus = "running" | "idle" | "error" | "unknown";
export type TurnStatus = "inProgress" | "completed" | "interrupted" | "failed" | "unknown";
export type TurnError = { message: string; additionalDetails?: string | null };
export type TodoStatus = "pending" | "inProgress" | "completed";

export type CodexTodoList = {
  turnId?: string;
  explanation?: string;
  items: Array<{ step: string; status: TodoStatus }>;
};

export type CodexItem = ToolDetails & {
  toolOutputFromPending?: boolean;
  toolOutputTurnId?: string;
  id: string;
  type: string;
  text: string;
  phase?: string;
  status?: string;
  imageIds?: string[];
  localImages?: Record<string, string>;
  sourceThreadId?: string;
  delegatedInputIsReplay?: boolean;
  clientMessageId?: string;
  itemIdAliases?: string[];
  lifecycle?: "pending" | "queued" | "promoting" | "accepted" | "confirmed" | "failed";
  streamedText?: string;
  visibleText?: string;
  textSource?: "stream" | "visible" | "snapshot" | "completed";
};

export type CodexTurn = {
  id: string;
  status: TurnStatus;
  error?: TurnError;
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
  pendingToolOutputs?: PendingToolOutput[];
  toolOutputOverflow?: boolean;
  toolOutputWarning?: string;
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

  const isMessageSnapshot = message.method === "gateway/agentMessageSnapshot";
  if ((message.method === "item/agentMessage/delta" || isMessageSnapshot) && threadId) {
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
        if (previous.textSource === "completed") return turn;
        const snapshotText = stringValue(params.text) ?? "";
        // Reconnect carries a raw baseline, not a new delta or Desktop innerText.
        // Keep a retained longer raw prefix, but replace DOM/fragment fallbacks.
        const rawText = previous.textSource !== "visible" && previous.text.startsWith(snapshotText)
          ? previous.text : snapshotText;
        const { text, streamedText } = isMessageSnapshot
          ? { text: rawText, streamedText: rawText }
          : appendAssistantText(previous, delta);
        return {
          ...turn,
          status: "inProgress",
          itemOrder: appendUnique(turn.itemOrder, itemId),
          items: {
            ...turn.items,
            [itemId]: {
              ...previous, text, streamedText,
              textSource: !isMessageSnapshot && previous.textSource === "visible" && text !== streamedText ? "visible" : "stream",
              status: "running",
              phase: stringValue(params.phase) ?? previous.phase,
            },
          },
        };
      }, "inProgress", true);
    });
  }

  if (message.method === "desktop/visibleAgentMessage" && threadId) {
    const itemId = stringValue(params.itemId);
    const text = stringValue(params.text);
    if (!itemId || text === undefined) return state;
    const knownThread = state.threads[threadId];
    if (!knownThread) return state;
    const knownTurnId = resolveTurnId(knownThread, params);
    const knownTurn = knownThread.turns[knownTurnId];
    // Desktop DOM contains older, unloaded history and has no ordering evidence.
    // Only an established active turn can receive a new fallback item.
    if (!knownTurn || (!knownTurn.items[itemId] &&
      (knownTurn.status !== "inProgress" || knownThread.activeTurnId !== knownTurnId))) return state;
    return updateThread(state, threadId, (thread) => {
      const turnId = resolveTurnId(thread, params);
      return updateTurn(thread, turnId, (turn) => {
        const previous = turn.items[itemId] ?? {
          id: itemId,
          type: "agentMessage",
          text: "",
        };
        const displayText = visibleAssistantText(previous, text);
        return {
          ...turn,
          itemOrder: appendUnique(turn.itemOrder, itemId),
          items: {
            ...turn.items,
            [itemId]: {
              ...previous,
              type: "agentMessage",
              text: displayText,
              textSource: displayText === previous.text ? previous.textSource ?? "visible" : "visible",
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
      const existing = thread.turns[turnId]?.items[itemId];
      const discardInferredPrefix = message.method === "item/commandExecution/outputDelta" &&
        existing?.toolOutputFromPending === true && !existing.toolOutputTurnId;
      let nextThread = thread;
      if (discardInferredPrefix && existing.toolOutput !== undefined) {
        // A delta proves only its new bytes, not the anonymous prefix guessed
        // from history. Keep that prefix recoverable without mixing it into
        // this turn's authoritative stream.
        const pending = (thread.pendingToolOutputs ?? []).filter((output) => output.id !== itemId || output.turnId);
        pending.push({ id: itemId, toolOutput: existing.toolOutput,
          toolOutputTruncated: existing.toolOutputTruncated, toolOutputLength: existing.toolOutputLength,
          toolOutputImageIds: existing.toolOutputImageIds, toolOutputImagesIncomplete: existing.toolOutputImagesIncomplete });
        const overflow = thread.toolOutputOverflow === true || pending.length > MAX_PENDING_TOOL_OUTPUTS;
        nextThread = { ...thread, pendingToolOutputs: pending.slice(-MAX_PENDING_TOOL_OUTPUTS), toolOutputOverflow: overflow,
          toolOutputWarning: overflow
            ? "部分工具结果超过历史缓存上限；可继续加载较早对话，未恢复的结果请在 Codex Desktop 查看。"
            : "部分工具结果尚未找到对应历史；请继续加载较早对话以恢复。" };
      }
      return updateTurn(nextThread, turnId, (turn) => {
        const previous = turn.items[itemId] ?? {
          id: itemId,
          type: streamedActivity.type,
          text: "",
        };
        const separator = previous.text && streamedActivity.separate ? "\n" : "";
        const output = message.method === "item/commandExecution/outputDelta"
          ? boundedToolText((discardInferredPrefix ? "" : previous.toolOutput ?? "") + streamedActivity.text) : undefined;
        return {
          ...turn,
          status: "inProgress",
          itemOrder: appendUnique(turn.itemOrder, itemId),
          items: {
            ...turn.items,
            [itemId]: {
              ...previous,
              type: streamedActivity.type,
              text: streamedActivity.type === "commandExecution"
                ? boundedToolText(`${previous.text}${separator}${streamedActivity.text}`).text
                : `${previous.text}${separator}${streamedActivity.text}`,
              ...(output ? {
                toolOutput: output.text,
                toolOutputTruncated: (!discardInferredPrefix && previous.toolOutputTruncated) || output.truncated,
                toolOutputLength: (discardInferredPrefix ? 0 : previous.toolOutputLength ?? 0) + streamedActivity.text.length,
                toolOutputFromPending: undefined,
                ...(discardInferredPrefix ? { toolOutputImageIds: undefined, toolOutputImagesIncomplete: undefined } : {}),
              } : {}),
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
        status: thread.activeTurnId && status !== "running" ? "running"
          : status === "idle" && thread.turns[thread.turnOrder.at(-1) ?? ""]?.status === "failed"
            ? "error" : status,
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
    const recovered = (Array.isArray(turnValue.items) ? turnValue.items : []).reduce<CodexState>(
      (current, item) => reduceCodexState(current, {
        method: "item/completed", params: { threadId, turnId, item },
      }), state,
    );
    return updateThread(recovered, threadId, (thread) => {
      const completedTurnId = turnId ?? thread.activeTurnId;
      const next = completedTurnId
        ? updateTurn(thread, completedTurnId, (turn) => ({
            ...turn,
            status: normalizeTurnStatus(turnValue.status, "completed"),
            error: turnErrorFromProtocol(turnValue.error) ?? turn.error,
            itemOrder: mergeMessageOrder(turn.itemOrder,
              (Array.isArray(turnValue.items) ? turnValue.items : []).flatMap((item) => {
                const record = asRecord(item);
                const id = stringValue(record.id);
                if (!id) return [];
                const matches = isUserMessageType(stringValue(record.type))
                  ? Object.values(turn.items).filter(candidate => isUserMessageType(candidate.type) &&
                    userMessageHasIdentity(candidate, id, messageIdentity(record))) : [];
                return [matches.length === 1 ? matches[0].id : id];
              }),
            ),
            completedAt: numberValue(turnValue.completedAt) ?? turn.completedAt,
            durationMs: numberValue(turnValue.durationMs) ?? turn.durationMs,
          }))
        : thread;
      const completesActiveTurn = thread.activeTurnId
        ? completedTurnId === thread.activeTurnId
        : !completedTurnId || completedTurnId === next.turnOrder.at(-1);
      return {
        ...next,
        status: completesActiveTurn
          ? completedTurnId && next.turns[completedTurnId]?.status === "failed" ? "error" : "idle"
          : next.status,
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

  const rawItem = asRecord(params.item);
  const item: Record<string, unknown> = delegatedInputFromProtocol(rawItem) ?? rawItem;
  if ((message.method === "item/started" || message.method === "item/completed") && threadId) {
    const incomingItemId = stringValue(item.id);
    if (!incomingItemId) return state;
    return updateThread(state, threadId, (thread) => {
      const turnId = resolveTurnId(thread, params);
      const clientMessageId = messageIdentity(item);
      const aliasMatches = Object.values(thread.turns[turnId]?.items ?? {}).filter(candidate =>
        isUserMessageType(candidate.type) && userMessageHasIdentity(candidate, incomingItemId, clientMessageId));
      const itemId = isUserMessageType(stringValue(item.type)) && aliasMatches.length === 1
        ? aliasMatches[0].id : incomingItemId;
      const itemType = stringValue(item.type) ?? thread.turns[turnId]?.items[itemId]?.type ?? "item";
      const rawText = itemText(item);
      const text = isUserMessageType(itemType) ? displayUserInput(rawText) : rawText;
      const optimisticMatch = isUserMessageType(itemType)
        ? findMatchingOptimisticUserMessage(thread, text, turnId, itemId, stringArray(item.imageIds), clientMessageId)
        : undefined;
      const confirmedDuplicate = isUserMessageType(itemType) && !optimisticMatch
        ? findConfirmedUserMessage(
          thread,
          itemId,
          clientMessageId,
        )
        : undefined;
      const reconciledMatch = optimisticMatch ?? confirmedDuplicate;
      const reconciledOrder = reconciledMatch?.turnId === turnId
        ? [...new Set(thread.turns[turnId].itemOrder.map((id) =>
          id === reconciledMatch.item.id ? itemId : id
        ))]
        : undefined;
      const withoutOptimistic = reconciledMatch
        ? removeItemFromTurn(thread, reconciledMatch.turnId, reconciledMatch.item.id)
        : thread;
      const baseThread = removeItemFromOtherTurns(withoutOptimistic, turnId, itemId);
      return updateTurn(baseThread, turnId, (turn) => {
        const previous = turn.items[itemId];
        if (message.method === "item/started" && previous?.textSource === "completed") return turn;
        const completed = message.method === "item/completed";
        const resolvedText = completed || messageKind(itemType) !== "agent" ? text || previous?.text || ""
          : previous?.text && !text.startsWith(previous.text) ? previous.text : text || previous?.text || "";
        const nextItems = { ...turn.items };
        const imageIds = [...new Set([
          ...(previous?.imageIds ?? []),
          ...(reconciledMatch?.item.imageIds ?? []),
          ...stringArray(item.imageIds),
        ])];
        const toolDetails = toolDetailsFromProtocol({ ...item, type: itemType });
        nextItems[itemId] = {
          ...previous,
          id: itemId,
          type: itemType,
          text: resolvedText,
          sourceThreadId: stringValue(item.sourceThreadId) ?? previous?.sourceThreadId,
          delegatedInputIsReplay: previous?.delegatedInputIsReplay === false ? false
            : item.type === "delegatedInput" ? true : previous?.delegatedInputIsReplay,
          ...toolDetails,
          ...(toolDetails.toolOutput !== undefined ? { toolOutputImageIds: toolDetails.toolOutputImageIds,
            toolOutputImagesIncomplete: toolDetails.toolOutputImagesIncomplete } : {}),
          toolOutputFromPending: toolDetails.toolOutput !== undefined ? undefined : previous?.toolOutputFromPending,
          localImages: { ...previous?.localImages, ...localImagesFromProtocol(item.localImages) },
          textSource: messageKind(itemType) === "agent" && completed && text ? "completed" : previous?.textSource,
          phase: stringValue(item.phase) ?? previous?.phase,
          clientMessageId: clientMessageId ?? previous?.clientMessageId ?? reconciledMatch?.item.clientMessageId,
          ...(isUserMessageType(itemType) ? { itemIdAliases: userMessageAliases(itemId,
            ...(previous ? [previous] : []),
            ...(reconciledMatch?.turnId === turnId ? [reconciledMatch.item] : []),
            { id: incomingItemId },
          ) } : {}),
          lifecycle: isUserMessageType(itemType) ? "confirmed" : previous?.lifecycle,
          ...(imageIds.length > 0 ? { imageIds } : {}),
          status: message.method === "item/completed"
            ? stringValue(item.status) ?? "completed"
            : stringValue(item.status) ?? "running",
        };
        return {
          ...turn,
          status: message.method === "item/completed" ? turn.status : "inProgress",
          itemOrder: reconciledOrder ?? appendUnique(turn.itemOrder, itemId),
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
  const activeIndex = thread.activeTurnId ? thread.turnOrder.indexOf(thread.activeTurnId) : -1;
  const incomingIndex = thread.turnOrder.indexOf(turnId);
  const canBecomeActive = markRunning && !terminal &&
    (incomingIndex < 0 || activeIndex < 0 || incomingIndex >= activeIndex);
  const updated = update(current);
  if (updated === current) return thread;
  const normalized: CodexTurn = terminal || isTerminalTurnStatus(updated.status)
    ? {
        ...updated,
        status: current.status === "failed" || updated.status === "failed"
          ? "failed" : terminal ? current.status : updated.status,
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
    status: canBecomeActive ? "running" : thread.status,
    activeTurnId: canBecomeActive ? turnId : thread.activeTurnId,
    turnOrder: appendUnique(thread.turnOrder, turnId),
    turns: { ...thread.turns, [turnId]: normalized },
  };
}

function resolveTurnId(thread: CodexThread, params: Record<string, unknown>) {
  const explicit = stringValue(params.turnId);
  if (explicit) return explicit;
  const itemId = stringValue(params.itemId) ?? stringValue(asRecord(params.item).id);
  const knownTurn = itemId ? thread.turnOrder.find((id) => thread.turns[id]?.items[itemId]) : undefined;
  return knownTurn ?? thread.activeTurnId ?? `live-${thread.id}`;
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
  imageIds: string[],
  clientMessageId?: string,
) {
  const candidates: Array<{ turnId: string; item: CodexItem }> = [];
  const confirmed: Array<{ itemId: string; item: CodexItem }> = [];
  for (const turnId of thread.turnOrder) {
    const turn = thread.turns[turnId];
    for (const itemId of turn?.itemOrder ?? []) {
      const candidate = turn.items[itemId];
      if (Boolean(candidate) && isOptimisticMessage(candidate, itemId) &&
        isUserMessageType(candidate?.type)) {
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
    imageIds.length > 0,
  )) return undefined;
  const fallbackCandidates = candidates.filter(({ item }) =>
    !(clientMessageId && item.clientMessageId && clientMessageId !== item.clientMessageId) &&
    sameUserInput(item.text, text, Boolean(item.imageIds?.length), imageIds.length > 0) &&
    compatibleUserImages(item.imageIds, imageIds)
  );
  if (fallbackCandidates.length !== 1) return undefined;
  const fallback = fallbackCandidates[0];
  if (!clientMessageId && !representedById && confirmed.some(({ item }) => sameUserInput(
    item.text,
    text,
    Boolean(item.imageIds?.length),
    imageIds.length > 0,
  ) && compatibleUserImages(item.imageIds, imageIds))) {
    const authoritativeTurnIndex = thread.turnOrder.indexOf(authoritativeTurnId);
    const pendingTurnIndex = thread.turnOrder.indexOf(fallback.turnId);
    if (authoritativeTurnIndex >= 0 && pendingTurnIndex > authoritativeTurnIndex) return undefined;
  }
  return fallback;
}

function findConfirmedUserMessage(
  thread: CodexThread,
  authoritativeId: string,
  clientMessageId?: string,
) {
  if (!clientMessageId) return undefined;
  if (thread.turnOrder.some((turnId) => thread.turns[turnId]?.items[authoritativeId])) return undefined;
  for (const turnId of [...thread.turnOrder].reverse()) {
    const turn = thread.turns[turnId];
    for (const itemId of [...(turn?.itemOrder ?? [])].reverse()) {
      const candidate = turn.items[itemId];
      if (!candidate) continue;
      if (isUserMessageType(candidate.type) && !isOptimisticMessage(candidate, itemId) &&
        candidate.clientMessageId === clientMessageId) return { turnId, item: candidate };
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

function messageIdentity(item: Record<string, unknown>) {
  return stringValue(item.clientMessageId) ??
    stringValue(item.clientUserMessageId) ??
    stringValue(item.client_message_id);
}

export function turnErrorFromProtocol(value: unknown): TurnError | undefined {
  const record = asRecord(value);
  const message = stringValue(record.message);
  if (!message) return undefined;
  return {
    message,
    ...(record.additionalDetails === null || typeof record.additionalDetails === "string"
      ? { additionalDetails: record.additionalDetails } : {}),
  };
}


function isTerminalTurnStatus(status: TurnStatus | undefined) {
  return status === "completed" || status === "interrupted" || status === "failed";
}

function removeItemFromTurn(thread: CodexThread, turnId: string, itemId: string): CodexThread {
  const turn = thread.turns[turnId];
  if (!turn?.items[itemId]) return thread;
  const items = { ...turn.items };
  delete items[itemId];
  const itemOrder = turn.itemOrder.filter((id) => id !== itemId);
  if (turnId.startsWith("web-start-turn-") && itemOrder.length === 0) {
    const turns = { ...thread.turns };
    delete turns[turnId];
    return {
      ...thread,
      activeTurnId: thread.activeTurnId === turnId ? undefined : thread.activeTurnId,
      turnOrder: thread.turnOrder.filter((id) => id !== turnId),
      turns,
    };
  }
  return {
    ...thread,
    turns: {
      ...thread.turns,
      [turnId]: {
        ...turn,
        itemOrder,
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
