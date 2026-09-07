import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type UIEvent } from "react";
import type { CodexThread } from "../../protocol/thread-store";
import type { ThreadHistoryState } from "../state/use-codex";

const TOP_LOAD_THRESHOLD = 120;
const BOTTOM_FOLLOW_THRESHOLD = 120;

type ConversationViewportProps = {
  threadId: string;
  initialHistoryPending?: boolean;
  history: ThreadHistoryState;
  currentQuestion?: string;
  onLoadEarlier: () => Promise<void>;
  onInteract?: () => void;
  children: ReactNode;
};

type ScrollAnchor = { scrollHeight: number; scrollTop: number };

export function ConversationViewport({
  threadId,
  initialHistoryPending = false,
  history,
  currentQuestion,
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
  const pinnedQuestionRef = useRef<HTMLButtonElement>(null);
  const [pinnedQuestion, setPinnedQuestion] = useState<string>();
  const [questionExpanded, setQuestionExpanded] = useState(false);

  useEffect(() => {
    const viewport = viewportRef.current;
    const content = contentRef.current;
    if (!viewport || !content || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver(() => {
      if (followLatest.current && !prependAnchor.current) scrollToLatest(viewport);
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
      setPinnedQuestion(undefined);
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
    syncPinnedQuestion(viewport);
    requestEarlierIfNeeded(viewport, true);
  });

  useEffect(() => {
    if (!questionExpanded) return;
    const collapseOutside = (event: PointerEvent) => {
      if (pinnedQuestionRef.current?.contains(event.target as Node)) return;
      setQuestionExpanded(false);
    };
    document.addEventListener("pointerdown", collapseOutside);
    return () => document.removeEventListener("pointerdown", collapseOutside);
  }, [questionExpanded]);

  function syncPinnedQuestion(viewport: HTMLDivElement) {
    const prompts = viewport.querySelectorAll<HTMLElement>("[data-user-message='true']");
    const prompt = currentQuestion ? prompts.item(prompts.length - 1) : undefined;
    const aboveViewport = Boolean(
      prompt && prompt.getBoundingClientRect().bottom <= viewport.getBoundingClientRect().top,
    );
    setPinnedQuestion((current) => aboveViewport && currentQuestion
      ? currentQuestion
      : current === undefined ? current : undefined);
    if (!aboveViewport) setQuestionExpanded(false);
  }

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
    syncPinnedQuestion(viewport);
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
      {pinnedQuestion ? (
        <div className="pinned-user-question-layer">
          <button
            ref={pinnedQuestionRef}
            type="button"
            className={`pinned-user-question ${questionExpanded
              ? "pinned-user-question-expanded"
              : "pinned-user-question-collapsed"}`}
            aria-label={`${questionExpanded ? "收起" : "展开"}原始问题：${pinnedQuestion}`}
            aria-expanded={questionExpanded}
            onClick={() => setQuestionExpanded((current) => !current)}
          >
            <span>{pinnedQuestion}</span>
          </button>
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

export function currentThreadQuestion(thread: CodexThread) {
  const turnId = thread.status === "running"
    ? thread.activeTurnId && thread.turns[thread.activeTurnId]
      ? thread.activeTurnId
      : undefined
    : thread.turnOrder.at(-1);
  const turn = turnId ? thread.turns[turnId] : undefined;
  if (!turn) return undefined;
  for (let index = turn.itemOrder.length - 1; index >= 0; index -= 1) {
    const item = turn.items[turn.itemOrder[index]];
    if (item?.type.toLocaleLowerCase().includes("user") && item.text.trim()) return item.text.trim();
  }
  return undefined;
}
