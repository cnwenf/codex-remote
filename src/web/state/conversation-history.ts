import { todoItems, turnErrorFromProtocol, type CodexState, type CodexThread, type CodexTurn, type ThreadStatus, type TurnStatus } from "../../protocol/thread-store";
import { compatibleUserImages, sameUserInput } from "../../protocol/user-message-identity";
import { itemText, localImagesFromProtocol, mergeMessageItem, messageKind } from "../../protocol/message-content";
import { MAX_PENDING_TOOL_OUTPUTS, toolDetailsFromProtocol, type PendingToolOutput } from "../../protocol/tool-content";
import { mergeMessageOrder } from "../../protocol/message-order";
import { delegatedInputFromProtocol } from "../../protocol/delegated-input";
import { permissionStateFromProtocol } from "../../protocol/permissions";

// Pure history reconciliation: no sockets, React state, or rendering decisions.
export function hydrateThread(
  state: CodexState,
  value: unknown,
  placement: "snapshot" | "prepend" | "append" = "snapshot",
  closeRetainedTurns = true,
): CodexState {
  const outer = asRecord(value);
  const record = asRecord(outer.thread ?? value);
  const id = stringValue(record.id);
  if (!id) return state;
  const current = state.threads[id] ?? emptyThread(id);
  const hydratedTurns: Record<string, CodexTurn> = { ...current.turns };
  let latestTodoList = current.todoList;
  const recordTodoList = asRecord(record.todoList);
  const recordTodoItems = todoItems(recordTodoList.plan);
  if (recordTodoItems.length > 0) {
    latestTodoList = {
      explanation: stringValue(recordTodoList.explanation),
      items: recordTodoItems,
    };
  }
  const snapshotTurnOrder: string[] = [];
  const snapshotTerminalTurnIds = new Set<string>();
  const snapshotFallbackItemKeys = new Set<string>();
  let snapshotHasInProgressTurn = false;
  const turnValues = Array.isArray(record.turns) ? record.turns : [];
  for (const turnValue of turnValues) {
    const turnRecord = asRecord(turnValue);
    const turnId = stringValue(turnRecord.id);
    if (!turnId) continue;
    snapshotTurnOrder.push(turnId);
    const existing = current.turns[turnId];
    const snapshotStatus = normalizeTurnStatus(turnRecord.status);
    if (snapshotStatus === "inProgress") snapshotHasInProgressTurn = true;
    const snapshotTerminal = isTerminalTurnStatus(snapshotStatus);
    if (snapshotTerminal) snapshotTerminalTurnIds.add(turnId);
    const snapshotItems: CodexTurn["items"] = {};
    const snapshotItemOrder: string[] = [];
    for (const itemValue of Array.isArray(turnRecord.items) ? turnRecord.items : []) {
      const item: Record<string, unknown> = delegatedInputFromProtocol(asRecord(itemValue)) ?? asRecord(itemValue);
      const itemId = stringValue(item.id);
      if (!itemId) continue;
      const itemType = stringValue(item.type) ?? "item";
      if (itemType === "todoList" || itemType === "todo-list") {
        const items = todoItems(item.plan);
        if (items.length > 0) {
          latestTodoList = {
            turnId,
            explanation: stringValue(item.explanation),
            items,
          };
        }
      }
      snapshotItemOrder.push(itemId);
      const snapshotItem: CodexTurn["items"][string] = {
        id: itemId,
        type: itemType,
        text: itemText(item),
        sourceThreadId: stringValue(item.sourceThreadId),
        delegatedInputIsReplay: typeof item.delegatedInputIsReplay === "boolean" ? item.delegatedInputIsReplay : undefined,
        ...toolDetailsFromProtocol(item),
        toolOutputFromPending: item.toolOutputFromPending === true || undefined,
        localImages: localImagesFromProtocol(item.localImages),
        textSource: messageKind(itemType) === "agent"
          ? snapshotTerminal || item.status === "completed" ? "completed" : "snapshot"
          : undefined,
        phase: stringValue(item.phase),
        clientMessageId: stringValue(item.clientMessageId) ??
          stringValue(item.clientUserMessageId) ??
          stringValue(item.client_message_id),
        lifecycle: itemType.toLocaleLowerCase().includes("user") ? "confirmed" : undefined,
        status: stringValue(item.status) ?? (snapshotTerminal ? "completed" : undefined),
        imageIds: stringArray(item.imageIds),
      };
      snapshotItems[itemId] = snapshotItem;
      const previousItem = existing?.items[itemId];
      if (
        placement !== "prepend" &&
        isUserMessage(snapshotItem) &&
        (!previousItem ||
          !sameUserMessage(previousItem, snapshotItem) ||
          previousItem.clientMessageId !== snapshotItem.clientMessageId)
      ) {
        snapshotFallbackItemKeys.add(`${turnId}\0${itemId}`);
      }
    }
    const items = { ...snapshotItems };
    const snapshotTurnIsComplete = turnRecord.completeFromTurnStart === true;
    const reconciledExistingIds = new Set<string>();
    for (const snapshotItemId of snapshotItemOrder) {
      const snapshotItem = snapshotItems[snapshotItemId];
      if (!snapshotItem || existing?.items[snapshotItemId] || !isUserMessage(snapshotItem)) continue;
      const liveItemId = existing?.itemOrder.find((existingItemId) => {
        if (reconciledExistingIds.has(existingItemId) || snapshotItems[existingItemId]) return false;
        const liveItem = existing.items[existingItemId];
        const stableIdentity = Boolean(
          snapshotItem.clientMessageId &&
          liveItem?.clientMessageId === snapshotItem.clientMessageId,
        );
        return Boolean(liveItem) &&
          !isOptimisticUserMessage(existingItemId, liveItem) &&
          (stableIdentity || snapshotTurnIsComplete) &&
          sameUserMessage(snapshotItem, liveItem);
      });
      if (!liveItemId || !existing) continue;
      reconciledExistingIds.add(liveItemId);
      items[snapshotItemId] = {
        ...mergeMessageItem(snapshotItem, existing.items[liveItemId], snapshotTerminal),
        id: snapshotItemId,
        lifecycle: "confirmed",
      };
    }
    const retainedExistingOrder: string[] = [];
    for (const [itemId, existingItem] of Object.entries(existing?.items ?? {})) {
      if (reconciledExistingIds.has(itemId)) continue;
      items[itemId] = mergeMessageItem(snapshotItems[itemId], existingItem, snapshotTerminal);
      retainedExistingOrder.push(itemId);
    }
    const existingTerminal = existing ? isTerminalTurnStatus(existing.status) : false;
    const hydratedTurn: CodexTurn = {
      id: turnId,
      status: existing?.status === "failed" || snapshotStatus === "failed" ? "failed"
        : snapshotStatus === "interrupted" ? "interrupted" : existingTerminal
        ? existing.status
        : snapshotTerminal
        ? snapshotStatus
        : existing?.status === "inProgress"
          ? existing.status
          : snapshotStatus,
      error: turnErrorFromProtocol(turnRecord.error) ?? existing?.error,
      itemOrder: mergeMessageOrder(
        (existing?.itemOrder ?? []).filter((id) => retainedExistingOrder.includes(id) && !(
          placement === "prepend" && existing?.items[id]?.delegatedInputIsReplay === true &&
          snapshotItems[id]?.delegatedInputIsReplay === false
        )),
        snapshotItemOrder,
        placement === "prepend" || snapshotTurnIsComplete,
      ),
      items,
      startedAt: existing?.startedAt ?? numberValue(turnRecord.startedAt),
      completedAt: snapshotTerminal
        ? numberValue(turnRecord.completedAt) ?? existing?.completedAt
        : existing?.completedAt ?? numberValue(turnRecord.completedAt),
      durationMs: snapshotTerminal
        ? numberValue(turnRecord.durationMs) ?? existing?.durationMs
        : existing?.durationMs ?? numberValue(turnRecord.durationMs),
    };
    hydratedTurns[turnId] = snapshotTerminal
      ? completeRetainedItems(hydratedTurn)
      : hydratedTurn;
  }
  const initialTurnOrder = mergeMessageOrder(current.turnOrder, snapshotTurnOrder, placement !== "append");
  const snapshotStatus = normalizeStatus(record.status, current.status);
  if (
    placement !== "prepend" &&
    closeRetainedTurns &&
    outer.desktopMirror === true &&
    snapshotStatus === "idle" &&
    !snapshotHasInProgressTurn
  ) {
    const latestTerminalSnapshotTurnId = [...snapshotTurnOrder].reverse()
      .find((turnId) => snapshotTerminalTurnIds.has(turnId));
    const latestTerminalSnapshotIndex = latestTerminalSnapshotTurnId
      ? initialTurnOrder.indexOf(latestTerminalSnapshotTurnId)
      : -1;
    for (const [index, turnId] of initialTurnOrder.entries()) {
      const turn = hydratedTurns[turnId];
      if (!turn || turn.status !== "inProgress" || index >= latestTerminalSnapshotIndex) continue;
      hydratedTurns[turnId] = completeRetainedTurn(turn);
    }
  }
  const deduplicated = dedupeOptimisticUserMessages(
    hydratedTurns,
    initialTurnOrder,
    snapshotFallbackItemKeys,
  );
  const deduplicatedTurns = deduplicated.turns;
  const toolResults = reconcilePendingToolOutputs(current, record, placement, deduplicatedTurns);
  const turnOrder = deduplicated.turnOrder;
  const activeTurnId = [...turnOrder].reverse().find(
    (turnId) => deduplicatedTurns[turnId]?.status === "inProgress",
  );
  for (const turnId of turnOrder) {
    const turn = deduplicatedTurns[turnId];
    if (!turn || turnId === activeTurnId || turn.status !== "inProgress") continue;
    deduplicatedTurns[turnId] = completeRetainedTurn(turn);
  }
  const reconciledStatus = activeTurnId
    ? "running"
    : deduplicatedTurns[turnOrder.at(-1) ?? ""]?.status === "failed"
      ? "error"
    : snapshotStatus === "error" && snapshotTurnOrder.at(-1) !== turnOrder.at(-1) &&
        isTerminalTurnStatus(deduplicatedTurns[turnOrder.at(-1) ?? ""]?.status)
      ? "idle"
    : current.status === "idle" && snapshotStatus === "running" &&
        snapshotTurnOrder.length > 0 &&
        !snapshotTurnOrder.some((turnId) => deduplicatedTurns[turnId]?.status === "inProgress")
      ? "idle"
      : snapshotStatus;
  const reconciledTodoList = latestTodoList &&
      !latestTodoList.items.every((item) => item.status === "completed") &&
      (!latestTodoList.turnId || !isTerminalTurnStatus(deduplicatedTurns[latestTodoList.turnId]?.status))
    ? latestTodoList
    : undefined;
  return {
    ...state,
    stale: false,
    threadOrder: state.threadOrder.includes(id) ? state.threadOrder : [id, ...state.threadOrder],
    threads: {
      ...state.threads,
      [id]: {
        ...current,
        title: stringValue(record.name) ?? stringValue(record.title) ?? current.title,
        cwd: stringValue(record.cwd) ?? current.cwd,
        projectId: stringValue(record.projectId) ?? stringValue(outer.projectId) ?? current.projectId,
        projectName: stringValue(record.projectName) ?? stringValue(outer.projectName) ?? current.projectName,
        projectRootPaths:
          stringArray(record.projectRootPaths) ?? stringArray(outer.projectRootPaths) ?? current.projectRootPaths,
        status: reconciledStatus,
        turns: deduplicatedTurns,
        ...toolResults,
        turnOrder,
        activeTurnId,
        model: stringValue(outer.model) ?? current.model,
        reasoningEffort:
          stringValue(outer.reasoningEffort) ?? stringValue(outer.effort) ?? current.reasoningEffort,
        ...permissionStateFromProtocol(outer, current),
        sectionId: stringValue(asRecord(record.section).id) ?? current.sectionId,
        sectionName: stringValue(asRecord(record.section).name) ?? current.sectionName,
        desktopMirror: outer.desktopMirror === true,
        todoList: reconciledTodoList,
      },
    },
  };
}

