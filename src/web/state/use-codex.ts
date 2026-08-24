import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  initialCodexState,
  markCodexStateStale,
  reduceCodexState,
  type CodexState,
  type CodexThread,
  type CodexTurn,
  type ThreadStatus,
  type TurnStatus,
} from "../../protocol/thread-store";
import { isRpcRequest, type RpcRequest } from "../../protocol/types";
import {
  permissionModeOptions,
  permissionRpcParamsForMode,
  permissionRpcParamsFromState,
  permissionStateForMode,
  permissionStateFromProtocol,
  type PermissionModeVisibility,
} from "../../protocol/permissions";
import { CodexSocket, uploadImage } from "../api/socket";

export type ConnectionState = "disconnected" | "connecting" | "ready";
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
};

const HISTORY_PAGE = { limitTurns: 8, maxBytes: 2 * 1024 * 1024 } as const;
const emptyThreadHistory: ThreadHistoryState = { hasMoreBefore: false, loading: false };

const emptyCreationOptions = {
  models: [] as ModelOption[],
  permissions: [] as PermissionOption[],
  loading: false,
  error: undefined as string | undefined,
};

export function useCodex(socketOverride?: CodexSocket) {
  const [socket] = useState(() => socketOverride ?? new CodexSocket());
  const [state, setState] = useState<CodexState>(initialCodexState);
  const [connection, setConnection] = useState<ConnectionState>("disconnected");
  const [defaultCwd, setDefaultCwd] = useState<string>();
  const [selectedThreadId, setSelectedThreadId] = useState<string>();
  const [loadingThreadId, setLoadingThreadId] = useState<string>();
  const [threadLoadError, setThreadLoadError] = useState<{ threadId: string; message: string }>();
  const [threadHistory, setThreadHistory] = useState<Record<string, ThreadHistoryState>>({});
  const [pinnedSectionId, setPinnedSectionId] = useState<string>();
  const [pendingRequests, setPendingRequests] = useState<RpcRequest[]>([]);
  const [creationOptions, setCreationOptions] = useState(emptyCreationOptions);
  const [desktopStateAvailable, setDesktopStateAvailable] = useState(false);
  const [transportMode, setTransportMode] = useState<TransportMode>();
  const [transportReadOnly, setTransportReadOnly] = useState(false);
  const [error, setError] = useState<string>();
  const desktopControlAvailable = transportMode === "desktop-live" && !transportReadOnly;
  const catalogRequestVersion = useRef(0);
  const selectionRequestVersion = useRef(0);
  const historyLoads = useRef(new Set<string>());
  const desktopHistoryThreads = useRef(new Set<string>());

  useEffect(() => {
    const unsubscribeRpc = socket.subscribe((message) => {
      if (isRpcRequest(message)) {
        setPendingRequests((current) => [...current, message]);
        return;
      }
      setState((current) => reduceCodexState(current, message));
    });
    const unsubscribeSession = socket.subscribeSession((envelope) => {
      if (envelope.type !== "session") return;
      if (envelope.state === "ready") {
        setConnection("ready");
        if (envelope.defaultCwd) setDefaultCwd(envelope.defaultCwd);
        if (envelope.transport) setTransportMode(envelope.transport);
        setTransportReadOnly(envelope.readOnly === true);
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
  }, [socket]);

  const connect = useCallback(
    async (token: string, url?: string) => {
      setConnection("connecting");
      setError(undefined);
      try {
        await socket.connect(token, url);
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
    let result: unknown;
    try {
      result = await socket.request("thread/list", {
        limit: 100,
        sortKey: "updated_at",
      });
    } catch {
      // A renderer reload can briefly make the live bridge read-only.
    }
    let desktopList: unknown;
    try {
      desktopList = await socket.request("desktopState/listThreads", {});
      setDesktopStateAvailable(true);
    } catch {
      // Older/test gateways can still provide a useful App Server list.
      setDesktopStateAvailable(false);
    }
    if (result === undefined && desktopList === undefined) {
      throw new Error("读取对话列表失败");
    }
    setState((current) => replaceThreadList(
      current,
      mergeDesktopThreadList(result ?? { data: [] }, desktopList),
      desktopList,
    ));
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
      const preserveDesktopHistory = desktopHistoryThreads.current.has(threadId);
      let desktopMirrorLoaded = false;
      setSelectedThreadId(threadId);
      setLoadingThreadId(threadId);
      setThreadLoadError(undefined);
      try {
        if (desktopStateAvailable) {
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
              setState((current) => hydrateThread(
                current,
                mirror,
                preserveDesktopHistory ? "append" : "snapshot",
              ));
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
          setState((current) => hydrateThread(current, result));
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
            setState((current) => hydrateThread(
              current,
              mirror,
              preserveDesktopHistory ? "append" : "snapshot",
            ));
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
    [desktopControlAvailable, desktopStateAvailable, socket],
  );

  const loadEarlierThreadHistory = useCallback(async () => {
    if (!selectedThreadId || historyLoads.current.has(selectedThreadId)) return;
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
      setState((current) => hydrateThread(current, value, "prepend"));
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
  }, [selectedThreadId, socket, threadHistory]);

  const selectedDesktopMirror = selectedThreadId
    ? state.threads[selectedThreadId]?.desktopMirror === true
    : false;
  useEffect(() => {
    if (
      connection !== "ready" || !selectedThreadId || !selectedDesktopMirror ||
      desktopControlAvailable
    ) return;
    const timer = window.setInterval(() => {
      void socket.request("desktopState/readThread", {
        threadId: selectedThreadId,
        history: { ...HISTORY_PAGE, limitTurns: 1 },
      })
        .then((value) => setState((current) => hydrateThread(current, value, "append")))
        .catch(() => undefined);
    }, 2_000);
    return () => window.clearInterval(timer);
  }, [connection, desktopControlAvailable, selectedDesktopMirror, selectedThreadId, socket]);

  const clearSelection = useCallback(() => setSelectedThreadId(undefined), []);

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
    async (text: string, images: File[] = []) => {
      if (!selectedThreadId) throw new Error("Select a task first");
      if (threadLoadError?.threadId === selectedThreadId) {
        throw new Error(threadLoadError.message);
      }
      const thread = state.threads[selectedThreadId];
      if (thread?.desktopMirror && !desktopControlAvailable) {
        throw new Error("此对话正由 Codex Desktop 运行，Web 当前为同步查看模式");
      }
      const uploaded = images.length > 0
        ? await Promise.all(images.map((image) => uploadImage(image)))
        : [];
      const input = [
        ...(text ? [{ type: "text", text }] : []),
        ...uploaded.map((image) => ({ type: "remoteImage", id: image.id })),
      ];
      if (input.length === 0) throw new Error("请输入消息或添加图片");
      if (thread?.status === "running") {
        await socket.request("turn/steer", {
          threadId: selectedThreadId,
          expectedTurnId: thread.activeTurnId,
          input,
        });
      } else {
        await socket.request("turn/start", {
          threadId: selectedThreadId,
          input,
          ...(thread?.model ? { model: thread.model } : {}),
          ...(thread?.reasoningEffort ? { effort: thread.reasoningEffort } : {}),
          ...permissionRpcParamsFromState(thread ?? {}),
        });
      }
    },
    [desktopControlAvailable, selectedThreadId, socket, state.threads, threadLoadError],
  );

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
    void socket.request("thread/settings/update", params).catch((cause) => {
      setError(cause instanceof Error ? cause.message : "更新对话设置失败");
      setState((current) => {
        const thread = current.threads[selectedThreadId];
        if (!thread || !previous || !threadMatchesSettings(thread, settings)) return current;
        return {
          ...current,
          threads: { ...current.threads, [selectedThreadId]: previous },
        };
      });
    });
  }, [selectedThreadId, socket]);

  const interrupt = useCallback(async () => {
    if (!selectedThreadId) return;
    const turnId = state.threads[selectedThreadId]?.activeTurnId;
    if (!turnId) throw new Error("No active turn to stop");
    await socket.request("turn/interrupt", { threadId: selectedThreadId, turnId });
  }, [selectedThreadId, socket, state.threads]);

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
      creationOptions,
      connection,
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
      selectedThreadHistory: selectedThreadId
        ? threadHistory[selectedThreadId] ?? emptyThreadHistory
        : emptyThreadHistory,
      pendingRequests,
      connect,
      disconnect,
      refreshThreads,
      refreshThreadSections,
      togglePin,
      refreshCreationOptions,
      selectThread,
      loadEarlierThreadHistory,
      clearSelection,
      createThread,
      updateSelectedThreadSettings,
      sendInstruction,
      interrupt,
      resolveRequest,
    }),
    [
      connect,
      connection,
      createThread,
      creationOptions,
      defaultCwd,
      desktopStateAvailable,
      desktopControlAvailable,
      disconnect,
      error,
      interrupt,
      loadingThreadId,
      loadEarlierThreadHistory,
      pendingRequests,
      refreshThreads,
      refreshThreadSections,
      refreshCreationOptions,
      resolveRequest,
      selectThread,
      clearSelection,
      selectedThreadId,
      sendInstruction,
      state,
      threadHistory,
      transportMode,
      transportReadOnly,
      threadLoadError,
      togglePin,
      updateSelectedThreadSettings,
    ],
  );
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
      updatedAt:
        numberValue(desktop?.updatedAt) ??
        numberValue(record.updatedAt) ??
        numberValue(record.updated_at),
      status: normalizeStatus(record.status, current?.status),
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
    };
  }
  return { threadOrder: order, threads, stale: false };
}

