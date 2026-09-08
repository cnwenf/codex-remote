import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  initialCodexState,
  markCodexStateStale,
  reduceCodexState,
  type CodexState,
  type CodexThread,
  type ThreadStatus,
  type TurnStatus,
} from "../../protocol/thread-store";
import { displayUserInput, sameUserInput } from "../../protocol/user-message-identity";
import { itemText } from "../../protocol/message-content";
import { hydrateThread, sameUserMessage } from "./conversation-history";
import { addHistoryRange, latestHistoryGap, type HistoryRange } from "./history-coverage";
import { isRpcRequest, type RpcRequest } from "../../protocol/types";
import {
  permissionModeOptions,
  permissionRpcParamsForMode,
  permissionRpcParamsFromState,
  permissionStateForMode,
  permissionStateFromProtocol,
  type PermissionModeVisibility,
} from "../../protocol/permissions";
import { CodexSocket, uploadImage, type RemoteApiOptions } from "../api/socket";
import { isQuestionContext, type QuestionContextRequest } from "../../protocol/question-context";

export type ConnectionState = "disconnected" | "connecting" | "reconnecting" | "ready";
export type TransportMode = "desktop-live" | "desktop-cold" | "web-live";

export type ModelOption = {
  id: string;
  displayName: string;
  defaultReasoningEffort: string;
  reasoningEfforts: string[];
};

export type PermissionOption = {
  id: string;
  label: string;
  description?: string;
};

export type QueuedFollowUp = {
  id: string;
  text: string;
  createdAt?: number;
  cwd?: string;
  lifecycle?: "queued" | "promoting" | "failed";
  promotedAt?: number;
};

const QUEUE_PROMOTION_CONFIRMATION_TIMEOUT_MS = 30_000;

export class ConversationReconciler {
  reduceEvent(state: CodexState, message: import("../../protocol/types").RpcMessage) {
    return reduceCodexState(state, message);
  }

  hydrate(
    state: CodexState,
    value: unknown,
    placement: "snapshot" | "prepend" | "append" = "snapshot",
    closeRetainedTurns = true,
  ) {
    return hydrateThread(state, value, placement, closeRetainedTurns);
  }

  stageUserMessage(
    state: CodexState,
    threadId: string,
    turnId: string,
    itemId: string,
    text: string,
    imageIds: string[],
  ) {
    return addOptimisticUserMessage(state, threadId, turnId, itemId, text, imageIds);
  }

  failUserMessage(state: CodexState, threadId: string, turnId: string, itemId: string) {
    return removeOptimisticItem(state, threadId, turnId, itemId);
  }

  reconcileQueueSnapshot(
    current: Record<string, QueuedFollowUp[]>,
    threadId: string,
    messages: QueuedFollowUp[],
    now = Date.now(),
  ) {
    const promoted = (current[threadId] ?? []).flatMap((message) => {
      if (message.lifecycle !== "promoting" || messages.some((queued) => queued.id === message.id)) return [];
      if (
        message.promotedAt !== undefined &&
        now - message.promotedAt > QUEUE_PROMOTION_CONFIRMATION_TIMEOUT_MS
      ) {
        return [{ ...message, lifecycle: "failed" as const }];
      }
      return [message];
    });
    return { ...current, [threadId]: [...messages, ...promoted] };
  }

  confirmQueuedFromSnapshot(
    current: Record<string, QueuedFollowUp[]>,
    value: unknown,
  ) {
    const outer = asRecord(value);
    const thread = asRecord(outer.thread ?? value);
    const threadId = stringValue(thread.id);
    if (!threadId) return current;
    let next = current;
    for (const turnValue of Array.isArray(thread.turns) ? thread.turns : []) {
      const turn = asRecord(turnValue);
      for (const itemValue of Array.isArray(turn.items) ? turn.items : []) {
        const item = asRecord(itemValue);
        const type = stringValue(item.type)?.toLocaleLowerCase() ?? "";
        if (!type.includes("user")) continue;
        next = this.confirmQueuedMessage(next, {
          threadId,
          text: displayUserInput(itemText(item)),
          clientMessageId: stringValue(item.clientMessageId) ??
            stringValue(item.clientUserMessageId) ??
            stringValue(item.client_message_id),
        });
      }
    }
    return next;
  }

  stageQueuePromotion(
    current: Record<string, QueuedFollowUp[]>,
    threadId: string,
    message: QueuedFollowUp,
    now = Date.now(),
  ) {
    return {
      ...current,
      [threadId]: [
        ...(current[threadId] ?? []).filter((item) => item.id !== message.id),
        { ...message, lifecycle: "promoting" as const, promotedAt: now },
      ],
    };
  }

  failQueuePromotion(
    current: Record<string, QueuedFollowUp[]>,
    threadId: string,
    messageId: string,
  ) {
    return {
      ...current,
      [threadId]: (current[threadId] ?? []).map((message) =>
        message.id === messageId ? { ...message, lifecycle: "failed" as const } : message
      ),
    };
  }

  confirmQueuedMessage(
    current: Record<string, QueuedFollowUp[]>,
    confirmed: { threadId: string; text: string; clientMessageId?: string },
  ) {
    const messages = current[confirmed.threadId] ?? [];
    const exactIndex = confirmed.clientMessageId
      ? messages.findIndex((item) => item.id === confirmed.clientMessageId)
      : -1;
    const fallbackMatches = !confirmed.clientMessageId
      ? messages.flatMap((item, index) =>
        item.lifecycle === "promoting" && sameUserInput(item.text, confirmed.text) ? [index] : []
      )
      : [];
    const fallbackIndex = fallbackMatches.length === 1 ? fallbackMatches[0] : -1;
    const matchIndex = exactIndex >= 0 ? exactIndex : fallbackIndex;
    if (matchIndex < 0) return current;
    return {
      ...current,
      [confirmed.threadId]: messages.filter((_, index) => index !== matchIndex),
    };
  }
}

export type CreateThreadOptions = {
  cwd?: string;
  model?: string;
  reasoningEffort?: string;
  permission?: string;
};

export type ThreadHistoryState = {
  beforeCursor?: string;
  hasMoreBefore: boolean;
  loading: boolean;
  gapRecoveryPaused?: boolean;
};

const HISTORY_PAGE = { limitTurns: 8, maxBytes: 2 * 1024 * 1024 } as const;
const THREAD_LIST_REQUEST_TIMEOUT_MS = 5_000;
const emptyThreadHistory: ThreadHistoryState = { hasMoreBefore: false, loading: false };

const emptyCreationOptions = {
  models: [] as ModelOption[],
  permissions: [] as PermissionOption[],
  loading: false,
  error: undefined as string | undefined,
};