function reconcilePendingToolOutputs(
  current: CodexThread,
  record: Record<string, unknown>,
  placement: "snapshot" | "prepend" | "append",
  turns: Record<string, CodexTurn>,
) {
  const incoming = Array.isArray(record.pendingToolOutputs) ? record.pendingToolOutputs : [];
  const values = placement === "prepend"
    ? [...incoming, ...(current.pendingToolOutputs ?? [])]
    : [...(current.pendingToolOutputs ?? []), ...incoming];
  const retained = new Map<string, PendingToolOutput>();
  let toolOutputOverflow = current.toolOutputOverflow === true || record.toolOutputOverflow === true;
  const retain = (value: unknown) => {
    const output = asRecord(value);
    const id = stringValue(output.id);
    if (!id) return;
    const details = toolDetailsFromProtocol({ ...output, type: "toolCall" });
    if (details.toolOutput === undefined) return;
    const turnId = stringValue(output.turnId);
    const key = JSON.stringify([turnId, id]);
    retained.delete(key);
    retained.set(key, { id, turnId, toolOutput: details.toolOutput,
      toolOutputTruncated: details.toolOutputTruncated, toolOutputLength: details.toolOutputLength,
      toolOutputImageIds: details.toolOutputImageIds, toolOutputImagesIncomplete: details.toolOutputImagesIncomplete });
    if (retained.size > MAX_PENDING_TOOL_OUTPUTS) {
      retained.delete(retained.keys().next().value as string);
      toolOutputOverflow = true;
    }
  };
  for (const value of values) retain(value);
  // Resolved results live only on their items, with a small provenance marker.
  // A later page revealing duplicate ids moves ambiguous results back into the
  // bounded queue, rather than keeping an unbounded second copy of tool output.
  for (const [turnId, turn] of Object.entries(turns)) {
    for (const item of Object.values(turn.items)) {
      if (!item.toolOutputFromPending) continue;
      const matches = Object.values(turns).filter((candidate) =>
        (!item.toolOutputTurnId || candidate.id === item.toolOutputTurnId) &&
        candidate.items[item.id]?.toolInput !== undefined);
      if (matches.length === 1) continue;
      retain({ id: item.id, turnId: item.toolOutputTurnId, toolOutput: item.toolOutput,
        toolOutputTruncated: item.toolOutputTruncated, toolOutputLength: item.toolOutputLength,
        toolOutputImageIds: item.toolOutputImageIds, toolOutputImagesIncomplete: item.toolOutputImagesIncomplete });
      turns[turnId] = { ...turns[turnId], items: { ...turns[turnId].items, [item.id]: {
        ...item, toolOutput: undefined, toolOutputTruncated: undefined,
        toolOutputLength: undefined, toolOutputFromPending: undefined, toolOutputTurnId: undefined,
        toolOutputImageIds: undefined, toolOutputImagesIncomplete: undefined,
      } } };
    }
  }
  let unresolved = 0;
  for (const [key, output] of retained) {
    const matches = Object.values(turns).filter((turn) =>
      (!output.turnId || output.turnId === turn.id) && turn.items[output.id]?.toolInput !== undefined);
    if (matches.length !== 1) { unresolved++; continue; }
    const turn = matches[0];
    const item = turn.items[output.id];
    // An unrelated raw stream cannot certify or consume an anonymous result.
    if (!output.turnId && item.toolOutput !== undefined && !item.toolOutputFromPending &&
      (item.toolOutput !== output.toolOutput || JSON.stringify(item.toolOutputImageIds ?? []) !== JSON.stringify(output.toolOutputImageIds ?? []))) { unresolved++; continue; }
    retained.delete(key);
    if (item.toolOutput !== undefined && !item.toolOutputFromPending) continue;
    turns[turn.id] = { ...turn, items: { ...turn.items, [item.id]: {
      ...item, toolOutput: output.toolOutput, toolOutputTruncated: output.toolOutputTruncated,
      toolOutputLength: output.toolOutputLength, toolOutputFromPending: true, toolOutputTurnId: output.turnId,
      toolOutputImageIds: output.toolOutputImageIds, toolOutputImagesIncomplete: output.toolOutputImagesIncomplete,
    } } };
  }
  return {
    pendingToolOutputs: [...retained.values()],
    toolOutputOverflow,
    toolOutputWarning: toolOutputOverflow
      ? "部分工具结果超过历史缓存上限；可继续加载较早对话，未恢复的结果请在 Codex Desktop 查看。"
      : unresolved > 0 ? "部分工具结果尚未找到对应历史；请继续加载较早对话以恢复。" : undefined,
  };
}

