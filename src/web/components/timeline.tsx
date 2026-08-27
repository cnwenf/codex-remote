import { useEffect, useState } from "react";
import Markdown from "react-markdown";
import remarkGfm from "remark-gfm";
import type { CodexItem, CodexThread, CodexTurn } from "../../protocol/thread-store";

type ImageRequest = { baseUrl: string; token: string };

export function Timeline({
  thread,
  imageRequest,
  onOpenExternalUrl,
}: {
  thread?: CodexThread;
  imageRequest?: ImageRequest;
  onOpenExternalUrl?: (url: string) => void;
}) {
  if (!thread) {
    return (
      <div className="empty-thread">
        <span aria-hidden="true">⌁</span>
        <h2>选择一个对话</h2>
        <p>查看运行状态、执行过程和最终回复。</p>
      </div>
    );
  }

  if (thread.turnOrder.length === 0) {
    return (
      <div className="empty-thread">
        <span aria-hidden="true">↗</span>
        <h2>可以开始了</h2>
        <p>在下方输入第一条指令。</p>
      </div>
    );
  }

  const typingTurnId = thread.activeTurnId && thread.turns[thread.activeTurnId]?.status === "inProgress"
    ? thread.activeTurnId
    : [...thread.turnOrder].reverse().find((turnId) => thread.turns[turnId]?.status === "inProgress");
  const liveTurnId = thread.status === "running" ? typingTurnId ?? thread.turnOrder.at(-1) : undefined;

  return (
    <ol className="timeline" aria-label="对话内容">
      {thread.turnOrder.map((turnId) => {
        const turn = thread.turns[turnId];
        return turn ? (
          <TurnView
            key={turnId}
            turn={turn}
            imageRequest={imageRequest}
            onOpenExternalUrl={onOpenExternalUrl}
            showTyping={turnId === liveTurnId}
          />
        ) : null;
      })}
      {thread.status === "running" && !liveTurnId ? (
        <li className="conversation-turn conversation-turn-recovering" data-turn-id="recovering-active-turn">
          <TypingIndicator />
        </li>
      ) : null}
    </ol>
  );
}

function TurnView({
  turn,
  imageRequest,
  showTyping,
  onOpenExternalUrl,
}: {
  turn: CodexTurn;
  imageRequest?: ImageRequest;
  showTyping: boolean;
  onOpenExternalUrl?: (url: string) => void;
}) {
  const items = turn.itemOrder.map((id) => turn.items[id]).filter(Boolean);
  const segments = segmentItems(items);
  const completedLayout = showTyping ? undefined : completedTurnLayout(segments, turn.status);

  if (completedLayout) {
    return (
      <li className="conversation-turn" data-turn-id={turn.id}>
        {completedLayout.leading.map((segment) => (
          <MessageSegment
            key={segment.item.id}
            segment={segment}
            imageRequest={imageRequest}
            onOpenExternalUrl={onOpenExternalUrl}
          />
        ))}
        {completedLayout.process.length > 0 ? (
          <details className="activity-group turn-process-group">
            <summary>
              <span className={`run-indicator run-${turn.status === "failed" ? "failed" : "completed"}`} aria-hidden="true" />
              <span>执行过程（{segmentItemCount(completedLayout.process)} 项）</span>
              <span className="activity-duration">{formatDuration(turn.durationMs)}</span>
            </summary>
            <div className="turn-process-content">
              {completedLayout.process.map((segment) => (
                segment.kind === "activity" ? (
                  <ol className="activity-list" key={segment.key}>
                    {segment.items.map((item) => <ActivityItem key={item.id} item={item} />)}
                  </ol>
                ) : (
                  <MessageSegment
                    key={segment.item.id}
                    segment={segment}
                    imageRequest={imageRequest}
                    onOpenExternalUrl={onOpenExternalUrl}
                  />
                )
              ))}
            </div>
          </details>
        ) : null}
        {completedLayout.final ? (
          <MessageSegment
            segment={completedLayout.final}
            imageRequest={imageRequest}
            onOpenExternalUrl={onOpenExternalUrl}
          />
        ) : null}
      </li>
    );
  }

  return (
    <li className="conversation-turn" data-turn-id={turn.id}>
      {segments.map((segment, segmentIndex) => {
        if (segment.kind === "activity") {
          const hasLaterOutput = segments.slice(segmentIndex + 1).some((candidate) => candidate.kind !== "activity");
          const explicitlyRunning = segment.items.some((item) => item.status === "running" || item.status === "inProgress");
          const activityRunning = !hasLaterOutput && turn.status === "inProgress" && (
            explicitlyRunning || segment.items.some((item) => item.status === undefined)
          );
          return (
            <details key={segment.key} className="activity-group">
              <summary>
                <span className={`run-indicator run-${activityRunning ? "inProgress" : "completed"}`} aria-hidden="true" />
                <span>执行过程（{segment.items.length} 项）</span>
                <span className="activity-duration">{formatDuration(turn.durationMs)}</span>
              </summary>
              <ol className="activity-list">
                {segment.items.map((item) => <ActivityItem key={item.id} item={item} />)}
              </ol>
            </details>
          );
        }
        return (
          <MessageSegment
            key={segment.item.id}
            segment={segment}
            imageRequest={imageRequest}
            onOpenExternalUrl={onOpenExternalUrl}
          />
        );
      })}

      {showTyping ? (
        <TypingIndicator />
      ) : null}
    </li>
  );
}

