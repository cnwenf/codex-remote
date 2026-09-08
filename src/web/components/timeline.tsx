import { createContext, useContext, useEffect, useState, type ComponentPropsWithoutRef } from "react";
import { createPortal } from "react-dom";
import Markdown, { defaultUrlTransform } from "react-markdown";
import remarkGfm from "remark-gfm";
import type { CodexItem, CodexThread, CodexTurn } from "../../protocol/thread-store";
import { messageKind } from "../../protocol/message-content";
import { isToolActivity, MAX_TOOL_OUTPUT_IMAGES } from "../../protocol/tool-content";
import { remarkAssistantPresentation } from "./assistant-presentation";

type ImageRequest = { baseUrl: string; token: string };
type ImagePreview = { source: string; alt: string };
type MarkdownImageContextValue = {
  assistant?: boolean;
  localImages?: Record<string, string>;
  imageRequest?: ImageRequest;
  onPreviewImage?: (preview: ImagePreview) => void;
  onOpenExternalUrl?: (url: string) => void;
};

const MarkdownImageContext = createContext<MarkdownImageContextValue>({});

export function Timeline({
  thread,
  loading = false,
  loadFailed = false,
  imageRequest,
  onOpenExternalUrl,
}: {
  thread?: CodexThread;
  loading?: boolean;
  loadFailed?: boolean;
  imageRequest?: ImageRequest;
  onOpenExternalUrl?: (url: string) => void;
}) {
  const [imagePreview, setImagePreview] = useState<ImagePreview>();
  useEffect(() => setImagePreview(undefined), [thread?.id, imageRequest?.baseUrl, imageRequest?.token]);

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
    if (loadFailed) return null;
    if (loading) return <div className="empty-thread" role="status">正在加载对话…</div>;
    if (thread.toolOutputWarning) return <p className="history-tool-warning" role="status">{thread.toolOutputWarning}</p>;
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
    <>
      {thread.toolOutputWarning ? <p className="history-tool-warning" role="status">{thread.toolOutputWarning}</p> : null}
      <ol className="timeline" aria-label="对话内容">
        {thread.turnOrder.map((turnId) => {
          const turn = thread.turns[turnId];
          return turn ? (
            <TurnView
              key={turnId}
              turn={turn}
              imageRequest={imageRequest}
              onPreviewImage={setImagePreview}
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
      {imagePreview ? <ImagePreviewDialog preview={imagePreview} onClose={() => setImagePreview(undefined)} /> : null}
    </>
  );
}

function TurnView({
  turn,
  imageRequest,
  showTyping,
  onPreviewImage,
  onOpenExternalUrl,
}: {
  turn: CodexTurn;
  imageRequest?: ImageRequest;
  showTyping: boolean;
  onPreviewImage: (preview: ImagePreview) => void;
  onOpenExternalUrl?: (url: string) => void;
}) {
  const items = turn.itemOrder.map((id) => turn.items[id]).filter(Boolean);
  const segments = segmentItems(items);

  return (
    <li className="conversation-turn" data-turn-id={turn.id}>
      {segments.map((segment, segmentIndex) => {
        if (segment.kind === "activity") {
          const anchorItem = indexedActivityAnchor(segment.items);
          const hasLaterOutput = segments.slice(segmentIndex + 1).some((candidate) => candidate.kind !== "activity");
          const explicitlyRunning = segment.items.some((item) => item.status === "running" || item.status === "inProgress");
          const activityRunning = !hasLaterOutput && turn.status === "inProgress" && (
            explicitlyRunning || segment.items.some((item) => item.status === undefined)
          );
          return (
            <details key={segment.key} className="activity-group"
              data-question-anchor={anchorItem ? "true" : undefined}
              data-turn-id={turn.id} data-anchor-item-id={anchorItem?.id}>
              <summary>
                <span className={`run-indicator run-${activityRunning ? "inProgress" : "completed"}`} aria-hidden="true" />
                <span>执行过程（{segment.items.length} 项）</span>
                <span className="activity-duration">{formatDuration(turn.durationMs)}</span>
              </summary>
              <ol className="activity-list">
                {segment.items.map((item) => <ActivityItem key={item.id} item={item} imageRequest={imageRequest} onPreviewImage={onPreviewImage} />)}
              </ol>
            </details>
          );
        }
        return (
          <MessageSegment
            key={segment.item.id}
            segment={segment}
            turnId={turn.id}
            imageRequest={imageRequest}
            onPreviewImage={onPreviewImage}
            onOpenExternalUrl={onOpenExternalUrl}
          />
        );
      })}

      {turn.status === "failed" ? (
        <article className="message message-agent" role="alert">
          <span className="message-author">本轮执行失败</span>
          <p className="inline-error">{turn.error?.message || "未收到错误详情。"}</p>
          {turn.error?.additionalDetails ? <p className="inline-error">{turn.error.additionalDetails}</p> : null}
        </article>
      ) : null}

      {turn.status === "interrupted" ? <p className="turn-stopped">本轮已停止</p> : null}

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
  turnId,
  imageRequest,
  onPreviewImage,
  onOpenExternalUrl,
}: {
  segment: Extract<TurnSegment, { kind: "user" | "agent" | "delegated" }>;
  turnId: string;
  imageRequest?: ImageRequest;
  onPreviewImage: (preview: ImagePreview) => void;
  onOpenExternalUrl?: (url: string) => void;
}) {
  const item = segment.item;
  if (segment.kind === "delegated") return (
    <article className="message message-delegated" data-delegated-input="true"
      data-turn-id={turnId} data-item-id={item.id}>
      <span className="message-author" title={item.sourceThreadId}>来自任务 {item.sourceThreadId?.slice(0, 8) ?? "未知来源"}</span>
      <div className="delegated-input-text">{item.text}</div>
    </article>
  );
  if (segment.kind === "user") {
    return (
      <article className="message message-user" data-user-message="true"
        data-turn-id={turnId} data-item-id={item.id}>
        <span className="message-author">你</span>
        {item.text ? <MarkdownContent text={item.text} onOpenExternalUrl={onOpenExternalUrl} /> : null}
        {item.imageIds?.length ? (
          <div className="message-images">
            {item.imageIds.map((imageId, index) => (
              <AuthenticatedImage
                key={`${imageId}-${index}`}
                imageId={imageId}
                request={imageRequest}
                alt={`用户上传的图片 ${index + 1}`}
                onPreview={onPreviewImage}
              />
            ))}
          </div>
        ) : null}
      </article>
    );
  }
  return (
    <article className="message message-agent" data-question-anchor="true"
      data-turn-id={turnId} data-anchor-item-id={item.id}>
      <span className="message-author">Codex</span>
      <MarkdownContent text={item.text || "等待输出…"} assistant onOpenExternalUrl={onOpenExternalUrl}
        localImages={item.localImages} imageRequest={imageRequest} onPreviewImage={onPreviewImage} />
    </article>
  );
}

function AuthenticatedImage({
  imageId,
  request,
  alt,
  onPreview,
}: {
  imageId: string;
  request?: ImageRequest;
  alt: string;
  onPreview: (preview: ImagePreview) => void;
}) {
  const fallback = `/api/images/${encodeURIComponent(imageId)}`;
  const [source, setSource] = useState(request ? undefined : fallback);
  const [failed, setFailed] = useState(false);
  useEffect(() => {
    setFailed(false);
    if (!request) { setSource(fallback); return; }
    setSource(undefined);
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
    }).catch(() => { if (!disposed) setFailed(true); });
    return () => {
      disposed = true;
      if (objectUrl && typeof URL.revokeObjectURL === "function") URL.revokeObjectURL(objectUrl);
    };
  }, [fallback, imageId, request?.baseUrl, request?.token]);
  if (failed) return <span className="image-error">图片加载失败：{alt}</span>;
  return source ? (
    <button
      type="button"
      className="message-image-link"
      aria-label={`预览${alt}`}
      onPointerDown={(event) => event.stopPropagation()}
      onClick={(event) => {
        event.preventDefault();
        event.stopPropagation();
        onPreview({ source, alt });
      }}
    >
      <img src={source} alt={alt} loading="lazy" onError={() => setFailed(true)} />
    </button>
  ) : <span className="image-loading">正在加载图片…</span>;
}

function ImagePreviewDialog({ preview, onClose }: { preview: ImagePreview; onClose: () => void }) {
  useEffect(() => {
    const closeOnEscape = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", closeOnEscape);
    return () => document.removeEventListener("keydown", closeOnEscape);
  }, [onClose]);
  return createPortal(
    <div
      className="image-preview-backdrop"
      role="dialog"
      aria-modal="true"
      aria-label={preview.alt}
      // Portal events still bubble through React's timeline parent. Preview
      // controls must not cancel following or collapse the underlying composer.
      onPointerDown={(event) => event.stopPropagation()}
      onClick={onClose}
    >
      <div className="image-preview-content" onClick={(event) => event.stopPropagation()}>
        <button
          type="button"
          className="image-preview-close"
          aria-label="关闭图片预览"
          onClick={onClose}
        >
          ×
        </button>
        <img src={preview.source} alt={`${preview.alt} 预览`} />
      </div>
    </div>,
    document.body,
  );
}

type TurnSegment =
  | { kind: "user" | "agent" | "delegated"; item: CodexItem }
  | { kind: "activity"; key: string; items: CodexItem[] };

type MessageTurnSegment = Extract<TurnSegment, { kind: "user" | "agent" | "delegated" }>;


function segmentItems(items: CodexItem[]): TurnSegment[] {
  const segments: TurnSegment[] = [];
  for (const item of items) {
    const kind = messageKind(item.type);
    if (kind === "plan") continue;
    if (kind === "user" || kind === "delegated") {
      segments.push({ kind, item });
      continue;
    }
    if (kind === "agent") {
      segments.push({ kind: "agent", item });
      continue;
    }
    const previous = segments.at(-1);
    if (previous?.kind === "activity") previous.items.push(item);
    else segments.push({ kind: "activity", key: `activity-${item.id}`, items: [item] });
  }
  return segments;
}

function indexedActivityAnchor(items: CodexItem[]) {
  return items.find((item) => {
    const type = item.type.replace(/[_-]/g, "").toLocaleLowerCase();
    return type === "reasoning" || type === "functioncall" || type === "customtoolcall" || type.endsWith("toolcall");
  });
}

export function TodoListDock({
  todoList,
  running,
}: {
  todoList?: CodexThread["todoList"];
  running: boolean;
}) {
  const [open, setOpen] = useState(false);
  if (
    !running ||
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

function MarkdownContent({ text, assistant, onOpenExternalUrl, localImages, imageRequest, onPreviewImage }: {
  text: string;
  assistant?: boolean;
  onOpenExternalUrl?: (url: string) => void;
  localImages?: Record<string, string>;
  imageRequest?: ImageRequest;
  onPreviewImage?: (preview: ImagePreview) => void;
}) {
  return (
    <div className="markdown-body">
      <MarkdownImageContext.Provider value={{ assistant, localImages, imageRequest, onPreviewImage, onOpenExternalUrl }}>
        <Markdown
          remarkPlugins={assistant ? [remarkGfm, remarkAssistantPresentation] : [remarkGfm]}
          urlTransform={(url, key, node) => node.tagName === "img" ? url : defaultUrlTransform(url)}
          components={{
            img: MarkdownImage,
            a: MarkdownLink,
          }}
        >
          {text}
        </Markdown>
      </MarkdownImageContext.Provider>
    </div>
  );
}

function MarkdownLink({ children, href, ...props }: ComponentPropsWithoutRef<"a">) {
  const { onOpenExternalUrl } = useContext(MarkdownImageContext);
  if (!isSafeExternalUrl(href)) return <span data-invalid-link="true">{children}</span>;
  return <a {...props} href={href} target="_blank" rel="noreferrer noopener"
    onClick={onOpenExternalUrl ? (event) => {
      event.preventDefault();
      onOpenExternalUrl(href);
    } : undefined}>{children}</a>;
}

function MarkdownImage({ src, alt }: ComponentPropsWithoutRef<"img">) {
  const { assistant, localImages, imageRequest, onPreviewImage } = useContext(MarkdownImageContext);
  const source = typeof src === "string" ? src : "";
  const imageId = localImages && Object.hasOwn(localImages, source) ? localImages[source] : undefined;
  if (assistant && imageId && onPreviewImage) return <AuthenticatedImage imageId={imageId}
    request={imageRequest} alt={alt || "Codex 生成的图片"} onPreview={onPreviewImage} />;
  if (source.startsWith("https://") && isSafeExternalUrl(source)) return <img src={source} alt={alt} loading="lazy" referrerPolicy="no-referrer" />;
  return <span className="image-error">本机图片不可用：{alt || "图片"}</span>;
}

function isSafeExternalUrl(value?: string): value is string {
  if (!value) return false;
  try {
    const url = new URL(value);
    return Boolean(url.hostname) && (url.protocol === "http:" || url.protocol === "https:");
  } catch {
    return false;
  }
}

function ActivityItem({ item, imageRequest, onPreviewImage }: {
  item: CodexItem;
  imageRequest?: ImageRequest;
  onPreviewImage: (preview: ImagePreview) => void;
}) {
  const running = item.status === "running" || item.status === "inProgress";
  const imageView = item.type.replace(/[_-]/g, "").toLowerCase() === "imageview";
  const outputDescription = item.toolOutput === "" ? "结果正文为空"
    : item.toolOutput ?? (running ? "等待结果…" : "未收到结果正文");
  const description = imageView
    ? running ? "正在查看图片" : item.status === "completed" ? "已查看图片" : item.status === "failed" ? "查看图片失败" : "查看图片"
    : item.text || (item.toolOutput ? "已收到结果，展开查看" : outputDescription);
  return (
    <li data-item-id={item.id}>
      <span className="activity-icon" aria-hidden="true">{iconForType(item.type)}</span>
      <div className="activity-copy">
        <strong>{imageView ? "查看图片" : labelForType(item.type)}</strong>
        <span>{description}</span>
        {isToolActivity(item.type) ? <details className="tool-details">
          <summary>查看输入与结果</summary>
          <strong>输入</strong>
          <pre>{item.toolInput ?? "未收到输入正文"}</pre>
          {item.toolInputTruncated ? <p>已截断：显示前 {item.toolInput?.length ?? 0} 个字符{item.toolInputLength !== undefined ? `，原文 ${item.toolInputLength} 个字符` : ""}</p> : null}
          <strong>结果</strong>
          <pre>{outputDescription}</pre>
          {item.toolOutputImageIds?.length ? <div className="message-images">
            {item.toolOutputImageIds.map((imageId, index) => <AuthenticatedImage key={imageId} imageId={imageId}
              request={imageRequest} alt={`工具返回图片 ${index + 1}`} onPreview={onPreviewImage} />)}
          </div> : null}
          {item.toolOutputImagesIncomplete ? <p>部分工具图片不可用或超出限制（每项最多显示 {MAX_TOOL_OUTPUT_IMAGES} 张）。</p> : null}
          {item.toolOutputTruncated ? <p>已截断：显示前 {item.toolOutput?.length ?? 0} 个字符{item.toolOutputLength !== undefined ? `，原文 ${item.toolOutputLength} 个字符` : ""}</p> : null}
        </details> : null}
      </div>
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
