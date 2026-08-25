import { useMemo, useRef, useState, type FormEvent, type PointerEvent } from "react";
import type { CodexThread, ThreadStatus } from "../../protocol/thread-store";

type TaskListProps = {
  threads: CodexThread[];
  archivedThreads?: CodexThread[];
  archivedLoading?: boolean;
  directCwd?: string;
  selectedId?: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onTogglePin?: (id: string) => void;
  onArchive?: (id: string) => void;
  onRename?: (id: string, name: string) => void | Promise<void>;
  onUnarchive?: (id: string) => void | Promise<void>;
  onDelete?: (id: string) => void | Promise<void>;
  onLoadArchived?: () => void | Promise<void>;
};

type ProjectGroup = {
  key: string;
  cwd: string;
  name: string;
  threads: CodexThread[];
  status: ThreadStatus;
};

export function TaskList({
  threads,
  archivedThreads = [],
  archivedLoading = false,
  directCwd,
  selectedId,
  onSelect,
  onNew,
  onTogglePin,
  onArchive,
  onRename,
  onUnarchive,
  onDelete,
  onLoadArchived,
}: TaskListProps) {
  const [query, setQuery] = useState("");
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set());
  const [revealedThreadId, setRevealedThreadId] = useState<string>();
  const [archivedExpanded, setArchivedExpanded] = useState(false);
  const [dialog, setDialog] = useState<{ type: "rename" | "delete"; thread: CodexThread }>();
  const [dialogName, setDialogName] = useState("");
  const [dialogBusy, setDialogBusy] = useState(false);
  const [dialogError, setDialogError] = useState<string>();
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return threads;
    return threads.filter((thread) =>
      `${thread.title} ${thread.projectName ?? ""} ${thread.cwd ?? ""} ${(thread.projectRootPaths ?? []).join(" ")}`
        .toLocaleLowerCase().includes(needle),
    );
  }, [query, threads]);
  const pinned = filtered.filter(isPinnedThread);
  const unpinned = filtered.filter((thread) => !isPinnedThread(thread));
  const hasDesktopProjects = filtered.some((thread) => Boolean(thread.projectId));
  const projects = useMemo(() => groupProjects(unpinned, directCwd), [directCwd, unpinned]);
  const recent = unpinned.filter((thread) =>
    isDirectThread(thread, directCwd) || (hasDesktopProjects && !thread.projectId)
  );

  function toggleProject(cwd: string) {
    setExpandedProjects((current) => {
      const next = new Set(current);
      if (next.has(cwd)) next.delete(cwd);
      else next.add(cwd);
      return next;
    });
  }

  function openRename(thread: CodexThread) {
    setDialog({ type: "rename", thread });
    setDialogName(thread.title);
    setDialogError(undefined);
  }

  function openDelete(thread: CodexThread) {
    setDialog({ type: "delete", thread });
    setDialogError(undefined);
  }

  async function submitDialog(event: FormEvent) {
    event.preventDefault();
    if (!dialog || dialogBusy) return;
    const name = dialogName.trim();
    if (dialog.type === "rename" && !name) {
      setDialogError("标题不能为空");
      return;
    }
    setDialogBusy(true);
    setDialogError(undefined);
    try {
      if (dialog.type === "rename") await onRename?.(dialog.thread.id, name);
      else await onDelete?.(dialog.thread.id);
      setDialog(undefined);
    } catch (cause) {
      setDialogError(cause instanceof Error ? cause.message : "操作失败");
    } finally {
      setDialogBusy(false);
    }
  }

  function toggleArchived() {
    const expanded = !archivedExpanded;
    setArchivedExpanded(expanded);
    if (expanded) void onLoadArchived?.();
  }

  return (
    <nav className="task-nav" aria-label="对话导航">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Codex</p>
          <h2>Remote</h2>
        </div>
      </div>

      <div className="task-list" data-testid="task-list-scroll">
        {filtered.length === 0 ? (
          <p className="empty-list">{threads.length === 0 ? "还没有活跃对话" : "没有匹配的对话"}</p>
        ) : (
          <>
            <section className="nav-section" aria-labelledby="pinned-heading">
              <h3 id="pinned-heading">置顶</h3>
              <div className="conversation-list">
                {pinned.length > 0 ? pinned.map((thread) => (
                  <ConversationRow
                    key={thread.id}
                    thread={thread}
                    selected={thread.id === selectedId}
                    onSelect={onSelect}
                    onTogglePin={onTogglePin}
                    onArchive={onArchive}
                    onRename={onRename ? openRename : undefined}
                    onDelete={onDelete ? openDelete : undefined}
                    actionsRevealed={revealedThreadId === thread.id}
                    onRevealActions={(revealed) => setRevealedThreadId(revealed ? thread.id : undefined)}
                    directCwd={directCwd}
                    desktopProjectsAvailable={hasDesktopProjects}
                  />
                )) : <p className="empty-section">暂无置顶对话</p>}
              </div>
            </section>

            <section className="nav-section project-section" aria-labelledby="project-heading">
              <h3 id="project-heading">项目</h3>
              <div className="project-list">
                {projects.map((project) => {
                  const expanded = Boolean(query.trim()) || expandedProjects.has(project.key) ||
                    project.threads.some((thread) => thread.id === selectedId);
                  return (
                    <div className="project-group" key={project.key}>
                      <button
                        type="button"
                        className="project-row"
                        aria-expanded={expanded}
                        aria-label={`${project.name}，${project.threads.length} 个对话，${statusLabel(project.status)}`}
                        onClick={() => toggleProject(project.key)}
                      >
                        <span className="folder-icon" aria-hidden="true" />
                        <span className="project-name">{project.name}</span>
                        <span className={`status-dot status-${project.status}`} aria-hidden="true" />
                        <span className="project-count">{project.threads.length}</span>
                        <span className="disclosure" aria-hidden="true">⌄</span>
                      </button>
                      {expanded ? (
                        <div className="project-conversations">
                          {project.threads.map((thread) => (
                            <ConversationRow
                              key={thread.id}
                              thread={thread}
                              selected={thread.id === selectedId}
                              onSelect={onSelect}
                              onTogglePin={onTogglePin}
                              onArchive={onArchive}
                              onRename={onRename ? openRename : undefined}
                              onDelete={onDelete ? openDelete : undefined}
                              actionsRevealed={revealedThreadId === thread.id}
                              onRevealActions={(revealed) => setRevealedThreadId(revealed ? thread.id : undefined)}
                              directCwd={directCwd}
                              desktopProjectsAvailable={hasDesktopProjects}
                              compact
                            />
                          ))}
                        </div>
                      ) : null}
                    </div>
                  );
                })}
              </div>
            </section>

            <section className="nav-section" aria-labelledby="recent-heading">
              <h3 id="recent-heading">最近</h3>
              <div className="conversation-list">
                {recent.length > 0 ? recent.map((thread) => (
                  <ConversationRow
                    key={thread.id}
                    thread={thread}
                    selected={thread.id === selectedId}
                    onSelect={onSelect}
                    onTogglePin={onTogglePin}
                    onArchive={onArchive}
                    onRename={onRename ? openRename : undefined}
                    onDelete={onDelete ? openDelete : undefined}
                    actionsRevealed={revealedThreadId === thread.id}
                    onRevealActions={(revealed) => setRevealedThreadId(revealed ? thread.id : undefined)}
                    directCwd={directCwd}
                    desktopProjectsAvailable={hasDesktopProjects}
                  />
                )) : <p className="empty-section">暂无直接对话</p>}
              </div>
            </section>

          </>
        )}
        {!query.trim() ? (
          <section className="nav-section archive-section" aria-label="归档对话">
              <button
                type="button"
                className="archive-heading"
                aria-expanded={archivedExpanded}
                onClick={toggleArchived}
              >
                <span>归档对话</span>
                <span>{archivedLoading ? "加载中" : archivedThreads.length}</span>
                <span aria-hidden="true">⌄</span>
              </button>
              {archivedExpanded ? (
                <div className="conversation-list archived-conversations">
                  {archivedLoading && archivedThreads.length === 0 ? (
                    <p className="empty-section">正在加载归档对话…</p>
                  ) : archivedThreads.length > 0 ? archivedThreads.map((thread) => (
                    <ConversationRow
                      key={thread.id}
                      thread={thread}
                      selected={false}
                      onSelect={() => undefined}
                      onRename={onRename ? openRename : undefined}
                      onUnarchive={onUnarchive}
                      onDelete={onDelete ? openDelete : undefined}
                      archived
                      actionsRevealed={revealedThreadId === thread.id}
                      onRevealActions={(revealed) => setRevealedThreadId(revealed ? thread.id : undefined)}
                      directCwd={directCwd}
                      desktopProjectsAvailable={hasDesktopProjects}
                    />
                  )) : <p className="empty-section">暂无归档对话</p>}
                </div>
              ) : null}
          </section>
        ) : null}
      </div>
      <div className="task-nav-footer">
        <label className="search-field">
          <span className="visually-hidden">搜索对话</span>
          <span className="search-icon" aria-hidden="true" />
          <input
            type="search"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="搜索聊天"
          />
        </label>
        <button className="icon-button" type="button" onClick={onNew} aria-label="新对话">
          <span className="compose-icon" aria-hidden="true" />
        </button>
      </div>
      {dialog ? (
        <div className="thread-dialog-backdrop" onPointerDown={(event) => {
          if (event.currentTarget === event.target && !dialogBusy) setDialog(undefined);
        }}>
          <form
            className="thread-dialog"
            role="dialog"
            aria-modal="true"
            aria-label={dialog.type === "rename" ? "重命名对话" : "删除对话"}
            onSubmit={submitDialog}
          >
            <h3>{dialog.type === "rename" ? "重命名对话" : "删除对话"}</h3>
            {dialog.type === "rename" ? (
              <label>
                <span>对话标题</span>
                <input
                  aria-label="对话标题"
                  value={dialogName}
                  maxLength={200}
                  autoFocus
                  onChange={(event) => setDialogName(event.target.value)}
                />
              </label>
            ) : (
              <p>“{dialog.thread.title}”将从 Codex Desktop 中永久删除，无法恢复。</p>
            )}
            {dialogError ? <p className="inline-error" role="alert">{dialogError}</p> : null}
            <div className="thread-dialog-actions">
              <button type="button" className="secondary-button" disabled={dialogBusy} onClick={() => setDialog(undefined)}>取消</button>
              <button type="submit" className={dialog.type === "delete" ? "danger-button" : "primary-button"} disabled={dialogBusy}>
                {dialog.type === "rename" ? "保存" : "永久删除"}
              </button>
            </div>
          </form>
        </div>
      ) : null}
    </nav>
  );
}

