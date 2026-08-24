import { useLayoutEffect, useRef, type ReactNode, type UIEvent } from "react";
import type { ThreadHistoryState } from "../state/use-codex";

const TOP_LOAD_THRESHOLD = 120;
const BOTTOM_FOLLOW_THRESHOLD = 120;

type ConversationViewportProps = {
  threadId: string;
  history: ThreadHistoryState;
  onLoadEarlier: () => Promise<void>;
  children: ReactNode;
};

type ScrollAnchor = { scrollHeight: number; scrollTop: number };

export function ConversationViewport({
  threadId,
  history,
  onLoadEarlier,
  children,
}: ConversationViewportProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const mountedThreadId = useRef<string | undefined>(undefined);
  const followLatest = useRef(true);
  const prependAnchor = useRef<ScrollAnchor | undefined>(undefined);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    if (mountedThreadId.current !== threadId) {
      mountedThreadId.current = threadId;
      followLatest.current = true;
      prependAnchor.current = undefined;
      viewport.scrollTop = viewport.scrollHeight;
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
    requestEarlierIfNeeded(viewport, true);
  });

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
    if (viewport.scrollTop <= TOP_LOAD_THRESHOLD) requestEarlierIfNeeded(viewport);
  }

  return (
    <div
      ref={viewportRef}
      className="timeline-scroll"
      data-testid="timeline-scroll"
      onScroll={handleScroll}
    >
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
