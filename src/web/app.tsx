import { useEffect, useRef, useState } from "react";
import { createBrowserSession, remoteSocketUrl } from "./api/socket";
import { ApprovalSheet, type ApprovalResolution } from "./components/approval-sheet";
import { BrandMark } from "./components/brand-mark";
import { Composer } from "./components/composer";
import { QueuedFollowUps } from "./components/queued-follow-ups";
import { ConversationViewport } from "./components/conversation-viewport";
import { DiffViewer } from "./components/diff-viewer";
import { NewConversation } from "./components/new-conversation";
import { isDirectThread, projectsFromThreads, TaskList } from "./components/task-list";
import { Timeline, TodoListDock } from "./components/timeline";
import { TokenDialog } from "./components/token-dialog";
import { useCodex, type CreateThreadOptions } from "./state/use-codex";
import type { MobileLanguage, MobileMessageSendMode } from "../mobile/settings-store";
import "./styles.css";

export type NativeRemoteSession = {
  connectionId: string;
  name: string;
  baseUrl: string;
  token: string;
  requestedThreadId?: string;
  language?: MobileLanguage;
  messageSendMode?: MobileMessageSendMode;
  onManageConnections(): void;
  onOpenExternalUrl?(url: string): void;
};

export function App({ remote }: { remote?: NativeRemoteSession } = {}) {
  const language = remote?.language ?? "zh-CN";
  const copy = appCopy(language);
  const separator = language === "en" ? ", " : "，";
  const codex = useCodex(undefined, remote ? { baseUrl: remote.baseUrl, token: remote.token } : {});
  const autoConnectAttempted = useRef(false);
  const [decisionNotice, setDecisionNotice] = useState<string>();
  const [showNewConversation, setShowNewConversation] = useState(false);
  const [composerExpanded, setComposerExpanded] = useState(false);
  const [desktopRestart, setDesktopRestart] = useState<{
    confirmationToken: string;
    runningThreadCount: number;
  }>();
  const [desktopRestartBusy, setDesktopRestartBusy] = useState(false);
  const [desktopRestartNotice, setDesktopRestartNotice] = useState<string>();
  const threads = codex.state.threadOrder
    .map((id) => codex.state.threads[id])
    .filter(Boolean);

  async function connect(token: string) {
    await createBrowserSession(token);
    await codex.connect("");
    await refreshConnectedState();
  }

  async function refreshConnectedState() {
    await Promise.allSettled([
      codex.refreshThreads(),
      codex.refreshThreadSections(),
      codex.refreshCreationOptions(),
    ]);
  }

  useEffect(() => {
    if (autoConnectAttempted.current) return;
    autoConnectAttempted.current = true;
    void codex.connect(
      remote?.token ?? "",
      remote ? remoteSocketUrl(remote.baseUrl) : undefined,
      Boolean(remote),
    )
      .then(async () => {
        await refreshConnectedState();
        if (remote?.requestedThreadId) {
          pushView("thread", remote.requestedThreadId);
          await codex.selectThread(remote.requestedThreadId);
        }
      })
      .catch(() => undefined);
  }, []);

  useEffect(() => {
    if (!asRemoteView(window.history.state)) {
      window.history.replaceState({ ...historyRecord(window.history.state), codexRemoteView: "list" }, "");
    }
    const handleBack = () => {
      setComposerExpanded(false);
      setShowNewConversation(false);
      codex.clearSelection();
    };
    window.addEventListener("popstate", handleBack);
    return () => window.removeEventListener("popstate", handleBack);
  }, [codex.clearSelection]);

  useEffect(() => {
    if (!codex.desktopControlAvailable || desktopRestartNotice !== copy.restartWaiting) return;
    setDesktopRestartNotice(copy.restartRestored);
  }, [codex.desktopControlAvailable, copy.restartRestored, copy.restartWaiting, desktopRestartNotice]);

  useEffect(() => {
    if (desktopRestartNotice !== copy.restartRestored) return;
    const timer = window.setTimeout(() => setDesktopRestartNotice(undefined), 3_000);
    return () => window.clearTimeout(timer);
  }, [copy.restartRestored, desktopRestartNotice]);

  function pushView(view: "thread" | "new", threadId?: string) {
    if (asRemoteView(window.history.state) === view &&
        (view !== "thread" || historyRecord(window.history.state).codexRemoteThreadId === threadId)) return;
    window.history.pushState({
      ...historyRecord(window.history.state),
      codexRemoteView: view,
      ...(threadId ? { codexRemoteThreadId: threadId } : {}),
    }, "");
  }

  function returnToList() {
    setComposerExpanded(false);
    const view = asRemoteView(window.history.state);
    if (view === "thread" || view === "new") {
      window.history.back();
      return;
    }
    setShowNewConversation(false);
    codex.clearSelection();
  }

  function selectThread(id: string) {
    setComposerExpanded(false);
    setShowNewConversation(false);
    pushView("thread", id);
    void codex.selectThread(id).catch(() => undefined);
  }

  function startNewConversation() {
    setComposerExpanded(false);
    codex.clearSelection();
    setShowNewConversation(true);
    pushView("new");
  }

  async function createThread(options: CreateThreadOptions) {
    const id = await codex.createThread(options);
    if (id) window.history.replaceState({
      ...historyRecord(window.history.state),
      codexRemoteView: "thread",
      codexRemoteThreadId: id,
    }, "");
    setShowNewConversation(false);
  }

  function resolveApproval(resolution: ApprovalResolution) {
    const request = codex.pendingRequests[0];
    if (!request) return;
    codex.resolveRequest(request.id, resolution.result);
    setDecisionNotice(resolution.decision === "accept" ? "Request approved" : "Request denied");
  }

  async function prepareDesktopRestart() {
    setDesktopRestartNotice(undefined);
    setDesktopRestartBusy(true);
    try {
      setDesktopRestart(await codex.prepareDesktopRestart());
    } catch (cause) {
      setDesktopRestartNotice(cause instanceof Error ? cause.message : copy.restartFailed);
    } finally {
      setDesktopRestartBusy(false);
    }
  }

  async function confirmDesktopRestart() {
    if (!desktopRestart) return;
    setDesktopRestartBusy(true);
    try {
      await codex.confirmDesktopRestart(desktopRestart.confirmationToken);
      setDesktopRestart(undefined);
      setDesktopRestartNotice(copy.restartWaiting);
    } catch (cause) {
      setDesktopRestartNotice(cause instanceof Error ? cause.message : copy.restartFailed);
    } finally {
      setDesktopRestartBusy(false);
    }
  }

  return (
    <main className="app-root">
      <header className={`topbar ${remote ? "topbar-native" : ""} ${remote && codex.selectedThread ? "topbar-native-thread" : ""}`}>
        <div className="brand-lockup">
          {codex.selectedThread ? (
            <button
              type="button"
              className="mobile-thread-back"
              onClick={returnToList}
              aria-label={copy.backToList}
            >
              ‹
            </button>
          ) : null}
          <BrandMark compact />
          <h1>{codex.selectedThread?.title ?? "Remote"}</h1>
          {remote && codex.selectedThread ? (
            <span className={`mobile-thread-status status-${codex.selectedThread.status}`}>
              {statusLabel(codex.selectedThread.status, language)}
            </span>
          ) : null}
        </div>
        {remote ? (
          <button
            type="button"
            className="manage-connections-button remote-connection-pill"
            onClick={remote.onManageConnections}
            aria-label={`${copy.manageConnection} ${remote.name}${separator}${connectionLabel(codex.connection, language)}`}
          >
            <span aria-hidden="true" className={`remote-connection-indicator connection-${codex.connection}`} />
            <span>{remote.name}</span>
          </button>
        ) : null}
        <div className={`connection-state connection-${codex.connection}`}>
          <span aria-hidden="true" />
          {codex.connection === "ready"
            ? "Connected"
            : codex.connection === "reconnecting"
            ? "Reconnecting"
            : codex.connection === "connecting"
            ? "Connecting"
            : "Offline"}
        </div>
      </header>

      {codex.connection !== "ready" && codex.connection !== "reconnecting" ? (
        <div className="connect-stage">
          {remote ? (
            <section className="native-connect-error">
              <h2>{copy.cannotConnect} {remote.name}</h2>
              <p>{codex.error ?? copy.connectionHint}</p>
              <div>
                <button type="button" className="secondary-button" onClick={remote.onManageConnections}>{copy.backToConnections}</button>
                <button
                  type="button"
                  className="primary-button"
                  onClick={() => window.location.reload()}
                >{copy.retry}</button>
              </div>
            </section>
          ) : (
            <TokenDialog
              onConnect={connect}
              busy={codex.connection === "connecting"}
              error={codex.error}
            />
          )}
        </div>
      ) : (
        <div className={`app-shell ${codex.selectedThreadId || showNewConversation ? "has-selection" : ""}`}>
          <aside className="sidebar">
            <TaskList
              threads={threads}
              archivedThreads={codex.archivedThreads}
              archivedLoading={codex.archivedThreadsLoading}
              directCwd={codex.defaultCwd}
              selectedId={codex.selectedThreadId}
              onSelect={selectThread}
              onNew={startNewConversation}
              onTogglePin={codex.desktopStateAvailable && !codex.desktopControlAvailable
                ? undefined
                : (id) => void codex.togglePin(id).catch(() => undefined)}
              onArchive={codex.desktopStateAvailable && !codex.desktopControlAvailable
                ? undefined
                : (id) => void codex.archiveThread(id).catch(() => undefined)}
              onRename={codex.desktopStateAvailable && !codex.desktopControlAvailable
                ? undefined
                : codex.renameThread}
              onUnarchive={codex.desktopStateAvailable && !codex.desktopControlAvailable
                ? undefined
                : codex.unarchiveThread}
              onDelete={codex.desktopStateAvailable && !codex.desktopControlAvailable
                ? undefined
                : codex.deleteThread}
              onLoadArchived={codex.refreshArchivedThreads}
              language={language}
            />
          </aside>

          <section className="task-pane" aria-label={copy.currentConversation}>
            {codex.state.stale ? (
              <div className="stale-banner" role="status">{copy.recovering}</div>
            ) : null}
            {showNewConversation ? (
              <NewConversation
                projects={projectsFromThreads(threads, codex.defaultCwd)}
                models={codex.creationOptions.models}
                permissions={codex.creationOptions.permissions}
                catalogLoading={codex.creationOptions.loading}
                catalogError={codex.creationOptions.error}
                onProjectChange={(cwd) => codex.refreshCreationOptions(cwd || undefined)}
                onRetry={(cwd) => codex.refreshCreationOptions(cwd || undefined)}
                onCreate={createThread}
                onCancel={returnToList}
                language={language}
              />
            ) : codex.selectedThread ? (
              <>
              {!remote ? <header className="task-header">
                <button
                  type="button"
                  className="back-button"
                  onClick={returnToList}
                  aria-label={copy.backToList}
                >
                  ‹
                </button>
                <div>
                  <p className="eyebrow desktop-thread-context">
                    {isDirectThread(codex.selectedThread, codex.defaultCwd)
                      ? copy.directConversation
                      : codex.selectedThread.cwd ?? copy.directConversation}
                  </p>
                </div>
                <span className={`task-status status-${codex.selectedThread.status}`}>
                  {statusLabel(codex.selectedThread.status, language)}
                </span>
              </header> : null}
              {codex.selectedThreadError ? (
                <div className="thread-load-error" role="alert">
                  <span>{copy.loadFailed}: {codex.selectedThreadError}</span>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void codex.selectThread(codex.selectedThread!.id).catch(() => undefined)}
                  >
                    {copy.retry}
                  </button>
                </div>
              ) : null}
              {codex.selectedThread.desktopMirror && !codex.desktopControlAvailable ? (
                <div className="desktop-mirror-banner" role="status">
                  <span>{copy.desktopUnavailable}</span>
                  <button
                    type="button"
                    className="desktop-restart-button"
                    disabled={desktopRestartBusy}
                    onClick={() => void prepareDesktopRestart()}
                  >{copy.restartDesktop}</button>
                </div>
              ) : null}
              <ConversationViewport
                threadId={codex.selectedThread.id}
                history={codex.selectedThreadHistory}
                onLoadEarlier={codex.loadEarlierThreadHistory}
                onInteract={() => setComposerExpanded(false)}
              >
                <Timeline
                  thread={codex.selectedThread}
                  imageRequest={remote ? { baseUrl: remote.baseUrl, token: remote.token } : undefined}
                  onOpenExternalUrl={remote?.onOpenExternalUrl}
                />
                {codex.selectedThread.diff ? (
                  <details className="diff-panel">
                    <summary>{copy.viewCodeChanges}</summary>
                    <DiffViewer diff={codex.selectedThread.diff} />
                  </details>
                ) : null}
              </ConversationViewport>
              <div className={`conversation-controls ${composerExpanded ? "controls-expanded" : "controls-collapsed"}`}>
                <TodoListDock todoList={codex.selectedThread.todoList} />
                <QueuedFollowUps
                  messages={codex.selectedQueuedMessages ?? []}
                  onSteer={codex.steerQueuedMessage}
                  language={language}
                />
                <Composer
                draftKey={codex.selectedThread.id}
                onSend={(text, images) => codex.sendInstruction(text, images, remote?.messageSendMode)}
                running={codex.selectedThread.status === "running"}
                runningMode={codex.selectedThread.desktopMirror
                  ? remote?.messageSendMode ?? "queue"
                  : "steer"}
                language={remote?.language}
                onStop={codex.selectedThread.status === "running" ? codex.interrupt : undefined}
                models={codex.creationOptions.models}
                permissions={codex.creationOptions.permissions}
                model={codex.selectedThread.model}
                reasoningEffort={codex.selectedThread.reasoningEffort}
                permission={codex.selectedThread.permission}
                onSettingsChange={codex.updateSelectedThreadSettings}
                expanded={composerExpanded}
                onExpandedChange={setComposerExpanded}
                disabled={
                  codex.state.stale ||
                  codex.selectedThreadLoading ||
                  Boolean(codex.selectedThreadError) ||
                  Boolean(codex.selectedThread.desktopMirror && !codex.desktopControlAvailable)
                }
                />
              </div>
              </>
            ) : (
              <div className="timeline-scroll"><Timeline /></div>
            )}
          </section>
        </div>
      )}
      {decisionNotice ? (
        <div className="decision-toast" role="status" onAnimationEnd={() => setDecisionNotice(undefined)}>
          {decisionNotice}
        </div>
      ) : null}
      {desktopRestartNotice ? (
        <div className="desktop-restart-notice" role="status">{desktopRestartNotice}</div>
      ) : null}
      {desktopRestart ? (
        <div className="desktop-restart-backdrop" role="presentation" onMouseDown={(event) => {
          if (event.target === event.currentTarget && !desktopRestartBusy) setDesktopRestart(undefined);
        }}>
          <section className="desktop-restart-dialog" role="dialog" aria-modal="true" aria-labelledby="desktop-restart-title">
            <h2 id="desktop-restart-title">{copy.restartTitle}</h2>
            <p>{desktopRestart.runningThreadCount > 0
              ? copy.restartRunning(desktopRestart.runningThreadCount)
              : copy.restartNoRunning}</p>
            <p>{copy.restartWarning}</p>
            <div>
              <button type="button" className="secondary-button" disabled={desktopRestartBusy} onClick={() => setDesktopRestart(undefined)}>{copy.cancel}</button>
              <button type="button" className="danger-button" disabled={desktopRestartBusy} onClick={() => void confirmDesktopRestart()}>{desktopRestartBusy ? copy.restarting : copy.confirmRestart}</button>
            </div>
          </section>
        </div>
      ) : null}
      {codex.pendingRequests[0] ? (
        <ApprovalSheet request={codex.pendingRequests[0]} onResolve={resolveApproval} />
      ) : null}
    </main>
  );
}

function historyRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function asRemoteView(value: unknown) {
  const view = historyRecord(value).codexRemoteView;
  return view === "list" || view === "thread" || view === "new" ? view : undefined;
}

function statusLabel(status: "running" | "idle" | "error" | "unknown", language: MobileLanguage = "zh-CN") {
  const en = language === "en";
  if (status === "running") return en ? "Running" : "运行中";
  if (status === "idle") return en ? "Idle" : "空闲";
  if (status === "error") return en ? "Error" : "出错";
  return en ? "Unknown" : "未知";
}

function connectionLabel(connection: "disconnected" | "connecting" | "reconnecting" | "ready", language: MobileLanguage = "zh-CN") {
  const en = language === "en";
  if (connection === "ready") return en ? "Connected" : "已连接";
  if (connection === "reconnecting") return en ? "Reconnecting" : "正在重连";
  if (connection === "connecting") return en ? "Connecting" : "正在连接";
  return en ? "Offline" : "离线";
}

function appCopy(language: MobileLanguage) {
  const en = language === "en";
  return {
    backToList: en ? "Back to conversations" : "返回对话列表",
    manageConnection: en ? "Manage connection" : "管理连接",
    cannotConnect: en ? "Cannot connect to" : "无法连接",
    connectionHint: en
      ? "Make sure the Mac is online, the VPN is connected, and the Remote address is reachable."
      : "请确认 Mac 在线、VPN 已连接且 Remote 地址可访问。",
    backToConnections: en ? "Back to connections" : "返回连接列表",
    retry: en ? "Retry" : "重试",
    currentConversation: en ? "Current conversation" : "当前对话",
    recovering: en ? "Connection interrupted. Recovering automatically…" : "连接暂时中断，正在自动恢复…",
    directConversation: en ? "Direct conversation" : "直接对话",
    loadFailed: en ? "Conversation failed to load" : "对话加载失败",
    desktopUnavailable: en
      ? "The Desktop bridge is unavailable. Reading the local snapshot in read-only mode."
      : "Desktop 桥当前不可用；正在读取本地快照，网页为只读查看。",
    restartDesktop: en ? "Restart Desktop to restore control" : "重启 Desktop 恢复控制",
    restartTitle: en ? "Restart Codex Desktop" : "重启 Codex Desktop",
    restartRunning: (count: number) => en
      ? `${count} conversation${count === 1 ? " is" : "s are"} currently running.`
      : `当前有 ${count} 个对话正在运行。`,
    restartNoRunning: en ? "No conversations are currently running." : "当前没有运行中的对话。",
    restartWarning: en
      ? "Desktop will quit once and reopen with its loopback bridge enabled. Running work may be interrupted."
      : "Desktop 将退出一次并带本机桥接参数重新打开，正在运行的工作可能中断。",
    confirmRestart: en ? "Confirm restart" : "确认重启",
    restarting: en ? "Restarting…" : "正在重启…",
    cancel: en ? "Cancel" : "取消",
    restartWaiting: en
      ? "Restart requested. Waiting for the Desktop bridge to recover…"
      : "已请求重启，正在等待 Desktop 桥恢复…",
    restartRestored: en ? "Desktop bridge restored" : "Desktop 桥已恢复",
    restartFailed: en ? "Desktop restart failed" : "Desktop 重启失败",
    viewCodeChanges: en ? "View code changes" : "查看代码变更",
  };
}