function TypingIndicator() {
  return (
    <div className="typing-indicator" role="status" aria-label="Codex 仍在输出">
      <span className="typing-dot" aria-hidden="true" />
      <span className="typing-dot" aria-hidden="true" />
      <span className="typing-dot" aria-hidden="true" />
    </div>
  );
}

function MessageSegment({
  segment,
  imageRequest,
  onOpenExternalUrl,
}: {
  segment: Extract<TurnSegment, { kind: "user" | "agent" }>;
  imageRequest?: ImageRequest;
  onOpenExternalUrl?: (url: string) => void;
}) {
  const item = segment.item;
  if (segment.kind === "user") {
    return (
      <article className="message message-user" data-user-message="true">
        <span className="message-author">你</span>
        <MarkdownContent text={item.text || "等待输入…"} onOpenExternalUrl={onOpenExternalUrl} />
        {item.imageIds?.length ? (
          <div className="message-images">
            {item.imageIds.map((imageId, index) => (
              <AuthenticatedImage
                key={`${imageId}-${index}`}
                imageId={imageId}
                request={imageRequest}
                alt={`用户上传的图片 ${index + 1}`}
              />
            ))}
          </div>
        ) : null}
      </article>
    );
  }
  return (
    <article className="message message-agent">
      <span className="message-author">Codex</span>
      <MarkdownContent text={item.text || "等待输出…"} onOpenExternalUrl={onOpenExternalUrl} />
    </article>
  );
}

function AuthenticatedImage({ imageId, request, alt }: { imageId: string; request?: ImageRequest; alt: string }) {
  const fallback = `/api/images/${encodeURIComponent(imageId)}`;
  const [source, setSource] = useState(request ? undefined : fallback);
  useEffect(() => {
    if (!request) { setSource(fallback); return; }
    let disposed = false;
    let objectUrl: string | undefined;
    void fetch(`${request.baseUrl}/api/images/${encodeURIComponent(imageId)}`, {
      headers: { authorization: `Bearer ${request.token}` },
    }).then((response) => {
      if (!response.ok) throw new Error("image-download-failed");
      return response.blob();
    }).then((blob) => {
      if (disposed) return;
      objectUrl = URL.createObjectURL(blob);
      setSource(objectUrl);
    }).catch(() => undefined);
    return () => {
      disposed = true;
      if (objectUrl) URL.revokeObjectURL(objectUrl);
    };
  }, [fallback, imageId, request?.baseUrl, request?.token]);
  return source ? <img src={source} alt={alt} loading="lazy" /> : <span className="image-loading">正在加载图片…</span>;
}

type TurnSegment =
  | { kind: "user" | "agent"; item: CodexItem }
  | { kind: "activity"; key: string; items: CodexItem[] };

type MessageTurnSegment = Extract<TurnSegment, { kind: "user" | "agent" }>;

function completedTurnLayout(segments: TurnSegment[], status: CodexTurn["status"]) {
  if (status === "inProgress" || status === "unknown") return undefined;
  let finalIndex = -1;
  for (let index = segments.length - 1; index >= 0; index -= 1) {
    if (segments[index].kind !== "agent") continue;
    finalIndex = index;
    break;
  }
  let processStart = 0;
  while (processStart < segments.length && segments[processStart].kind === "user") processStart += 1;
  const process = segments.filter((_, index) => index >= processStart && index !== finalIndex);
  return {
    leading: segments.slice(0, processStart) as MessageTurnSegment[],
    process,
    final: finalIndex >= 0 ? segments[finalIndex] as MessageTurnSegment : undefined,
  };
}

function segmentItemCount(segments: TurnSegment[]) {
  return segments.reduce((count, segment) => count + (segment.kind === "activity" ? segment.items.length : 1), 0);
}

