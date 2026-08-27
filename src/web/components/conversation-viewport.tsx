import { useEffect, useLayoutEffect, useRef, useState, type ReactNode, type UIEvent } from "react";
import type { CodexThread } from "../../protocol/thread-store";
import type { ThreadHistoryState } from "../state/use-codex";

const TOP_LOAD_THRESHOLD = 120;
const BOTTOM_FOLLOW_THRESHOLD = 120;

type ConversationViewportProps = {
  threadId: string;
  history: ThreadHistoryState;
  currentQuestion?: string;
  onLoadEarlier: () => Promise<void>;
  onInteract?: () => void;
  children: ReactNode;
};

type ScrollAnchor = { scrollHeight: number; scrollTop: number };

export function ConversationViewport({
  threadId,
  history,
  currentQuestion,
  onLoadEarlier,
  onInteract,
  children,
}: ConversationViewportProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const mountedThreadId = useRef<string | undefined>(undefined);
  const followLatest = useRef(true);
  const prependAnchor = useRef<ScrollAnchor | undefined>(undefined);
  const pinnedQuestionRef = useRef<HTMLButtonElement>(null);
  const [pinnedQuestion, setPinnedQuestion] = useState<string>();
  const [questionExpanded, setQuestionExpanded] = useState(false);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (mountedThreadId.current !== threadId) {
      mountedThreadId.current = threadId;
      followLatest.current = true;
      prependAnchor.current = undefined;
      viewport.scrollTop = viewport.scrollHeight;
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
        prependAnchor.current = undefined;
        restoredAnchor = true;
      } else if (!history.loading) {
        prependAnchor.current = undefined;
      }
      if (prependAnchor.current) return;
    }
    if (followLatest.current && !restoredAnchor) viewport.scrollTop = viewport.scrollHeight;
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

  function handleScroll(event: UIEvent<HTMLDivElement>) {
    const viewport = event.currentTarget;
    const distanceFromBottom = viewport.scrollHeight - viewport.clientHeight - viewport.scrollTop;
    followLatest.current = distanceFromBottom <= BOTTOM_FOLLOW_THRESHOLD;
    syncPinnedQuestion(viewport);
    if (viewport.scrollTop <= TOP_LOAD_THRESHOLD) requestEarlierIfNeeded(viewport);
  }

  return (
    <div
      ref={viewportRef}
      className="timeline-scroll"
      data-testid="timeline-scroll"
      onScroll={handleScroll}
      onPointerDown={onInteract}
    >
      {pinnedQuestion ? (
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
      ) : null}
      <div className="history-sentinel" role="status" aria-live="polite">
        {history.loading
          ? "正在加载更早内容…"
          : history.hasMoreBefore
            ? "继续向上滚动可加载更早内容"
            : "已显示最早内容"}
      </div>
      {children}
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
