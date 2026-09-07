import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type UIEvent } from "react";
import { useQuestionContext, type QuestionAnchor, type ReadQuestionContext } from "../state/use-question-context";
import type { ConnectionState, ThreadHistoryState } from "../state/use-codex";

const TOP_LOAD_THRESHOLD = 120;
const BOTTOM_FOLLOW_THRESHOLD = 120;

type ConversationViewportProps = {
  threadId: string;
  initialHistoryPending?: boolean;
  history: ThreadHistoryState;
  connection?: ConnectionState;
  readQuestionContext?: ReadQuestionContext;
  onLoadEarlier: () => Promise<void>;
  onInteract?: () => void;
  children: ReactNode;
};

type ScrollAnchor = { scrollHeight: number; scrollTop: number };

export function ConversationViewport({
  threadId,
  initialHistoryPending = false,
  history,
  connection = "disconnected",
  readQuestionContext = unavailableQuestionContext,
  onLoadEarlier,
  onInteract,
  children,
}: ConversationViewportProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const contentRef = useRef<HTMLDivElement>(null);
  const mountedThreadId = useRef<string | undefined>(undefined);
  const followLatest = useRef(true);
  const lastScrollTop = useRef(0);
  const prependAnchor = useRef<ScrollAnchor | undefined>(undefined);
  const pinnedLayerRef = useRef<HTMLDivElement>(null);
  const [visibleAnchor, setVisibleAnchor] = useState<QuestionAnchor>();
  const [questionSourceVisible, setQuestionSourceVisible] = useState(false);
  const [questionExpanded, setQuestionExpanded] = useState(false);
  const question = useQuestionContext({ threadId, anchor: visibleAnchor, connection, readQuestionContext });
  const questionId = question.context?.question?.id;
  const questionIdentity = question.context?.state === "ready" && question.context.question
    ? [question.context.threadId, question.context.turnId, question.context.revision,
      question.context.question.id, question.context.question.source,
      question.context.question.sourceThreadId ?? ""].join("\u0000")
    : undefined;
  const expandedQuestionIdentity = useRef<string | undefined>(undefined);
  const syncVisibleAnchorRef = useRef<(viewport: HTMLDivElement) => void>(() => undefined);

  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (followLatest.current && !prependAnchor.current) scrollToLatest(viewport);
      syncVisibleAnchorRef.current(viewport);
    });
    // Images and native details resize after React's layout effect. Composer
    // expansion also changes the available viewport without a new message.
    observer.observe(content);
    observer.observe(viewport);
    return () => observer.disconnect();
  }, [threadId]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (mountedThreadId.current !== threadId) {
      mountedThreadId.current = threadId;
      followLatest.current = true;
      prependAnchor.current = undefined;
      scrollToLatest(viewport);
      setVisibleAnchor(undefined);
      setQuestionSourceVisible(false);
      setQuestionExpanded(false);
      requestEarlierIfNeeded(viewport, true);
      return;
    }
    const anchor = prependAnchor.current;
    let restoredAnchor = false;
    if (anchor) {
      const addedHeight = viewport.scrollHeight - anchor.scrollHeight;
      if (addedHeight !== 0) {
        viewport.scrollTop = anchor.scrollTop + addedHeight;
        lastScrollTop.current = viewport.scrollTop;
        prependAnchor.current = undefined;
        restoredAnchor = true;
      } else if (!history.loading) {
        prependAnchor.current = undefined;
      }
      if (prependAnchor.current) return;
    }
    if (followLatest.current && !restoredAnchor) scrollToLatest(viewport);
    syncVisibleAnchor(viewport);
    requestEarlierIfNeeded(viewport, true);
  });

  useEffect(() => {
    if (!questionExpanded) return;
    const collapseOutside = (event: PointerEvent) => {
      if (pinnedLayerRef.current?.contains(event.target as Node)) return;
      setQuestionExpanded(false);
    };
    document.addEventListener("pointerdown", collapseOutside);
    return () => document.removeEventListener("pointerdown", collapseOutside);
  }, [questionExpanded]);

  useEffect(() => {
    if (!questionIdentity) return;
    if (expandedQuestionIdentity.current && expandedQuestionIdentity.current !== questionIdentity) {
      setQuestionExpanded(false);
    }
    expandedQuestionIdentity.current = questionIdentity;
  }, [questionIdentity]);

  function syncVisibleAnchor(viewport: HTMLDivElement) {
    const viewportRect = viewport.getBoundingClientRect();
    const candidates = [...viewport.querySelectorAll<HTMLElement>("[data-question-anchor='true']")].flatMap((element) => {
      const turnId = element.dataset.turnId;
      if (!turnId) return [];
      const rect = element.getBoundingClientRect();
      return [{
        anchor: { turnId, ...(element.dataset.anchorItemId ? { anchorItemId: element.dataset.anchorItemId } : {}) },
        top: rect.top,
        bottom: rect.bottom,
      }];
    });
    const next = selectVisibleQuestionAnchor(candidates, viewportRect.top, viewportRect.bottom, followLatest.current);
    setVisibleAnchor((current) => sameAnchor(current, next) ? current : next);
    const sourceVisible = Boolean(questionId && [...viewport.querySelectorAll<HTMLElement>("[data-item-id]")]
      .some((element) => {
        if (element.dataset.itemId !== questionId) return false;
        const rect = element.getBoundingClientRect();
        return rect.bottom > viewportRect.top && rect.top < viewportRect.bottom;
      }));
    setQuestionSourceVisible((current) => current === sourceVisible ? current : sourceVisible);
    if (!next || sourceVisible) setQuestionExpanded(false);
  }
  syncVisibleAnchorRef.current = syncVisibleAnchor;

  function requestEarlierIfNeeded(viewport: HTMLDivElement, requireShortViewport = false) {
    if (
      (requireShortViewport && viewport.scrollHeight > viewport.clientHeight) ||
      !history.hasMoreBefore || history.loading || prependAnchor.current
    ) return;
    prependAnchor.current = {
      scrollHeight: viewport.scrollHeight,
      scrollTop: viewport.scrollTop,
    };
    void onLoadEarlier().catch(() => {
      prependAnchor.current = undefined;
    });
  }

  function scrollToLatest(viewport: HTMLDivElement) {
    viewport.scrollTop = viewport.scrollHeight;
    lastScrollTop.current = viewport.scrollTop;
  }

  function handleScroll(event: UIEvent<HTMLDivElement>) {
    const viewport = event.currentTarget;
    const distanceFromBottom = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
    // Image layout/scroll anchoring can dispatch scroll before ResizeObserver.
    // A growing bottom gap alone does not mean the reader scrolled upward.
    if (distanceFromBottom <= BOTTOM_FOLLOW_THRESHOLD) followLatest.current = true;
    else if (viewport.scrollTop < lastScrollTop.current) followLatest.current = false;
    lastScrollTop.current = viewport.scrollTop;
    syncVisibleAnchor(viewport);
    if (viewport.scrollTop <= TOP_LOAD_THRESHOLD) requestEarlierIfNeeded(viewport);
  }

  return (
    <div
      ref={viewportRef}
      className="timeline-scroll"
      data-testid="timeline-scroll"
      onScroll={handleScroll}
      onPointerDown={(event) => {
        if ((event.target as Element).closest("summary, button, a, input, textarea, select")) {
          followLatest.current = false;
          return;
        }
        onInteract?.();
      }}
    >
      {visibleAnchor && !questionSourceVisible ? (
        <div ref={pinnedLayerRef} className="pinned-user-question-layer">
          <div className="pinned-question-card" onPointerDown={(event) => event.stopPropagation()}>
            {question.context?.state === "ready" && question.context.question ? (
              <button
                type="button"
                className={`pinned-user-question ${questionExpanded
                  ? "pinned-user-question-expanded"
                  : "pinned-user-question-collapsed"}`}
                aria-label={`${questionExpanded ? "收起" : "展开"}原始问题：${question.text || `${question.context.question.imageCount} 张图片`}`}
                aria-expanded={questionExpanded}
                onClick={() => setQuestionExpanded((current) => {
                  if (!current && question.nextTextOffset !== undefined) void question.loadMore();
                  return !current;
                })}
              >
                <small>{question.context.question.source === "delegated" ? "委派问题" : "你的问题"}</small>
                <span>{question.text || `${question.context.question.imageCount} 张图片`}</span>
              </button>
            ) : (
              <div className="pinned-user-question pinned-question-status"
                role={question.context?.state === "error" ? "alert" : "status"}>
                {question.context?.state === "not_found"
                  ? "未找到对应的原始问题"
                  : question.context?.state === "error"
                    ? question.context.message || "原始问题定位失败"
                    : "正在定位原始问题…"}
              </div>
            )}
            {questionExpanded && question.nextTextOffset !== undefined ? (
              <button type="button" className="pinned-question-more" disabled={question.loadingMore}
                onClick={() => void question.loadMore()}>
                {question.loadingMore ? "正在加载更多…" : "继续展开原始问题"}
              </button>
            ) : null}
            {question.loadMoreError ? <span className="pinned-question-more-error" role="alert">{question.loadMoreError}</span> : null}
          </div>
        </div>
      ) : null}
      {!initialHistoryPending ? <div className="history-sentinel" role="status" aria-live="polite">
        {history.loading
          ? "正在加载更早内容…"
          : history.hasMoreBefore
            ? "继续向上滚动可加载更早内容"
            : "已显示最早内容"}
      </div> : null}
      <div ref={contentRef}>{children}</div>
    </div>
  );
}

export type QuestionAnchorGeometry = { anchor: QuestionAnchor; top: number; bottom: number };

export function selectVisibleQuestionAnchor(
  candidates: QuestionAnchorGeometry[],
  viewportTop: number,
  viewportBottom: number,
  preferLatest = false,
) {
  const visible = candidates
    .filter((candidate) => candidate.bottom > viewportTop && candidate.top < viewportBottom)
    .sort((left, right) => left.top - right.top);
  return (preferLatest ? visible.at(-1) : visible[0])?.anchor;
}

function sameAnchor(left?: QuestionAnchor, right?: QuestionAnchor) {
  return left?.turnId === right?.turnId && left?.anchorItemId === right?.anchorItemId;
}

async function unavailableQuestionContext(): Promise<never> {
  throw new Error("原始问题定位不可用");
}