function segmentItems(items: CodexItem[]): TurnSegment[] {
  const segments: TurnSegment[] = [];
  for (const item of items) {
    if (item.type === "todoList" || item.type === "todo-list") continue;
    const value = item.type.toLocaleLowerCase();
    if (value.includes("user")) {
      segments.push({ kind: "user", item });
      continue;
    }
    if (value.includes("agentmessage")) {
      segments.push({ kind: "agent", item });
      continue;
    }
    const previous = segments.at(-1);
    if (previous?.kind === "activity") previous.items.push(item);
    else segments.push({ kind: "activity", key: `activity-${item.id}`, items: [item] });
  }
  return segments;
}

export function TodoListDock({ todoList }: { todoList?: CodexThread["todoList"] }) {
  const [open, setOpen] = useState(false);
  if (
    !todoList ||
    todoList.items.length === 0 ||
    todoList.items.every((item) => item.status === "completed")
  ) return null;

  const completed = todoList.items.filter((item) => item.status === "completed").length;
  const activeIndex = todoList.items.findIndex((item) => item.status !== "completed");
  const current = activeIndex + 1;

  return (
    <div className="todo-list-dock">
      <button
        type="button"
        className="todo-list-trigger"
        aria-label={`任务进度，第 ${current}/${todoList.items.length} 步`}
        aria-expanded={open}
        onClick={() => setOpen((value) => !value)}
      >
        <span className="run-indicator run-inProgress" aria-hidden="true" />
        第 {current}/{todoList.items.length} 步
      </button>
      {open ? (
        <section className="todo-list-popover" aria-label={`任务进度，${completed}/${todoList.items.length} 已完成`}>
          <header>
            <strong>任务进度</strong>
            <span>{completed}/{todoList.items.length}</span>
          </header>
          {todoList.explanation ? <p>{todoList.explanation}</p> : null}
          <ol>
            {todoList.items.map((item, index) => (
              <li className={`todo-item todo-${item.status}`} key={`${item.step}-${index}`}>
                <span className="todo-status" aria-hidden="true">
                  {item.status === "completed" ? "✓" : item.status === "inProgress" ? "●" : "○"}
                </span>
                <span>{item.step}</span>
              </li>
            ))}
          </ol>
        </section>
      ) : null}
    </div>
  );
}

function MarkdownContent({ text, onOpenExternalUrl }: { text: string; onOpenExternalUrl?: (url: string) => void }) {
  return (
    <div className="markdown-body">
      <Markdown
        remarkPlugins={[remarkGfm]}
        components={{
          a: ({ children, href, ...props }) => {
            const external = href && /^https?:\/\//i.test(href);
            return (
              <a
                {...props}
                href={href}
                target="_blank"
                rel="noreferrer noopener"
                onClick={external && onOpenExternalUrl ? (event) => {
                  event.preventDefault();
                  onOpenExternalUrl(href);
                } : undefined}
              >
                {children}
              </a>
            );
          },
        }}
      >
        {text}
      </Markdown>
    </div>
  );
}

function ActivityItem({ item }: { item: CodexItem }) {
  return (
    <li>
      <span className="activity-icon" aria-hidden="true">{iconForType(item.type)}</span>
      <span className="activity-copy">
        <strong>{labelForType(item.type)}</strong>
        <span>{item.text || "等待结果…"}</span>
      </span>
      {item.status ? <span className="activity-status">{statusLabel(item.status)}</span> : null}
    </li>
  );
}

function labelForType(type: string) {
  const value = type.toLocaleLowerCase();
  if (value.includes("reason")) return "思考";
  if (value.includes("command")) return "运行命令";
  if (value.includes("file")) return "文件变更";
  if (value.includes("websearch")) return "网页搜索";
  if (value.includes("mcp") || value.includes("tool")) return "调用工具";
  if (value.includes("plan")) return "更新计划";
  if (value.includes("compaction")) return "整理上下文";
  return type.replace(/([a-z])([A-Z])/g, "$1 $2");
}

function iconForType(type: string) {
  const value = type.toLocaleLowerCase();
  if (value.includes("command")) return ">";
  if (value.includes("file")) return "±";
  if (value.includes("search")) return "⌕";
  if (value.includes("reason")) return "·";
  return "•";
}

function statusLabel(status: string) {
  if (status === "completed") return "完成";
  if (status === "running" || status === "inProgress") return "运行中";
  if (status === "failed") return "失败";
  return status;
}

function formatDuration(value?: number) {
  if (value === undefined) return "";
  if (value < 1_000) return `${value} 毫秒`;
  const seconds = Math.round(value / 1_000);
  if (seconds < 60) return `${seconds} 秒`;
  return `${Math.floor(seconds / 60)} 分 ${seconds % 60} 秒`;
}