export function useCodex(socketOverride?: CodexSocket, remoteApi: RemoteApiOptions = {}) {
  const [socket] = useState(() => socketOverride ?? new CodexSocket());
  const [reconciler] = useState(() => new ConversationReconciler());
  const [state, setState] = useState<CodexState>(initialCodexState);
  const stateRef = useRef(state);
  stateRef.current = state;
  const [connection, setConnection] = useState<ConnectionState>("disconnected");
  const [threadsLoading, setThreadsLoading] = useState(true);
  const [threadsError, setThreadsError] = useState<string>();
  const [defaultCwd, setDefaultCwd] = useState<string>();
  const [selectedThreadId, setSelectedThreadId] = useState<string>();
  const [loadingThreadId, setLoadingThreadId] = useState<string>();
  const [threadLoadError, setThreadLoadError] = useState<{ threadId: string; message: string }>();
  const [threadHistory, setThreadHistory] = useState<Record<string, ThreadHistoryState>>({});
  const [archivedThreads, setArchivedThreads] = useState<CodexThread[]>([]);
  const [archivedThreadsLoading, setArchivedThreadsLoading] = useState(false);
  const [pinnedSectionId, setPinnedSectionId] = useState<string>();
  const [pendingRequests, setPendingRequests] = useState<RpcRequest[]>([]);
  const [queuedByThread, setQueuedByThread] = useState<Record<string, QueuedFollowUp[]>>({});
  const [creationOptions, setCreationOptions] = useState(emptyCreationOptions);
  const [desktopStateAvailable, setDesktopStateAvailable] = useState(false);
  const desktopStateAvailableRef = useRef(false);
  const initialThreadsPending = useRef(true);
  const threadListRequestVersion = useRef(0);
  const threadListSettledVersion = useRef(0);
  const [transportMode, setTransportMode] = useState<TransportMode>();
  const [transportReadOnly, setTransportReadOnly] = useState(false);
  const [error, setError] = useState<string>();
  const desktopControlAvailable = transportMode === "desktop-live" && !transportReadOnly;
  const catalogRequestVersion = useRef(0);
  const selectionRequestVersion = useRef(0);
  const liveRevisions = useRef(new Map<string, number>());
  const historyLoads = useRef(new Set<string>());
  const historyCoverage = useRef(new Map<string, HistoryRange[]>());
  const automaticGapPages = useRef(new Map<string, number>());
  const desktopHistoryThreads = useRef(new Set<string>());
  const optimisticItemSequence = useRef(0);
  const turnStartedWaiters = useRef(new Map<string, Set<() => void>>());

  const reconcileSnapshot = useCallback((
    value: unknown,
    placement: "snapshot" | "prepend" | "append" = "snapshot",
    requestedRevision?: number,
  ) => {
    const threadId = stringValue(asRecord(asRecord(value).thread ?? value).id);
    if (threadId) {
      const ranges = addHistoryRange(historyCoverage.current.get(threadId) ?? [], value);
      historyCoverage.current.set(threadId, ranges);
      if (!latestHistoryGap(ranges)) automaticGapPages.current.delete(threadId);
    }
    setState((current) => reconciler.hydrate(current, value, placement,
      requestedRevision === undefined || requestedRevision === (liveRevisions.current.get(threadId ?? "") ?? 0),
    ));
    setQueuedByThread((current) => reconciler.confirmQueuedFromSnapshot(current, value));
  }, [reconciler]);

  useEffect(() => {
    const unsubscribeRpc = socket.subscribe((message) => {
      if ("method" in message) {
        const id = stringValue(asRecord(message.params).threadId);
        if (id) liveRevisions.current.set(id, (liveRevisions.current.get(id) ?? 0) + 1);
      }
      if (isRpcRequest(message)) {
        setPendingRequests((current) => [...current, message]);
        return;
      }
      if ("method" in message && message.method === "turn/started") {
        const startedThreadId = stringValue(asRecord(message.params).threadId);
        if (startedThreadId) {
          const waiters = turnStartedWaiters.current.get(startedThreadId);
          turnStartedWaiters.current.delete(startedThreadId);
          for (const resolve of waiters ?? []) resolve();
        }
      }
      const confirmed = confirmedUserMessage(message);
      if (confirmed) {
        setQueuedByThread((current) => reconciler.confirmQueuedMessage(current, confirmed));
      }
      setState((current) => reconciler.reduceEvent(current, message));
    });
    const unsubscribeSession = socket.subscribeSession((envelope) => {
      if (envelope.type !== "session") return;
      if (envelope.state === "ready") {
        setConnection("ready");
        setState((current) => ({ ...current, stale: false }));
        if (envelope.defaultCwd) setDefaultCwd(envelope.defaultCwd);
        if (envelope.transport) setTransportMode(envelope.transport);
        setTransportReadOnly(envelope.readOnly === true);
      }
      if (envelope.state === "reconnecting") {
        setConnection("reconnecting");
        setState(markCodexStateStale);
      }
      if (envelope.state === "disconnected") {
        setConnection("disconnected");
        setState(markCodexStateStale);
        if (envelope.message) setError(envelope.message);
      }
    });
    return () => {
      unsubscribeRpc();
      unsubscribeSession();
    };
  }, [reconciler, socket]);

  const connect = useCallback(
    async (token: string, url?: string, reuseTokenOnReconnect = false) => {
      setConnection("connecting");
      setError(undefined);
      try {
        await socket.connect(token, url, reuseTokenOnReconnect);
        setConnection("ready");
      } catch (cause) {
        setConnection("disconnected");
        setError(cause instanceof Error ? cause.message : "Connection failed");
        throw cause;
      }
    },
    [socket],
  );

  const disconnect = useCallback(() => {
    socket.disconnect();
    setConnection("disconnected");
    setState(markCodexStateStale);
  }, [socket]);

  const refreshThreads = useCallback(async () => {
    const version = ++threadListRequestVersion.current;
    const requestedRevisions = new Map(liveRevisions.current);
    const liveList = boundedRequest(socket.request("thread/list", {
      limit: 100,
      sortKey: "updated_at",
    }), THREAD_LIST_REQUEST_TIMEOUT_MS).catch(() => undefined);
    const desktopListRequest = boundedRequest(
      socket.request("desktopState/listThreads", {}),
      THREAD_LIST_REQUEST_TIMEOUT_MS,
    ).then((desktopList) => {
      desktopStateAvailableRef.current = true;
      setDesktopStateAvailable(true);
      return desktopList;
    }).catch(() => {
      if (!desktopStateAvailableRef.current) setDesktopStateAvailable(false);
      return undefined;
    });
    const [result, desktopList] = await Promise.all([liveList, desktopListRequest]);
    if (version <= threadListSettledVersion.current) return;
    if (result === undefined && desktopList === undefined) {
      threadListSettledVersion.current = version;
      const message = "读取对话列表失败";
      if (initialThreadsPending.current) {
        setThreadsError(message);
        initialThreadsPending.current = false;
        setThreadsLoading(false);
      }
      throw new Error(message);
    }
    const merged = mergeDesktopThreadList(result ?? { data: [] }, desktopList);
    const data = asRecord(merged).data;
    // A list has no turn identity. Resolve conflicts using one metadata-only
    // turn, not conversation contents or timestamps from unrelated clocks.
    const activities = await Promise.all((Array.isArray(data) ? data : []).map(async (value) => {
      const record = asRecord(value);
      const id = stringValue(record.id);
      const known = id ? stateRef.current.threads[id] : undefined;
      const status = normalizeStatus(record.status);
      if (!id || !known?.turnOrder.length || status === "unknown" || status === known.status) return undefined;
      try {
        const response = asRecord(await socket.request("thread/turns/list", {
          threadId: id, limit: 1, sortDirection: "desc", itemsView: "notLoaded",
        }, { timeoutMs: THREAD_LIST_REQUEST_TIMEOUT_MS }));
        const turn = asRecord(Array.isArray(response.data) ? response.data[0] : undefined);
        if (!stringValue(turn.id) || (turn.status !== "inProgress" && !isTerminalTurnStatus(turn.status as TurnStatus))) return undefined;
        return { id, turnsAtRead: known.turns, turn: { id: turn.id, status: turn.status, error: turn.error, items: [] } };
      } catch {
        // Offline/older bridges keep the event-derived state and retry next poll.
        return undefined;
      }
    }));
    if (version <= threadListSettledVersion.current) return;
    threadListSettledVersion.current = version;
    setState((current) => {
      let next = replaceThreadList(current, merged, desktopList);
      for (const activity of activities) {
        if (!activity || requestedRevisions.get(activity.id) !== liveRevisions.current.get(activity.id) ||
          current.threads[activity.id]?.turns !== activity.turnsAtRead) continue;
        next = reconciler.hydrate(next, {
          desktopMirror: current.threads[activity.id]?.desktopMirror,
          latestTurnMetadata: true,
          thread: { id: activity.id, turns: [activity.turn], status: activity.turn.status === "inProgress"
            ? "active" : activity.turn.status === "failed" ? "error" : "idle" },
        }, "append");
      }
      return next;
    });
    setThreadsError(undefined);
    if (initialThreadsPending.current) {
      initialThreadsPending.current = false;
      setThreadsLoading(false);
    }
  }, [reconciler, socket]);

  const refreshArchivedThreads = useCallback(async () => {
    setArchivedThreadsLoading(true);
    try {
      let result: unknown;
      try {
        result = await socket.request("thread/list", {
          archived: true,
          limit: 100,
          sortKey: "updated_at",
        });
      } catch {
        // Desktop SQLite can still provide archived metadata while the bridge reconnects.
      }
      let desktopList: unknown;
      try {
        desktopList = await socket.request("desktopState/listThreads", { archived: true });
        desktopStateAvailableRef.current = true;
        setDesktopStateAvailable(true);
      } catch {
        // Older gateways do not expose archived Desktop metadata.
      }
      if (result === undefined && desktopList === undefined) {
        throw new Error("读取归档对话失败");
      }
      const normalized = replaceThreadList(
        initialCodexState,
        mergeDesktopThreadList(result ?? { data: [] }, desktopList),
        desktopList,
      );
      setArchivedThreads(normalized.threadOrder.map((id) => normalized.threads[id]).filter(Boolean));
    } finally {
      setArchivedThreadsLoading(false);
    }
  }, [socket]);

  useEffect(() => {
    const unsubscribe = socket.subscribe((message) => {
      if ("method" in message && message.method === "desktop/pins/updated") {
        void refreshThreads().catch(() => undefined);
      }
    });
    return () => { unsubscribe(); };
  }, [refreshThreads, socket]);

  useEffect(() => {
    if (connection !== "ready") return;
    let refreshing = false;
    const timer = window.setInterval(() => {
      if (refreshing) return;
      refreshing = true;
      void refreshThreads().catch(() => undefined).finally(() => { refreshing = false; });
    }, 5_000);
    return () => window.clearInterval(timer);
  }, [connection, refreshThreads]);

  const refreshThreadSections = useCallback(async () => {
    const result = await socket.request("threadSection/list", { limit: 100 });
    const data = asRecord(result).data;
    const pinned = Array.isArray(data)
      ? data.map(asRecord).find((section) => stringValue(section.name)?.toLocaleLowerCase() === "pinned")
      : undefined;
    setPinnedSectionId(stringValue(pinned?.id));
  }, [socket]);

  const togglePin = useCallback(async (threadId: string) => {
    const thread = state.threads[threadId];
    const currentlyPinned = thread?.sectionName?.toLocaleLowerCase() === "pinned";
    if (desktopControlAvailable) {
      const firstPinnedThreadId = state.threadOrder.find((id) =>
        state.threads[id]?.sectionName?.toLocaleLowerCase() === "pinned"
      );
      await socket.request("desktop/setThreadPinned", {
        threadId,
        pinned: !currentlyPinned,
        ...(!currentlyPinned && firstPinnedThreadId
          ? { beforeThreadId: firstPinnedThreadId }
          : {}),
      });
      await refreshThreads();
      return;
    }
    let destinationId: string | null = null;
    if (!currentlyPinned) {
      destinationId = pinnedSectionId ?? null;
      if (!destinationId) {
        const result = await socket.request("threadSection/create", { name: "Pinned" });
        const section = asRecord(asRecord(result).section);
        destinationId = stringValue(section.id) ?? null;
        if (!destinationId) throw new Error("创建置顶分区失败");
        setPinnedSectionId(destinationId);
      }
    }
    await socket.request("thread/section/move", { threadId, sectionId: destinationId });
    await refreshThreads();
  }, [desktopControlAvailable, pinnedSectionId, refreshThreads, socket, state.threadOrder, state.threads]);

  const clearSelection = useCallback(() => {
    selectionRequestVersion.current += 1;
    setSelectedThreadId(undefined);
  }, []);

  const archiveThread = useCallback(async (threadId: string) => {
    const archivedThread = state.threads[threadId];
    await socket.request("thread/archive", { threadId });
    if (archivedThread) {
      setArchivedThreads((current) => [
        { ...archivedThread, sectionId: undefined, sectionName: undefined },
        ...current.filter((thread) => thread.id !== threadId),
      ]);
    }
    if (selectedThreadId === threadId) {
      clearSelection();
      setThreadLoadError(undefined);
    }
    await refreshThreads();
  }, [clearSelection, refreshThreads, selectedThreadId, socket, state.threads]);

  const renameThread = useCallback(async (threadId: string, name: string) => {
    const normalizedName = name.trim();
    if (!normalizedName) throw new Error("标题不能为空");
    await socket.request("thread/name/set", { threadId, name: normalizedName });
    setState((current) => updateThreadTitle(current, threadId, normalizedName));
    setArchivedThreads((current) => current.map((thread) =>
      thread.id === threadId ? { ...thread, title: normalizedName } : thread
    ));
  }, [socket]);

  const unarchiveThread = useCallback(async (threadId: string) => {
    await socket.request("thread/unarchive", { threadId });
    let restored: CodexThread | undefined;
    setArchivedThreads((current) => {
      restored = current.find((thread) => thread.id === threadId);
      return current.filter((thread) => thread.id !== threadId);
    });
    if (restored) setState((current) => restoreThread(current, restored as CodexThread));
  }, [socket]);

  const deleteThread = useCallback(async (threadId: string) => {
    await socket.request("thread/delete", { threadId });
    setState((current) => removeThread(current, threadId));
    setArchivedThreads((current) => current.filter((thread) => thread.id !== threadId));
    if (selectedThreadId === threadId) {
      clearSelection();
      setThreadLoadError(undefined);
    }
  }, [clearSelection, selectedThreadId, socket]);

  const refreshCreationOptions = useCallback(async (cwd?: string) => {
    const version = ++catalogRequestVersion.current;
    setCreationOptions((current) => ({ ...current, loading: true, error: undefined }));
    try {
      const [modelsValue, permissionsValue, visibilityValue] = await Promise.all([
        socket.request("model/list", { limit: 100 }),
        socket.request("permissionProfile/list", { limit: 100, ...(cwd ? { cwd } : {}) }),
        socket.request("desktopState/readPermissionModeVisibility", {}).catch(() => undefined),
      ]);
      if (version !== catalogRequestVersion.current) return;
      setCreationOptions({
        models: normalizeModels(modelsValue),
        permissions: normalizePermissions(permissionsValue, visibilityValue),
        loading: false,
        error: undefined,
      });
    } catch (cause) {
      if (version !== catalogRequestVersion.current) return;
      setCreationOptions((current) => ({
        ...current,
        permissions: [],
        loading: false,
        error: cause instanceof Error ? cause.message : "读取模型和权限失败",
      }));
    }
  }, [socket]);

  const selectThread = useCallback(
    async (threadId: string) => {
      const version = ++selectionRequestVersion.current;
      const requestedRevision = liveRevisions.current.get(threadId) ?? 0;
      const preserveDesktopHistory = desktopHistoryThreads.current.has(threadId);
      let desktopMirrorLoaded = false;
      setSelectedThreadId(threadId);
      setLoadingThreadId(threadId);
      setThreadLoadError(undefined);
      try {
        if (desktopStateAvailableRef.current || desktopStateAvailable) {
          let mirror: unknown;
          try {
            mirror = await socket.request("desktopState/readThread", {
              threadId,
              history: HISTORY_PAGE,
            });
          } catch {
            // A Web-owned task might not exist in Desktop's SQLite yet.
          }
          if (mirror !== undefined) {
            if (version === selectionRequestVersion.current) {
              reconcileSnapshot(mirror, preserveDesktopHistory ? "append" : "snapshot", requestedRevision);
              setThreadHistory((current) => ({
                ...current,
                [threadId]: preserveDesktopHistory
                  ? current[threadId] ?? historyState(mirror)
                  : historyState(mirror),
              }));
              desktopHistoryThreads.current.add(threadId);
            }
            desktopMirrorLoaded = true;
            if (desktopControlAvailable) {
              await socket.request("thread/resume", { threadId, excludeTurns: true });
            }
            return;
          }
        }
        const result = await socket.request("thread/resume", { threadId });
        if (version === selectionRequestVersion.current) {
          reconcileSnapshot(result, "snapshot", requestedRevision);
          setThreadHistory((current) => ({ ...current, [threadId]: emptyThreadHistory }));
          desktopHistoryThreads.current.delete(threadId);
        }
      } catch (cause) {
        if (desktopMirrorLoaded) {
          if (version === selectionRequestVersion.current) {
            setThreadLoadError({
              threadId,
              message: cause instanceof Error ? cause.message : "恢复对话失败",
            });
          }
          throw cause;
        }
        try {
          const mirror = await socket.request("desktopState/readThread", {
            threadId,
            history: HISTORY_PAGE,
          });
          if (version === selectionRequestVersion.current) {
            reconcileSnapshot(mirror, preserveDesktopHistory ? "append" : "snapshot", requestedRevision);
            setThreadHistory((current) => ({
              ...current,
              [threadId]: preserveDesktopHistory
                ? current[threadId] ?? historyState(mirror)
                : historyState(mirror),
            }));
            desktopHistoryThreads.current.add(threadId);
          }
        } catch {
          if (version === selectionRequestVersion.current) {
            setThreadLoadError({
              threadId,
              message: cause instanceof Error ? cause.message : "加载对话失败",
            });
          }
          throw cause;
        }
      } finally {
        if (version === selectionRequestVersion.current) setLoadingThreadId(undefined);
      }
    },
    [desktopControlAvailable, desktopStateAvailable, reconcileSnapshot, socket],
  );

  const recoverHistoryGap = useCallback(async (threadId: string, automatic = true) => {
    const gap = latestHistoryGap(historyCoverage.current.get(threadId) ?? []);
    if (!gap || historyLoads.current.has(threadId)) return;
    const pages = automaticGapPages.current.get(threadId) ?? 0;
    // ponytail: auto-fill at most eight bounded pages; larger offline gaps
    // remain available through the existing load-earlier action.
    if (automatic && pages >= 8) return;
    if (automatic) automaticGapPages.current.set(threadId, pages + 1);
    historyLoads.current.add(threadId);
    setThreadHistory((current) => ({
      ...current, [threadId]: { ...(current[threadId] ?? emptyThreadHistory), loading: true },
    }));
    const selection = selectionRequestVersion.current;
    try {
      const value = asRecord(await socket.request("desktopState/readThread", {
        threadId, history: { ...HISTORY_PAGE, beforeCursor: gap.beforeCursor },
      }, { timeoutMs: THREAD_LIST_REQUEST_TIMEOUT_MS }));
      if (selection === selectionRequestVersion.current) {
        reconcileSnapshot({ ...value, historyAnchor: gap.anchor, historyAfterAnchor: gap.afterAnchor }, "prepend");
      }
    } finally {
      historyLoads.current.delete(threadId);
      setThreadHistory((current) => ({
        ...current, [threadId]: { ...(current[threadId] ?? emptyThreadHistory), loading: false },
      }));
    }
  }, [reconcileSnapshot, socket]);

  const loadEarlierThreadHistory = useCallback(async (automatic = false) => {
    if (!selectedThreadId || historyLoads.current.has(selectedThreadId)) return;
    if (latestHistoryGap(historyCoverage.current.get(selectedThreadId) ?? [])) {
      await recoverHistoryGap(selectedThreadId, automatic);
      return;
    }
    const currentHistory = threadHistory[selectedThreadId];
    if (!currentHistory?.hasMoreBefore || !currentHistory.beforeCursor) return;
    historyLoads.current.add(selectedThreadId);
    setThreadHistory((current) => ({
      ...current,
      [selectedThreadId]: { ...current[selectedThreadId], loading: true },
    }));
    try {
      const value = await socket.request("desktopState/readThread", {
        threadId: selectedThreadId,
        history: { ...HISTORY_PAGE, beforeCursor: currentHistory.beforeCursor },
      });
      reconcileSnapshot(value, "prepend");
      setThreadHistory((current) => ({
        ...current,
        [selectedThreadId]: historyState(value),
      }));
    } finally {
      historyLoads.current.delete(selectedThreadId);
      setThreadHistory((current) => ({
        ...current,
        [selectedThreadId]: { ...(current[selectedThreadId] ?? emptyThreadHistory), loading: false },
      }));
    }
  }, [reconcileSnapshot, recoverHistoryGap, selectedThreadId, socket, threadHistory]);

  const selectedDesktopMirror = selectedThreadId
    ? state.threads[selectedThreadId]?.desktopMirror === true
    : false;
  useEffect(() => {
    if (
      connection !== "ready" || !selectedThreadId || loadingThreadId === selectedThreadId ||
      (!selectedDesktopMirror && !desktopStateAvailable)
    ) return;
    let cancelled = false;
    let pending = false;
    const timer = window.setInterval(() => {
      if (pending) return;
      pending = true;
      const selection = selectionRequestVersion.current;
      const requestedRevision = liveRevisions.current.get(selectedThreadId) ?? 0;
      // A native resume may contain only live items after a transient mirror
      // failure. Establish bounded history and its cursor before tail polling.
      const bootstrapHistory = !desktopHistoryThreads.current.has(selectedThreadId);
      void socket.request("desktopState/readThread", {
        threadId: selectedThreadId,
        history: bootstrapHistory ? HISTORY_PAGE : { ...HISTORY_PAGE, limitTurns: 1 },
      })
        .then(async (value) => {
          if (!cancelled && selection === selectionRequestVersion.current) {
            reconcileSnapshot(value, bootstrapHistory ? "snapshot" : "append", requestedRevision);
            if (bootstrapHistory) {
              desktopHistoryThreads.current.add(selectedThreadId);
              setThreadHistory((current) => ({ ...current, [selectedThreadId]: historyState(value) }));
            }
            await recoverHistoryGap(selectedThreadId);
          }
        })
        .catch(() => undefined)
        .finally(() => { pending = false; });
    }, 2_000);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [connection, desktopStateAvailable, loadingThreadId, reconcileSnapshot, recoverHistoryGap, selectedDesktopMirror, selectedThreadId, socket]);

  const refreshQueuedMessages = useCallback(async (threadId: string) => {
    if (!desktopControlAvailable) return;
    const result = await socket.request("desktop/queue/list", { threadId });
    const messages = normalizeQueuedMessages(asRecord(result).messages);
    setQueuedByThread((current) => reconciler.reconcileQueueSnapshot(current, threadId, messages));
  }, [desktopControlAvailable, reconciler, socket]);

  useEffect(() => {
    if (connection !== "ready" || !selectedThreadId || !selectedDesktopMirror || !desktopControlAvailable) return;
    let refreshing = false;
    const timer = window.setInterval(() => {
      if (refreshing) return;
      refreshing = true;
      void refreshQueuedMessages(selectedThreadId)
        .catch(() => undefined)
        .finally(() => { refreshing = false; });
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [connection, desktopControlAvailable, refreshQueuedMessages, selectedDesktopMirror, selectedThreadId]);

  const createThread = useCallback(
    async (options: CreateThreadOptions = {}) => {
      const params: Record<string, unknown> = {};
      if (options.cwd) params.cwd = options.cwd;
      if (options.model) params.model = options.model;
      if (options.permission) Object.assign(params, permissionRpcParamsForMode(options.permission));
      if (options.reasoningEffort) {
        params.config = { model_reasoning_effort: options.reasoningEffort };
      }
      const result = await socket.request("thread/start", params);
      const record = asRecord(result);
      const thread = asRecord(record.thread ?? result);
      const id = stringValue(thread.id);
      if (id) {
        setSelectedThreadId(id);
        setState((current) => rememberThreadSettings(current, id, thread, options));
      }
      await refreshThreads();
      return id;
    },
    [refreshThreads, socket],
  );

  const sendInstruction = useCallback(
    async (text: string, images: File[] = [], runningMessageMode: "queue" | "steer" = "queue") => {
      if (!selectedThreadId) throw new Error("Select a task first");
      if (threadLoadError?.threadId === selectedThreadId) {
        throw new Error(threadLoadError.message);
      }
      const thread = state.threads[selectedThreadId];
      if (thread?.desktopMirror && !desktopControlAvailable) {
        throw new Error("此对话正由 Codex Desktop 运行，Web 当前为同步查看模式");
      }
      const uploaded = images.length > 0
        ? await Promise.all(images.map((image) => uploadImage(image, fetch, remoteApi)))
        : [];
      const input = [
        ...(text ? [{ type: "text", text }] : []),
        ...uploaded.map((image) => ({ type: "remoteImage", id: image.id })),
      ];
      if (input.length === 0) throw new Error("请输入消息或添加图片");
      if (thread?.status === "running") {
        if (thread.desktopMirror) {
          const result = await socket.request("desktop/queue/add", {
            threadId: selectedThreadId,
            text,
            input,
            cwd: thread.cwd,
          });
          const [message] = normalizeQueuedMessages([asRecord(result).message]);
          if (runningMessageMode === "steer" && message) {
            setQueuedByThread((current) =>
              reconciler.stageQueuePromotion(current, selectedThreadId, message)
            );
            try {
              await socket.request("desktop/queue/steer", {
                threadId: selectedThreadId,
                messageId: message.id,
                expectedTurnId: thread.activeTurnId,
              });
            } catch (cause) {
              setQueuedByThread((current) =>
                reconciler.failQueuePromotion(current, selectedThreadId, message.id)
              );
              throw cause;
            }
            return;
          }
          if (message) {
            setQueuedByThread((current) => ({
              ...current,
              [selectedThreadId]: [
                ...(current[selectedThreadId] ?? []).filter((item) => item.id !== message.id),
                message,
              ],
            }));
          }
          return;
        }
        const turnId = thread.activeTurnId ?? thread.turnOrder.at(-1);
        const itemId = `web-steer-${Date.now()}-${optimisticItemSequence.current++}`;
        if (turnId) {
          setState((current) => reconciler.stageUserMessage(
            current,
            selectedThreadId,
            turnId,
            itemId,
            text,
            uploaded.map((image) => image.id),
          ));
        }
        try {
          await socket.request("turn/steer", {
            threadId: selectedThreadId,
            expectedTurnId: thread.activeTurnId,
            input,
            cwd: thread.cwd,
            clientMessageId: itemId,
          });
        } catch (cause) {
          if (turnId) {
            setState((current) => reconciler.failUserMessage(current, selectedThreadId, turnId, itemId));
          }
          throw cause;
        }
      } else {
        const itemId = `web-start-${Date.now()}-${optimisticItemSequence.current++}`;
        const optimisticTurnId = `web-start-turn-${itemId}`;
        const params = {
          threadId: selectedThreadId,
          input,
          ...(thread?.model ? { model: thread.model } : {}),
          ...(thread?.reasoningEffort ? { effort: thread.reasoningEffort } : {}),
          ...permissionRpcParamsFromState(thread ?? {}),
        };
        setState((current) => stageStartingUserMessage(
          current,
          selectedThreadId,
          optimisticTurnId,
          itemId,
          text,
          uploaded.map((image) => image.id),
        ));
        try {
          if (!thread?.desktopMirror) {
            await socket.request("turn/start", params);
          } else {
            let resolveStarted: () => void = () => {};
            const started = new Promise<"started">((resolve) => {
              resolveStarted = () => resolve("started");
            });
            const waiters = turnStartedWaiters.current.get(selectedThreadId) ?? new Set();
            waiters.add(resolveStarted);
            turnStartedWaiters.current.set(selectedThreadId, waiters);
            const request = socket.request("turn/start", params);
            try {
              const outcome = await Promise.race([
                request.then(() => "response" as const),
                started,
              ]);
              if (outcome === "started") {
                void request.catch((cause) => {
                  setError(cause instanceof Error ? cause.message : "Could not start task");
                });
              }
            } finally {
              const currentWaiters = turnStartedWaiters.current.get(selectedThreadId);
              currentWaiters?.delete(resolveStarted);
              if (currentWaiters?.size === 0) turnStartedWaiters.current.delete(selectedThreadId);
            }
          }
        } catch (cause) {
          setState((current) => clearUnconfirmedThreadStart(
            reconciler.failUserMessage(
              current,
              selectedThreadId,
              optimisticTurnId,
              itemId,
            ),
            selectedThreadId,
          ));
          throw cause;
        }
      }
    },
    [desktopControlAvailable, reconciler, remoteApi.baseUrl, remoteApi.imageUploader, remoteApi.token, selectedThreadId, socket, state.threads, threadLoadError],
  );

  const steerQueuedMessage = useCallback(async (messageId: string) => {
    if (!selectedThreadId) throw new Error("Select a task first");
    const thread = state.threads[selectedThreadId];
    setQueuedByThread((current) => {
      const message = (current[selectedThreadId] ?? []).find((item) => item.id === messageId);
      return message
        ? reconciler.stageQueuePromotion(current, selectedThreadId, message)
        : current;
    });
    try {
      await socket.request("desktop/queue/steer", {
        threadId: selectedThreadId,
        messageId,
        expectedTurnId: thread?.activeTurnId,
      });
    } catch (cause) {
      setQueuedByThread((current) =>
        reconciler.failQueuePromotion(current, selectedThreadId, messageId)
      );
      throw cause;
    }
  }, [reconciler, selectedThreadId, socket, state.threads]);

  const updateSelectedThreadSettings = useCallback((settings: CreateThreadOptions) => {
    if (!selectedThreadId) return;
    const params: Record<string, unknown> = { threadId: selectedThreadId };
    if (settings.model !== undefined) params.model = settings.model;
    if (settings.reasoningEffort !== undefined) params.effort = settings.reasoningEffort;
    if (settings.permission !== undefined) {
      Object.assign(params, permissionRpcParamsForMode(settings.permission));
    }
    let previous: CodexThread | undefined;
    setState((current) => {
      const thread = current.threads[selectedThreadId];
      if (!thread) return current;
      previous = thread;
      return {
        ...current,
        threads: {
          ...current.threads,
          [selectedThreadId]: {
            ...thread,
            ...settings,
            ...(settings.permission ? permissionStateForMode(settings.permission) : {}),
          },
        },
      };
    });
    return socket.request("thread/settings/update", params).then(() => undefined).catch((cause) => {
      setState((current) => {
        const thread = current.threads[selectedThreadId];
        if (!thread || !previous || !threadMatchesSettings(thread, settings)) return current;
        return {
          ...current,
          threads: {
            ...current.threads,
            [selectedThreadId]: {
              ...thread,
              ...(settings.model !== undefined ? { model: previous.model } : {}),
              ...(settings.reasoningEffort !== undefined ? { reasoningEffort: previous.reasoningEffort } : {}),
              ...(settings.permission !== undefined ? permissionStateFromProtocol({}, previous) : {}),
            },
          },
        };
      });
      throw cause;
    });
  }, [selectedThreadId, socket]);

  const interrupt = useCallback(async () => {
    if (!selectedThreadId) return;
    let turnId = state.threads[selectedThreadId]?.activeTurnId;
    if (!turnId) {
      const activity = asRecord(await socket.request("gateway/threadActivity/read", {
        threadId: selectedThreadId,
      }));
      turnId = stringValue(activity.turnId);
      if (stringValue(activity.status) !== "running") {
        setState((current) => settleThreadAfterStop(current, selectedThreadId));
        return;
      }
      if (!turnId) throw new Error("运行状态正在同步，请稍后重试");
      const recoveredTurnId = turnId;
      setState((current) => reconciler.reduceEvent(current, {
        method: "turn/started",
        params: { threadId: selectedThreadId, turn: { id: recoveredTurnId } },
      }));
    }
    try {
      await socket.request("turn/interrupt", { threadId: selectedThreadId, turnId });
    } catch (cause) {
      if (!isNoActiveTurnToStop(cause)) throw cause;
      setState((current) => settleThreadAfterStop(current, selectedThreadId, turnId));
    }
  }, [reconciler, selectedThreadId, socket, state.threads]);

  const prepareDesktopRestart = useCallback(async () => {
    return await socket.request("gateway/desktopRestart/prepare") as {
      confirmationToken: string;
      expiresInSeconds: number;
      runningThreadCount: number;
    };
  }, [socket]);

  const confirmDesktopRestart = useCallback(async (confirmationToken: string) => {
    return await socket.request("gateway/desktopRestart/confirm", { confirmationToken }) as {
      accepted: boolean;
    };
  }, [socket]);

  const readQuestionContext = useCallback(async (request: QuestionContextRequest, signal?: AbortSignal) => {
    const result = await socket.request("desktopState/readQuestionContext", request, { signal, timeoutMs: 10_000 });
    if (!isQuestionContext(result)) throw new Error("原始问题响应无效");
    return result;
  }, [socket]);

  const resolveRequest = useCallback(
    (requestId: RpcRequest["id"], result: unknown) => {
      socket.respond(requestId, result);
      setPendingRequests((current) => current.filter((request) => request.id !== requestId));
    },
    [socket],
  );

  return useMemo(
    () => ({
      state,
      archivedThreads,
      archivedThreadsLoading,
      creationOptions,
      connection,
      threadsLoading,
      threadsError,
      defaultCwd,
      desktopStateAvailable,
      transportMode,
      transportReadOnly,
      desktopControlAvailable,
      error,
      selectedThreadId,
      selectedThreadLoading: loadingThreadId === selectedThreadId,
      selectedThreadError:
        threadLoadError?.threadId === selectedThreadId ? threadLoadError?.message : undefined,
      selectedThread: selectedThreadId ? state.threads[selectedThreadId] : undefined,
      selectedQueuedMessages: selectedThreadId ? queuedByThread[selectedThreadId] ?? [] : [],
      selectedThreadHistory: selectedThreadId
        ? visibleHistoryState(threadHistory[selectedThreadId] ?? emptyThreadHistory, historyCoverage.current.get(selectedThreadId) ?? [], automaticGapPages.current.get(selectedThreadId) ?? 0)
        : emptyThreadHistory,
      pendingRequests,
      connect,
      disconnect,
      refreshThreads,
      refreshArchivedThreads,
      refreshThreadSections,
      togglePin,
      archiveThread,
      renameThread,
      unarchiveThread,
      deleteThread,
      refreshCreationOptions,
      selectThread,
      loadEarlierThreadHistory,
      clearSelection,
      createThread,
      updateSelectedThreadSettings,
      sendInstruction,
      prepareDesktopRestart,
      confirmDesktopRestart,
      readQuestionContext,
      steerQueuedMessage,
      interrupt,
      resolveRequest,
    }),
    [
      connect,
      archivedThreads,
      archivedThreadsLoading,
      connection,
      threadsLoading,
      threadsError,
      confirmDesktopRestart,
      readQuestionContext,
      createThread,
      creationOptions,
      defaultCwd,
      desktopStateAvailable,
      desktopControlAvailable,
      disconnect,
      error,
      interrupt,
      refreshArchivedThreads,
      renameThread,
      unarchiveThread,
      deleteThread,
      loadingThreadId,
      loadEarlierThreadHistory,
      pendingRequests,
      prepareDesktopRestart,
      refreshThreads,
      refreshThreadSections,
      refreshCreationOptions,
      resolveRequest,
      selectThread,
      clearSelection,
      selectedThreadId,
      sendInstruction,
      steerQueuedMessage,
      state,
      queuedByThread,
      threadHistory,
      transportMode,
      transportReadOnly,
      threadLoadError,
      togglePin,
      archiveThread,
      updateSelectedThreadSettings,
    ],
  );
}

export function addOptimisticUserMessage(
  state: CodexState,
  threadId: string,
  turnId: string,
  itemId: string,
  text: string,
  imageIds: string[],
): CodexState {
  const thread = state.threads[threadId];
  const turn = thread?.turns[turnId];
  if (!thread || !turn) return state;
  // Desktop can emit the authoritative user item before React applies this
  // optimistic update. In that ordering, adding the optimistic item here would
  // leave the same steer visible twice until the next full hydration.
  const authoritative = latestConversationalItem(thread);
  const optimistic = { id: itemId, type: "userMessage", text, imageIds };
  if (authoritative && !authoritative.id.startsWith("web-steer-") && sameUserMessage(authoritative, optimistic)) {
    if (imageIds.length === 0 || authoritative.imageIds?.length) return state;
    return updateItemImages(state, threadId, authoritative.id, imageIds);
  }
  return {
    ...state,
    threads: {
      ...state.threads,
      [threadId]: {
        ...thread,
        turns: {
          ...thread.turns,
          [turnId]: {
            ...turn,
            itemOrder: [...turn.itemOrder, itemId],
            items: {
              ...turn.items,
              [itemId]: {
                id: itemId,
                type: "userMessage",
                text,
                imageIds: imageIds.length > 0 ? imageIds : undefined,
                status: "completed",
                clientMessageId: itemId,
                lifecycle: "pending" as const,
              },
            },
          },
        },
      },
    },
  };
}

function latestConversationalItem(thread: CodexThread) {
  for (const turnId of [...thread.turnOrder].reverse()) {
    const turn = thread.turns[turnId];
    for (const itemId of [...(turn?.itemOrder ?? [])].reverse()) {
      const item = turn?.items[itemId];
      const type = item?.type.toLocaleLowerCase() ?? "";
      if (item && (type.includes("user") || type.includes("agentmessage"))) return item;
    }
  }
  return undefined;
}

function updateItemImages(state: CodexState, threadId: string, itemId: string, imageIds: string[]) {
  const thread = state.threads[threadId];
  if (!thread) return state;
  const turnId = thread.turnOrder.find((candidate) => Boolean(thread.turns[candidate]?.items[itemId]));
  if (!turnId) return state;
  const turn = thread.turns[turnId];
  return {
    ...state,
    threads: {
      ...state.threads,
      [threadId]: {
        ...thread,
        turns: {
          ...thread.turns,
          [turnId]: {
            ...turn,
            items: { ...turn.items, [itemId]: { ...turn.items[itemId], imageIds } },
          },
        },
      },
    },
  };
}

function removeOptimisticItem(
  state: CodexState,
  threadId: string,
  turnId: string,
  itemId: string,
) {
  const thread = state.threads[threadId];
  const turn = thread?.turns[turnId];
  if (!thread || !turn?.items[itemId]) return state;
  const items = { ...turn.items };
  delete items[itemId];
  const itemOrder = turn.itemOrder.filter((id) => id !== itemId);
  if (turnId.startsWith("web-start-turn-") && itemOrder.length === 0) {
    const turns = { ...thread.turns };
    delete turns[turnId];
    return {
      ...state,
      threads: {
        ...state.threads,
        [threadId]: {
          ...thread,
          turnOrder: thread.turnOrder.filter((id) => id !== turnId),
          turns,
          activeTurnId: thread.activeTurnId === turnId ? undefined : thread.activeTurnId,
        },
      },
    };
  }
  return {
    ...state,
    threads: {
      ...state.threads,
      [threadId]: {
        ...thread,
        turns: {
          ...thread.turns,
          [turnId]: {
            ...turn,
            itemOrder,
            items,
          },
        },
      },
    },
  };
}

function updateThreadTitle(state: CodexState, threadId: string, title: string): CodexState {
  const thread = state.threads[threadId];
  if (!thread) return state;
  return {
    ...state,
    threads: { ...state.threads, [threadId]: { ...thread, title } },
  };
}

function restoreThread(state: CodexState, thread: CodexThread): CodexState {
  return {
    ...state,
    threadOrder: [thread.id, ...state.threadOrder.filter((id) => id !== thread.id)],
    threads: { ...state.threads, [thread.id]: thread },
  };
}

function removeThread(state: CodexState, threadId: string): CodexState {
  if (!state.threads[threadId]) return state;
  const threads = { ...state.threads };
  delete threads[threadId];
  return {
    ...state,
    threadOrder: state.threadOrder.filter((id) => id !== threadId),
    threads,
  };
}

function replaceThreadList(state: CodexState, value: unknown, metadataValue?: unknown): CodexState {
  const data = asRecord(value).data;
  if (!Array.isArray(data)) return { ...state, stale: false };
  const metadata = new Map<string, Record<string, unknown>>();
  const metadataData = asRecord(metadataValue).data;
  if (Array.isArray(metadataData)) {
    for (const value of metadataData) {
      const record = asRecord(value);
      const id = stringValue(record.id);
      if (id) metadata.set(id, record);
    }
  }
  const threads = { ...state.threads };
  const order: string[] = [];
  for (const entry of data) {
    const record = asRecord(entry);
    const id = stringValue(record.id);
    if (!id) continue;
    order.push(id);
    const current = threads[id];
    const incomingStatus = normalizeStatus(record.status, current?.status);
    const section = asRecord(record.section);
    const desktop = metadata.get(id);
    const hasPinnedValue = typeof desktop?.isPinned === "boolean";
    const isPinned = desktop?.isPinned === true;
    threads[id] = {
      id,
      title:
        stringValue(desktop?.title) ??
        stringValue(record.name) ??
        stringValue(record.title) ??
        stringValue(record.preview) ??
        current?.title ??
        "Untitled task",
      cwd: stringValue(desktop?.cwd) ?? stringValue(record.cwd) ?? current?.cwd,
      projectId: stringValue(desktop?.projectId) ?? current?.projectId,
      projectName: stringValue(desktop?.projectName) ?? current?.projectName,
      projectRootPaths: stringArray(desktop?.projectRootPaths) ?? current?.projectRootPaths,
      updatedAt:
        numberValue(desktop?.updatedAt) ??
        numberValue(record.updatedAt) ??
        numberValue(record.updated_at),
      // Lists have no turn identity. Preserve known lifecycle state until a
      // live event or the metadata-only reconciliation verifies a newer turn.
      status: current?.activeTurnId
        ? "running"
        : current && latestKnownTurnIsTerminal(current)
          ? current.status
          : incomingStatus,
      turnOrder: current?.turnOrder ?? [],
      turns: current?.turns ?? {},
      diff: current?.diff,
      activeTurnId: current?.activeTurnId,
      model: stringValue(desktop?.model) ?? current?.model,
      reasoningEffort: stringValue(desktop?.reasoningEffort) ?? current?.reasoningEffort,
      ...permissionStateFromProtocol(desktopPermissionProtocol(desktop), current),
      sectionId: hasPinnedValue
        ? isPinned ? "desktop-pinned" : undefined
        : stringValue(section.id),
      sectionName: hasPinnedValue
        ? isPinned ? "Pinned" : undefined
        : stringValue(section.name),
      sectionEnteredAt: numberValue(record.sectionEnteredAt) ?? numberValue(record.section_entered_at),
      desktopMirror: current?.desktopMirror,
      todoList: current?.todoList,
    };
  }
  return { threadOrder: order, threads, stale: false };
}

function latestKnownTurnIsTerminal(thread: CodexThread) {
  const turnId = thread.turnOrder.at(-1);
  return Boolean(turnId && isTerminalTurnStatus(thread.turns[turnId]?.status));
}

function stageStartingUserMessage(
  state: CodexState,
  threadId: string,
  turnId: string,
  itemId: string,
  text: string,
  imageIds: string[],
) {
  const thread = state.threads[threadId];
  if (!thread || thread.status === "running") return state;
  const withTurn: CodexState = {
    ...state,
    threads: {
      ...state.threads,
      [threadId]: {
        ...thread,
        status: "running",
        turnOrder: [...thread.turnOrder, turnId],
        turns: {
          ...thread.turns,
          [turnId]: { id: turnId, status: "inProgress", itemOrder: [], items: {} },
        },
      },
    },
  };
  return addOptimisticUserMessage(withTurn, threadId, turnId, itemId, text, imageIds);
}

function clearUnconfirmedThreadStart(state: CodexState, threadId: string): CodexState {
  const thread = state.threads[threadId];
  if (!thread || thread.activeTurnId || thread.status !== "running") return state;
  return {
    ...state,
    threads: { ...state.threads, [threadId]: { ...thread, status: "idle" } },
  };
}

function settleThreadAfterStop(state: CodexState, threadId: string, turnId?: string): CodexState {
  const thread = state.threads[threadId];
  if (!thread) return state;
  const activeTurnId = thread.activeTurnId;
  // The interrupt response belongs to the requested turn. If a newer turn
  // started while that request was in flight, its running state must win.
  if (turnId && activeTurnId && activeTurnId !== turnId) return state;
  if (activeTurnId && (!turnId || turnId === activeTurnId)) {
    return reduceCodexState(state, {
      method: "turn/completed",
      params: { threadId, turn: { id: activeTurnId, status: "interrupted" } },
    });
  }
  return {
    ...state,
    threads: {
      ...state.threads,
      [threadId]: { ...thread, status: "idle", activeTurnId: undefined },
    },
  };
}

function isNoActiveTurnToStop(cause: unknown) {
  return cause instanceof Error && /no\s+active\s+turn(?:\s+to\s+stop)?/i.test(cause.message);
}


function historyState(value: unknown): ThreadHistoryState {
  const history = asRecord(asRecord(value).history);
  const beforeCursor = stringValue(history.beforeCursor);
  return {
    beforeCursor,
    hasMoreBefore: history.hasMoreBefore === true && Boolean(beforeCursor),
    loading: false,
  };
}

function visibleHistoryState(history: ThreadHistoryState, ranges: HistoryRange[], automaticPages: number): ThreadHistoryState {
  const gap = latestHistoryGap(ranges);
  return gap ? { ...history, hasMoreBefore: true, beforeCursor: gap.beforeCursor, gapRecoveryPaused: automaticPages >= 8 } : history;
}

function boundedRequest<T>(request: Promise<T>, timeoutMs: number) {
  let timer: ReturnType<typeof setTimeout>;
  const deadline = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(() => reject(new Error("request timed out")), timeoutMs);
  });
  return Promise.race([request, deadline]).finally(() => clearTimeout(timer));
}

function mergeDesktopThreadList(appServerValue: unknown, desktopValue: unknown) {
  const appData = asRecord(appServerValue).data;
  const desktopData = asRecord(desktopValue).data;
  if (!Array.isArray(desktopData)) return appServerValue;
  const appById = new Map<string, Record<string, unknown>>();
  if (Array.isArray(appData)) {
    for (const value of appData) {
      const record = asRecord(value);
      const id = stringValue(record.id);
      if (id) appById.set(id, record);
    }
  }
  return {
    data: desktopData.map((value) => {
      const desktop = asRecord(value);
      const id = stringValue(desktop.id);
      const live = id ? appById.get(id) : undefined;
      const liveStatus = live?.status;
      const rawStatus = typeof liveStatus === "string" ? liveStatus : asRecord(liveStatus).type;
      return { ...live, ...desktop,
        status: rawStatus !== "notLoaded" && normalizeStatus(liveStatus) !== "unknown"
          ? liveStatus : desktop.status ?? liveStatus,
      };
    }),
  };
}


function isTerminalTurnStatus(status: TurnStatus) {
  return status === "completed" || status === "interrupted" || status === "failed";
}


function emptyThread(id: string): CodexThread {
  return { id, title: "Untitled task", status: "unknown", turnOrder: [], turns: {} };
}

function stringArray(value: unknown) {
  return Array.isArray(value)
    ? value.filter((entry): entry is string => typeof entry === "string")
    : undefined;
}

function rememberThreadSettings(
  state: CodexState,
  id: string,
  record: Record<string, unknown>,
  options: CreateThreadOptions,
): CodexState {
  const current = state.threads[id] ?? emptyThread(id);
  return {
    ...state,
    threadOrder: state.threadOrder.includes(id) ? state.threadOrder : [id, ...state.threadOrder],
    threads: {
      ...state.threads,
      [id]: {
        ...current,
        status: normalizeStatus(record.status, "idle"),
        title: stringValue(record.name) ?? stringValue(record.preview) ?? current.title,
        cwd: stringValue(record.cwd) ?? options.cwd ?? current.cwd,
        model: options.model,
        reasoningEffort: options.reasoningEffort,
        ...(options.permission ? permissionStateForMode(options.permission) : {}),
      },
    },
  };
}

function threadMatchesSettings(thread: CodexThread, settings: CreateThreadOptions) {
  return (
    (settings.model === undefined || thread.model === settings.model) &&
    (settings.reasoningEffort === undefined || thread.reasoningEffort === settings.reasoningEffort) &&
    (settings.permission === undefined || thread.permission === settings.permission)
  );
}

function normalizeModels(value: unknown): ModelOption[] {
  const data = asRecord(value).data;
  if (!Array.isArray(data)) return [];
  return data.flatMap((entry) => {
    const record = asRecord(entry);
    if (record.hidden === true) return [];
    const id = stringValue(record.model) ?? stringValue(record.id);
    if (!id) return [];
    const effortValues = Array.isArray(record.supportedReasoningEfforts)
      ? record.supportedReasoningEfforts
      : [];
    const reasoningEfforts = effortValues
      .map((effort) => stringValue(asRecord(effort).reasoningEffort) ?? stringValue(effort))
      .filter((effort): effort is string => Boolean(effort));
    return [{
      id,
      displayName: stringValue(record.displayName) ?? id,
      defaultReasoningEffort: stringValue(record.defaultReasoningEffort) ?? reasoningEfforts[0] ?? "medium",
      reasoningEfforts,
    }];
  });
}

function normalizePermissions(value: unknown, visibilityValue?: unknown): PermissionOption[] {
  const visibility = asRecord(visibilityValue) as PermissionModeVisibility;
  return permissionModeOptions(value, {
    guardianApprovals: visibility.guardianApprovals,
    fullAccess: visibility.fullAccess,
  });
}

function desktopPermissionProtocol(desktop: Record<string, unknown> | undefined) {
  if (!desktop) return {};
  return {
    approvalPolicy: desktop.approvalPolicy ?? desktop.approvalMode,
    approvalsReviewer: desktop.approvalsReviewer,
    sandboxPolicy: desktop.sandboxPolicy,
    activePermissionProfile: desktop.permissionProfile
      ? { id: desktop.permissionProfile }
      : desktop.permission
        ? { id: desktop.permission }
        : undefined,
  };
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? (value as Record<string, unknown>) : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function normalizeQueuedMessages(value: unknown): QueuedFollowUp[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((item) => {
    const record = asRecord(item);
    const id = stringValue(record.id);
    const text = stringValue(record.text);
    if (!id || text === undefined) return [];
    return [{
      id,
      text,
      createdAt: typeof record.createdAt === "number" ? record.createdAt : undefined,
      cwd: stringValue(record.cwd),
      lifecycle: "queued",
    }];
  });
}

function confirmedUserMessage(message: import("../../protocol/types").RpcMessage) {
  if (!("method" in message) ||
    (message.method !== "item/started" && message.method !== "item/completed")) return undefined;
  const params = asRecord(message.params);
  const item = asRecord(params.item);
  const type = stringValue(item.type)?.toLocaleLowerCase() ?? "";
  if (!type.includes("user")) return undefined;
  const threadId = stringValue(params.threadId);
  if (!threadId) return undefined;
  return {
    threadId,
    text: displayUserInput(itemText(item)),
    clientMessageId: stringValue(item.clientMessageId) ??
      stringValue(item.clientUserMessageId) ??
      stringValue(item.client_message_id),
  };
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