function completeRetainedTurn(turn: CodexTurn): CodexTurn {
  return {
    ...completeRetainedItems(turn),
    status: "completed",
  };
}

function completeRetainedItems(turn: CodexTurn): CodexTurn {
  return {
    ...turn,
    items: Object.fromEntries(Object.entries(turn.items).map(([itemId, item]) => [
      itemId,
      item.status === "running" || item.status === "inProgress"
        ? { ...item, status: "completed" }
        : item,
    ])),
  };
}

export function sameUserMessage(
  left: CodexTurn["items"][string],
  right: CodexTurn["items"][string],
) {
  if (
    left.clientMessageId &&
    right.clientMessageId &&
    left.clientMessageId !== right.clientMessageId
  ) return false;
  if (!isUserMessage(left) || !isUserMessage(right) || !sameUserInput(
    left.text,
    right.text,
    Boolean(left.imageIds?.length),
    Boolean(right.imageIds?.length),
  )) {
    return false;
  }
  return compatibleUserImages(left.imageIds, right.imageIds);
}

function dedupeOptimisticUserMessages(
  turns: Record<string, CodexTurn>,
  turnOrder: string[],
  snapshotFallbackItemKeys: Set<string>,
) {
  let next = turns;
  let nextTurnOrder = turnOrder;
  const authoritative = turnOrder.flatMap((turnId) => {
    const turn = turns[turnId];
    return (turn?.itemOrder ?? []).flatMap((itemId) => {
      const item = turn.items[itemId];
      return item && !isOptimisticUserMessage(itemId, item) && isUserMessage(item)
        ? [{ turnId, itemId, item }]
        : [];
    });
  });
  const optimistic = turnOrder.flatMap((turnId) => {
    const turn = turns[turnId];
    return (turn?.itemOrder ?? []).flatMap((itemId) => {
      const item = turn.items[itemId];
      return item && isOptimisticUserMessage(itemId, item) && isUserMessage(item)
        ? [{ turnId, itemId, item }]
        : [];
    });
  });
  const usedAuthoritative = new Set<string>();
  const matches = new Map<string, (typeof authoritative)[number]>();
  const keyOf = ({ turnId, itemId }: { turnId: string; itemId: string }) => `${turnId}\0${itemId}`;
  for (const candidate of optimistic) {
    if (!candidate.item.clientMessageId) continue;
    const match = authoritative.find((value) =>
      !usedAuthoritative.has(keyOf(value)) &&
      value.item.clientMessageId === candidate.item.clientMessageId &&
      sameUserMessage(value.item, candidate.item)
    );
    if (!match) continue;
    matches.set(keyOf(candidate), match);
    usedAuthoritative.add(keyOf(match));
  }
  for (const candidate of optimistic) {
    if (matches.has(keyOf(candidate))) continue;
    const candidates = authoritative.filter((value) =>
      snapshotFallbackItemKeys.has(keyOf(value)) &&
      !usedAuthoritative.has(keyOf(value)) &&
      sameUserMessage(value.item, candidate.item)
    );
    if (candidates.length !== 1) continue;
    const match = candidates[0];
    // The snapshot must identify one pending send, not merely share its text.
    const pendingMatches = optimistic.filter((value) =>
      !matches.has(keyOf(value)) && sameUserMessage(match.item, value.item)
    );
    if (pendingMatches.length !== 1) continue;
    matches.set(keyOf(candidate), match);
    usedAuthoritative.add(keyOf(match));
  }
  for (const candidate of optimistic) {
    const match = matches.get(keyOf(candidate));
    if (!match) continue;
    const sourceTurn = next[candidate.turnId];
    const sourceItems = { ...sourceTurn.items };
    delete sourceItems[candidate.itemId];
    const sourceItemOrder = sourceTurn.itemOrder.filter((id) => id !== candidate.itemId);
    if (candidate.turnId.startsWith("web-start-turn-") && sourceItemOrder.length === 0) {
      const withoutSource = { ...next };
      delete withoutSource[candidate.turnId];
      next = withoutSource;
      nextTurnOrder = nextTurnOrder.filter((turnId) => turnId !== candidate.turnId);
    } else {
      next = {
        ...next,
        [candidate.turnId]: {
          ...sourceTurn,
          itemOrder: sourceItemOrder,
          items: sourceItems,
        },
      };
    }
    if (candidate.item.imageIds?.length && !match.item.imageIds?.length) {
      const targetTurn = next[match.turnId];
      next = {
        ...next,
        [match.turnId]: {
          ...targetTurn,
          items: {
            ...targetTurn.items,
            [match.itemId]: { ...targetTurn.items[match.itemId], imageIds: candidate.item.imageIds },
          },
        },
      };
    }
  }
  return { turns: next, turnOrder: nextTurnOrder };
}

