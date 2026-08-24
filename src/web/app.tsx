import { useEffect, useRef, useState } from "react";
import { createBrowserSession } from "./api/socket";
import { ApprovalSheet, type ApprovalResolution } from "./components/approval-sheet";
import { Composer } from "./components/composer";
import { ConversationViewport } from "./components/conversation-viewport";
import { DiffViewer } from "./components/diff-viewer";
import { NewConversation } from "./components/new-conversation";
import { isDirectThread, projectsFromThreads, TaskList } from "./components/task-list";
import { Timeline, TodoListDock } from "./components/timeline";
import { TokenDialog } from "./components/token-dialog";
import { useCodex, type CreateThreadOptions } from "./state/use-codex";
import "./styles.css";

export function App() {
  const codex = useCodex();
  const autoConnectAttempted = useRef(false);
  const [decisionNotice, setDecisionNotice] = useState<string>();
  const [showNewConversation, setShowNewConversation] = useState(false);
  const [composerExpanded, setComposerExpanded] = useState(false);
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
    void codex.connect("")
      .then(refreshConnectedState)
      .catch(() => undefined);
  }, []);

  function selectThread(id: string) {
    setComposerExpanded(false);
    setShowNewConversation(false);
    void codex.selectThread(id).catch(() => undefined);
  }

  function startNewConversation() {
    setComposerExpanded(false);
    codex.clearSelection();
    setShowNewConversation(true);
  }

  async function createThread(options: CreateThreadOptions) {
    await codex.createThread(options);
    setShowNewConversation(false);
  }

  function resolveApproval(resolution: ApprovalResolution) {
    const request = codex.pendingRequests[0];
    if (!request) return;
    codex.resolveRequest(request.id, resolution.result);
    setDecisionNotice(resolution.decision === "accept" ? "Request approved" : "Request denied");
  }

  return (
    <main className="app-root">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-glyph" aria-hidden="true">C</span>
          <h1>Codex Remote</h1>
        </div>
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
          <TokenDialog
            onConnect={connect}
            busy={codex.connection === "connecting"}
            error={codex.error}
          />
        </div>
      ) : (
        <div className={`app-shell ${codex.selectedThreadId || showNewConversation ? "has-selection" : ""}`}>
          <aside className="sidebar">
            <TaskList
              threads={threads}
              directCwd={codex.defaultCwd}
              selectedId={codex.selectedThreadId}
              onSelect={selectThread}
              onNew={startNewConversation}
              onTogglePin={codex.desktopStateAvailable && !codex.desktopControlAvailable
                ? undefined
                : (id) => void codex.togglePin(id).catch(() => undefined)}
            />
          </aside>

          <section className="task-pane" aria-label="当前对话">
            {codex.state.stale ? (
              <div className="stale-banner" role="status">连接暂时中断，正在自动恢复…</div>
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
                onCancel={() => setShowNewConversation(false)}
              />
            ) : codex.selectedThread ? (
              <>
              <header className="task-header">
                <button
                  type="button"
                  className="back-button"
                  onClick={codex.clearSelection}
                  aria-label="返回对话列表"
                >
                  ‹
                </button>
                <div>
                  <p className="eyebrow">
                    {isDirectThread(codex.selectedThread, codex.defaultCwd)
                      ? "直接对话"
                      : codex.selectedThread.cwd ?? "直接对话"}
                  </p>
                  <h2>{codex.selectedThread.title}</h2>
                </div>
                <span className={`task-status status-${codex.selectedThread.status}`}>
                  {statusLabel(codex.selectedThread.status)}
                </span>
              </header>
              {codex.selectedThreadError ? (
                <div className="thread-load-error" role="alert">
                  <span>对话加载失败：{codex.selectedThreadError}</span>
                  <button
                    type="button"
                    className="secondary-button"
                    onClick={() => void codex.selectThread(codex.selectedThread!.id).catch(() => undefined)}
                  >
                    重试
                  </button>
                </div>
              ) : null}
              {codex.selectedThread.desktopMirror && !codex.desktopControlAvailable ? (
                <div className="desktop-mirror-banner" role="status">
                  Desktop 桥当前不可用；正在读取本地快照，网页为只读查看。
                </div>
              ) : null}
              <ConversationViewport
                threadId={codex.selectedThread.id}
                history={codex.selectedThreadHistory}
                onLoadEarlier={codex.loadEarlierThreadHistory}
                onInteract={() => setComposerExpanded(false)}
              >
                <Timeline thread={codex.selectedThread} />
                {codex.selectedThread.diff ? (
                  <details className="diff-panel">
                    <summary>查看代码变更</summary>
                    <DiffViewer diff={codex.selectedThread.diff} />
                  </details>
                ) : null}
              </ConversationViewport>
              <div className={`conversation-controls ${composerExpanded ? "controls-expanded" : "controls-collapsed"}`}>
                <TodoListDock todoList={codex.selectedThread.todoList} />
                <Composer
                draftKey={codex.selectedThread.id}
                onSend={codex.sendInstruction}
                running={codex.selectedThread.status === "running"}
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
      {codex.pendingRequests[0] ? (
        <ApprovalSheet request={codex.pendingRequests[0]} onResolve={resolveApproval} />
      ) : null}
    </main>
  );
}

function statusLabel(status: "running" | "idle" | "error" | "unknown") {
  if (status === "running") return "运行中";
  if (status === "idle") return "空闲";
  if (status === "error") return "出错";
  return "未知";
}