function ConversationRow({
  thread,
  selected,
  onSelect,
  onTogglePin,
  onArchive,
  onRename,
  onUnarchive,
  onDelete,
  archived = false,
  actionsRevealed,
  onRevealActions,
  compact = false,
  directCwd,
  desktopProjectsAvailable = false,
}: {
  thread: CodexThread;
  selected: boolean;
  onSelect: (id: string) => void;
  onTogglePin?: (id: string) => void;
  onArchive?: (id: string) => void;
  onRename?: (thread: CodexThread) => void;
  onUnarchive?: (id: string) => void | Promise<void>;
  onDelete?: (thread: CodexThread) => void;
  archived?: boolean;
  actionsRevealed: boolean;
  onRevealActions: (revealed: boolean) => void;
  compact?: boolean;
  directCwd?: string;
  desktopProjectsAvailable?: boolean;
}) {
  const pinned = isPinnedThread(thread);
  const pointerStart = useRef<{ x: number; y: number } | undefined>(undefined);
  const consumedSwipe = useRef(false);
  const actions = [onRename, onTogglePin, onArchive, onUnarchive, onDelete].filter(Boolean);
  const hasActions = actions.length > 0;

  function beginSwipe(event: PointerEvent<HTMLDivElement>) {
    if (!hasActions) return;
    pointerStart.current = { x: event.clientX, y: event.clientY };
    consumedSwipe.current = false;
  }

  function finishSwipe(event: PointerEvent<HTMLDivElement>) {
    const start = pointerStart.current;
    pointerStart.current = undefined;
    if (!start) return;
    const horizontal = event.clientX - start.x;
    const vertical = event.clientY - start.y;
    if (Math.abs(horizontal) < 42 || Math.abs(horizontal) <= Math.abs(vertical)) return;
    consumedSwipe.current = true;
    onRevealActions(horizontal < 0);
  }

  function selectConversation() {
    if (consumedSwipe.current) {
      consumedSwipe.current = false;
      return;
    }
    if (actionsRevealed) {
      onRevealActions(false);
      return;
    }
    onSelect(thread.id);
  }

  function runAction(action: ((id: string) => void) | undefined) {
    onRevealActions(false);
    action?.(thread.id);
  }

  function runThreadAction(action: ((thread: CodexThread) => void) | undefined) {
    onRevealActions(false);
    action?.(thread);
  }

  return (
    <div
      className={`task-row-shell ${compact ? "task-row-shell-compact" : ""}`}
      data-selected={selected}
      data-actions-open={actionsRevealed}
      data-action-count={actions.length}
      onPointerDown={beginSwipe}
      onPointerUp={finishSwipe}
      onPointerCancel={() => { pointerStart.current = undefined; }}
    >
      {hasActions ? (
        <div className="task-row-actions" aria-hidden={!actionsRevealed}>
          {onRename ? (
            <button
              type="button"
              tabIndex={actionsRevealed ? 0 : -1}
              aria-label={`重命名 ${thread.title}`}
              onClick={() => runThreadAction(onRename)}
            >重命名</button>
          ) : null}
          {onTogglePin ? (
            <button
              type="button"
              tabIndex={actionsRevealed ? 0 : -1}
              aria-label={`${pinned ? "取消置顶" : "置顶"} ${thread.title}`}
              onClick={() => runAction(onTogglePin)}
            >{pinned ? "取消置顶" : "置顶"}</button>
          ) : null}
          {onArchive ? (
            <button
              type="button"
              className="archive-action"
              tabIndex={actionsRevealed ? 0 : -1}
              aria-label={`归档 ${thread.title}`}
              onClick={() => runAction(onArchive)}
            >归档</button>
          ) : null}
          {onUnarchive ? (
            <button
              type="button"
              tabIndex={actionsRevealed ? 0 : -1}
              aria-label={`取消归档 ${thread.title}`}
              onClick={() => runAction(onUnarchive)}
            >取消归档</button>
          ) : null}
          {onDelete ? (
            <button
              type="button"
              className="delete-action"
              tabIndex={actionsRevealed ? 0 : -1}
              aria-label={`删除 ${thread.title}`}
              onClick={() => runThreadAction(onDelete)}
            >删除</button>
          ) : null}
        </div>
      ) : null}
      <div className="task-row-content">
        <button
          type="button"
          className={`task-row-main ${compact ? "task-row-compact" : ""}`}
          onClick={selectConversation}
          disabled={archived}
          aria-label={`${thread.title}，${statusLabel(thread.status)}`}
        >
          <span className={`status-dot status-${thread.status}`} aria-hidden="true" />
          <span className="task-copy">
            <strong>{thread.title}</strong>
            {!compact ? (
              <span>{
                isDirectThread(thread, directCwd) || (desktopProjectsAvailable && !thread.projectId)
                  ? "直接对话"
                  : thread.projectName ?? projectName(thread.cwd)
              }</span>
            ) : null}
          </span>
          <span className="task-time">{formatUpdatedAt(thread.updatedAt)}</span>
        </button>
        {hasActions ? (
          <button
            type="button"
            className="task-row-more"
            aria-label={`对话操作 ${thread.title}`}
            aria-expanded={actionsRevealed}
            onClick={() => onRevealActions(!actionsRevealed)}
          >•••</button>
        ) : null}
      </div>
    </div>
  );
}