function isUserMessage(item: CodexTurn["items"][string]) {
  return item.type.toLocaleLowerCase().includes("user");
}


function isTerminalTurnStatus(status: TurnStatus) {
  return status === "completed" || status === "interrupted" || status === "failed";
}

function isOptimisticUserMessage(itemId: string, item: CodexTurn["items"][string]) {
  return itemId.startsWith("web-steer-") ||
    item.lifecycle === "pending" ||
    item.lifecycle === "promoting" ||
    item.lifecycle === "accepted";
}


function emptyThread(id: string): CodexThread {
  return { id, title: "Untitled task", status: "unknown", turnOrder: [], turns: {} };
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : undefined;
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

function normalizeStatus(value: unknown, fallback: ThreadStatus = "unknown"): ThreadStatus {
  const raw = typeof value === "string" ? value : stringValue(asRecord(value).type);
  if (raw === "active" || raw === "running") return "running";
  if (raw === "idle" || raw === "completed" || raw === "notLoaded") return "idle";
  if (raw === "error" || raw === "failed" || raw === "systemError") return "error";
  return fallback;
}

function normalizeTurnStatus(value: unknown): TurnStatus {
  if (
    value === "inProgress" || value === "completed" || value === "interrupted" || value === "failed"
  ) return value;
  return "unknown";
}
