import { useMemo, useState } from "react";
import type { CodexThread, ThreadStatus } from "../../protocol/thread-store";

type TaskListProps = {
  threads: CodexThread[];
  directCwd?: string;
  selectedId?: string;
  onSelect: (id: string) => void;
  onNew: () => void;
  onTogglePin?: (id: string) => void;
};

type ProjectGroup = {
  cwd: string;
  name: string;
  threads: CodexThread[];
  status: ThreadStatus;
};

export function TaskList({
  threads,
  directCwd,
  selectedId,
  onSelect,
  onNew,
  onTogglePin,
}: TaskListProps) {
  const [query, setQuery] = useState("");
  const [expandedProjects, setExpandedProjects] = useState<Set<string>>(() => new Set());
  const filtered = useMemo(() => {
    const needle = query.trim().toLocaleLowerCase();
    if (!needle) return threads;
    return threads.filter((thread) =>
      `${thread.title} ${thread.cwd ?? ""}`.toLocaleLowerCase().includes(needle),
    );
  }, [query, threads]);
  const pinned = filtered.filter(isPinnedThread);
  const unpinned = filtered.filter((thread) => !isPinnedThread(thread));
  const projects = useMemo(() => groupProjects(unpinned, directCwd), [directCwd, unpinned]);
  const recent = unpinned.filter((thread) => isDirectThread(thread, directCwd));

  function toggleProject(cwd: string) {
    setExpandedProjects((current) => {
      const next = new Set(current);
      if (next.has(cwd)) next.delete(cwd);
      else next.add(cwd);
      return next;
    });
  }

  return (
    <nav className="task-nav" aria-label="对话导航">
      <div className="section-heading">
        <div>
          <p className="eyebrow">Codex</p>
          <h2>对话</h2>
        </div>
        <button className="icon-button" type="button" onClick={onNew} aria-label="新对话">
          <span aria-hidden="true">＋</span>
        </button>
      </div>

      <label className="search-field">
        <span className="visually-hidden">搜索对话</span>
        <span aria-hidden="true">⌕</span>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          placeholder="搜索对话"
        />
      </label>

      <div className="task-list" data-testid="task-list-scroll">
        {filtered.length === 0 ? (
          <p className="empty-list">{threads.length === 0 ? "还没有对话" : "没有匹配的对话"}</p>
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
                    directCwd={directCwd}
                  />
                )) : <p className="empty-section">暂无置顶对话</p>}
              </div>
            </section>

            <section className="nav-section project-section" aria-labelledby="project-heading">
              <h3 id="project-heading">项目</h3>
              <div className="project-list">
                {projects.map((project) => {
                  const expanded = Boolean(query.trim()) || expandedProjects.has(project.cwd) ||
                    project.threads.some((thread) => thread.id === selectedId);
                  return (
                    <div className="project-group" key={project.cwd}>
                      <button
                        type="button"
                        className="project-row"
                        aria-expanded={expanded}
                        aria-label={`${project.name}，${project.threads.length} 个对话，${statusLabel(project.status)}`}
                        onClick={() => toggleProject(project.cwd)}
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
                              directCwd={directCwd}
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
                    directCwd={directCwd}
                  />
                )) : <p className="empty-section">暂无直接对话</p>}
              </div>
            </section>
          </>
        )}
      </div>
    </nav>
  );
}

function ConversationRow({
  thread,
  selected,
  onSelect,
  onTogglePin,
  compact = false,
  directCwd,
}: {
  thread: CodexThread;
  selected: boolean;
  onSelect: (id: string) => void;
  onTogglePin?: (id: string) => void;
  compact?: boolean;
  directCwd?: string;
}) {
  const pinned = isPinnedThread(thread);
  return (
    <div className={`task-row-shell ${compact ? "task-row-shell-compact" : ""}`} data-selected={selected}>
    <button
      type="button"
      className={`task-row-main ${compact ? "task-row-compact" : ""}`}
      onClick={() => onSelect(thread.id)}
      aria-label={`${thread.title}，${statusLabel(thread.status)}`}
    >
      <span className={`status-dot status-${thread.status}`} aria-hidden="true" />
      <span className="task-copy">
        <strong>{thread.title}</strong>
        {!compact ? (
          <span>{isDirectThread(thread, directCwd) ? "直接对话" : projectName(thread.cwd)}</span>
        ) : null}
      </span>
      <span className="task-time">{formatUpdatedAt(thread.updatedAt)}</span>
    </button>
    {onTogglePin ? (
      <button
        type="button"
        className="pin-button"
        aria-label={`${pinned ? "取消置顶" : "置顶"} ${thread.title}`}
        aria-pressed={pinned}
        onClick={() => onTogglePin(thread.id)}
      >
        <span aria-hidden="true">{pinned ? "●" : "○"}</span>
      </button>
    ) : null}
    </div>
  );
}

export function projectsFromThreads(threads: CodexThread[], directCwd?: string) {
  return groupProjects(threads, directCwd).map(({ cwd, name }) => ({ cwd, name }));
}

function groupProjects(threads: CodexThread[], directCwd?: string): ProjectGroup[] {
  const groups = new Map<string, CodexThread[]>();
  for (const thread of threads) {
    if (!thread.cwd || isDirectThread(thread, directCwd)) continue;
    const group = groups.get(thread.cwd) ?? [];
    group.push(thread);
    groups.set(thread.cwd, group);
  }
  return [...groups.entries()].map(([cwd, projectThreads]) => ({
    cwd,
    name: projectName(cwd),
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