function hydrateThread(
  state: CodexState,
  value: unknown,
  placement: "snapshot" | "prepend" | "append" = "snapshot",
): CodexState {
  const outer = asRecord(value);
  const record = asRecord(outer.thread ?? value);
  const id = stringValue(record.id);
  if (!id) return state;
  const current = state.threads[id] ?? emptyThread(id);
  const hydratedTurns: Record<string, CodexTurn> = { ...current.turns };
  const snapshotTurnOrder: string[] = [];
  const turnValues = Array.isArray(record.turns) ? record.turns : [];
  for (const turnValue of turnValues) {
    const turnRecord = asRecord(turnValue);
    const turnId = stringValue(turnRecord.id);
    if (!turnId) continue;
    snapshotTurnOrder.push(turnId);
    const existing = current.turns[turnId];
    const snapshotStatus = normalizeTurnStatus(turnRecord.status);
    const snapshotTerminal = isTerminalTurnStatus(snapshotStatus);
    const snapshotItems: CodexTurn["items"] = {};
    const snapshotItemOrder: string[] = [];
    for (const itemValue of Array.isArray(turnRecord.items) ? turnRecord.items : []) {
      const item = asRecord(itemValue);
      const itemId = stringValue(item.id);
      if (!itemId) continue;
      snapshotItemOrder.push(itemId);
      snapshotItems[itemId] = {
        id: itemId,
        type: stringValue(item.type) ?? "item",
        text: extractItemText(item),
        status: stringValue(item.status),
        imageIds: stringArray(item.imageIds),
      };
    }
    const items = { ...snapshotItems };
    for (const [itemId, existingItem] of Object.entries(existing?.items ?? {})) {
      items[itemId] = mergeHydratedItem(snapshotItems[itemId], existingItem, snapshotTerminal);
    }
    const existingTerminal = existing ? isTerminalTurnStatus(existing.status) : false;
    hydratedTurns[turnId] = {
      id: turnId,
      status: existingTerminal
        ? existing.status
        : snapshotTerminal
        ? snapshotStatus
        : existing?.status === "inProgress"
          ? existing.status
          : snapshotStatus,
      itemOrder: appendMissing(snapshotItemOrder, existing?.itemOrder ?? []),
      items,
      startedAt: existing?.startedAt ?? numberValue(turnRecord.startedAt),
      completedAt: snapshotTerminal
        ? numberValue(turnRecord.completedAt) ?? existing?.completedAt
        : existing?.completedAt ?? numberValue(turnRecord.completedAt),
      durationMs: snapshotTerminal
        ? numberValue(turnRecord.durationMs) ?? existing?.durationMs
        : existing?.durationMs ?? numberValue(turnRecord.durationMs),
    };
  }
  const turnOrder = placement === "append"
    ? appendMissing(current.turnOrder, snapshotTurnOrder)
    : appendMissing(snapshotTurnOrder, current.turnOrder);
  const snapshotActiveTurnId = turnOrder.find(
    (turnId) => hydratedTurns[turnId]?.status === "inProgress",
  );
  const currentActiveTurnId = current.activeTurnId &&
    hydratedTurns[current.activeTurnId]?.status === "inProgress"
    ? current.activeTurnId
    : undefined;
  const activeTurnId = currentActiveTurnId ?? snapshotActiveTurnId;
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
        status: activeTurnId ? "running" : normalizeStatus(record.status, current.status),
        turns: hydratedTurns,
        turnOrder,
        activeTurnId,
        model: stringValue(outer.model) ?? current.model,
        reasoningEffort:
          stringValue(outer.reasoningEffort) ?? stringValue(outer.effort) ?? current.reasoningEffort,
        ...permissionStateFromProtocol(outer, current),
        sectionId: stringValue(asRecord(record.section).id) ?? current.sectionId,
        sectionName: stringValue(asRecord(record.section).name) ?? current.sectionName,
        desktopMirror: outer.desktopMirror === true,
      },
    },
  };
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
      return { ...(id ? appById.get(id) : undefined), ...desktop };
    }),
  };
}