export function projectsFromThreads(threads: CodexThread[], directCwd?: string) {
  return groupProjects(threads, directCwd).map(({ cwd, name }) => ({ cwd, name }));
}

function groupProjects(threads: CodexThread[], directCwd?: string): ProjectGroup[] {
  const hasDesktopProjects = threads.some((thread) => Boolean(thread.projectId));
  const groups = new Map<string, CodexThread[]>();
  for (const thread of threads) {
    if (!thread.cwd || isDirectThread(thread, directCwd)) continue;
    if (hasDesktopProjects && !thread.projectId) continue;
    const key = thread.projectId ?? thread.cwd;
    const group = groups.get(key) ?? [];
    group.push(thread);
    groups.set(key, group);
  }
  return [...groups.entries()].map(([key, projectThreads]) => ({
    key,
    cwd: projectThreads[0].projectRootPaths?.[0] ?? projectThreads[0].cwd ?? key,
    name: projectThreads[0].projectName ?? projectName(projectThreads[0].cwd),
    threads: projectThreads,
    status: projectThreads.some((thread) => thread.status === "running")
      ? "running"
      : projectThreads.some((thread) => thread.status === "error")
        ? "error"
        : "idle",
  }));
}

export function isDirectThread(thread: CodexThread, directCwd?: string) {
  if (!thread.cwd) return true;
  if (directCwd && thread.cwd === directCwd) return true;
  return thread.cwd.replaceAll("\\", "/").includes("/Documents/Codex/");
}

function isPinnedThread(thread: CodexThread) {
  return thread.sectionName?.toLocaleLowerCase() === "pinned";
}

function projectName(path?: string) {
  if (!path) return "";
  return path.split("/").filter(Boolean).at(-1) ?? path;
}

function statusLabel(status: ThreadStatus) {
  if (status === "running") return "运行中";
  if (status === "idle") return "空闲";
  if (status === "error") return "出错";
  return "状态未知";
}

function formatUpdatedAt(value?: number) {
  if (!value) return "";
  const milliseconds = value < 1_000_000_000_000 ? value * 1_000 : value;
  return new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" }).format(
    new Date(milliseconds),
  );
}