function mergeHydratedItem(
  snapshot: CodexTurn["items"][string] | undefined,
  live: CodexTurn["items"][string],
  snapshotTerminal: boolean,
) {
  if (!snapshot) return live;
  let text = live.text;
  if (snapshot.text.startsWith(live.text)) text = snapshot.text;
  else if (live.text.startsWith(snapshot.text)) text = live.text;
  else if (snapshotTerminal && snapshot.text) text = snapshot.text;
  return {
    ...snapshot,
    ...live,
    text,
    status: snapshotTerminal ? snapshot.status ?? "completed" : live.status ?? snapshot.status,
  };
}

function isTerminalTurnStatus(status: TurnStatus) {
  return status === "completed" || status === "interrupted" || status === "failed";
}

function appendMissing(primary: string[], secondary: string[]) {
  return [...primary, ...secondary.filter((value) => !primary.includes(value))];
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

function extractItemText(item: Record<string, unknown>) {
  const direct =
    stringValue(item.text) ??
    stringValue(item.command) ??
    stringValue(item.query);
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
  if (Array.isArray(summary)) {
    return summary.filter((part): part is string => typeof part === "string").join("\n");
  }
  const tool = stringValue(item.tool);
  if (tool) return stringValue(item.server) ? `${stringValue(item.server)} / ${tool}` : tool;
  const changes = item.changes;
  if (Array.isArray(changes)) {
    return changes
      .map((change) => stringValue(asRecord(change).path) ?? stringValue(asRecord(change).filePath) ?? "")
      .filter(Boolean)
      .join("\n");
  }
  return "";
}
