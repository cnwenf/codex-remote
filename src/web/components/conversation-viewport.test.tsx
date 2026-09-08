import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QuestionContextRequest } from "../../protocol/question-context";
import { ConversationViewport, selectVisibleQuestionAnchor } from "./conversation-viewport";

let scrollHeight = 1_000;
let clientHeight = 300;
const scrollPositions = new WeakMap<HTMLElement, number>();

Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
  configurable: true,
  get: () => scrollHeight,
});
Object.defineProperty(HTMLElement.prototype, "clientHeight", {
  configurable: true,
  get: () => clientHeight,
});
// Browsers clamp writes to the available scroll range; jsdom does not.
Object.defineProperty(HTMLElement.prototype, "scrollTop", {
  configurable: true,
  get() { return scrollPositions.get(this) ?? 0; },
  set(value: number) {
    scrollPositions.set(this, Math.max(0, Math.min(value, scrollHeight - clientHeight)));
  },
});

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  scrollHeight = 1_000;
  clientHeight = 300;
});

describe("ConversationViewport", () => {
  it("selects the topmost visible answer from fixed geometry and ignores offscreen answers", () => {
    expect(selectVisibleQuestionAnchor([
      { anchor: { turnId: "old", anchorItemId: "old-answer" }, top: -240, bottom: -20 },
      { anchor: { turnId: "reading", anchorItemId: "reading-answer" }, top: 110, bottom: 260 },
      { anchor: { turnId: "next", anchorItemId: "next-answer" }, top: 250, bottom: 420 },
    ], 100, 300)).toEqual({ turnId: "reading", anchorItemId: "reading-answer" });
    expect(selectVisibleQuestionAnchor([
      { anchor: { turnId: "old", anchorItemId: "old-answer" }, top: -240, bottom: 90 },
      { anchor: { turnId: "next", anchorItemId: "next-answer" }, top: 310, bottom: 420 },
    ], 100, 300)).toBeUndefined();
    expect(selectVisibleQuestionAnchor([
      { anchor: { turnId: "older" }, top: 110, bottom: 170 },
      { anchor: { turnId: "latest" }, top: 180, bottom: 260 },
    ], 100, 300, true)).toEqual({ turnId: "latest" });
  });

  it("pins RPC question context when only an answer is rendered", async () => {
    const readQuestionContext = vi.fn(async (request: QuestionContextRequest) => ({
      ...request, state: "ready" as const, revision: "1",
      question: { id: "question-1", text: "解释这段日志", imageCount: 0, source: "user" as const, truncated: false, textOffset: 0 },
    }));
    render(<ConversationViewport threadId="thread-1" connection="ready"
      readQuestionContext={readQuestionContext} history={{ hasMoreBefore: false, loading: false }} onLoadEarlier={vi.fn()}>
      <article data-testid="visible-answer" data-question-anchor="true" data-turn-id="turn-1" data-anchor-item-id="answer-1">回答正文</article>
    </ConversationViewport>);
    const viewport = screen.getByTestId("timeline-scroll");
    viewport.getBoundingClientRect = () => ({ top: 100, bottom: 500 } as DOMRect);
    screen.getByTestId("visible-answer").getBoundingClientRect = () => ({ top: 120, bottom: 220 } as DOMRect);

    fireEvent.scroll(viewport);

    expect(await screen.findByRole("button", { name: /原始问题：解释这段日志/ })).toBeVisible();
    expect(screen.queryByTestId("offscreen-original-user")).not.toBeInTheDocument();
    expect(readQuestionContext).toHaveBeenCalledWith(
      { threadId: "thread-1", turnId: "turn-1", anchorItemId: "answer-1" },
      expect.any(AbortSignal),
    );
  });

  it.each([
    {
      candidate: "a different-ID user from another turn",
      source: "user" as const,
      attributes: { "data-user-message": "true", "data-turn-id": "other-turn", "data-item-id": "other-question" },
      pinVisible: true,
    },
    {
      candidate: "a same-ID user from another turn",
      source: "user" as const,
      attributes: { "data-user-message": "true", "data-turn-id": "other-turn", "data-item-id": "question-1" },
      pinVisible: true,
      keepsExpansion: true,
    },
    {
      candidate: "a same-ID tool",
      source: "user" as const,
      attributes: { "data-turn-id": "turn-1", "data-item-id": "question-1" },
      pinVisible: true,
      keepsExpansion: true,
    },
    {
      candidate: "a delegated source for a user question",
      source: "user" as const,
      attributes: { "data-delegated-input": "true", "data-turn-id": "turn-1", "data-item-id": "question-1" },
      pinVisible: true,
    },
    {
      candidate: "the matching user source",
      source: "user" as const,
      attributes: { "data-user-message": "true", "data-turn-id": "turn-1", "data-item-id": "question-1" },
      pinVisible: false,
    },
    {
      candidate: "the matching delegated source",
      source: "delegated" as const,
      attributes: { "data-delegated-input": "true", "data-turn-id": "turn-1", "data-item-id": "question-1" },
      pinVisible: false,
    },
  ])("matches the full question identity when $candidate is visible", async ({ source, attributes, pinVisible, keepsExpansion }) => {
    const readQuestionContext = vi.fn(async (request: QuestionContextRequest) => ({
      ...request, state: "ready" as const, revision: "1",
      question: { id: "question-1", text: "CURRENT ORIGINAL QUESTION", imageCount: 0, source, truncated: false, textOffset: 0 },
    }));
    render(<ConversationViewport threadId="thread-1" connection="ready"
      readQuestionContext={readQuestionContext} history={{ hasMoreBefore: false, loading: false }} onLoadEarlier={vi.fn()}>
      <article data-testid="source-candidate" {...attributes}>Visible candidate</article>
      <article data-testid="visible-answer" data-question-anchor="true" data-turn-id="turn-1" data-anchor-item-id="answer-1">回答正文</article>
    </ConversationViewport>);
    const viewport = screen.getByTestId("timeline-scroll");
    viewport.getBoundingClientRect = () => ({ top: 100, bottom: 500 } as DOMRect);
    screen.getByTestId("source-candidate").getBoundingClientRect = () => ({ top: 110, bottom: 180 } as DOMRect);
    screen.getByTestId("visible-answer").getBoundingClientRect = () => ({ top: 200, bottom: 400 } as DOMRect);

    fireEvent.scroll(viewport);

    await vi.waitFor(() => expect(readQuestionContext).toHaveBeenCalledTimes(1));
    await act(async () => { await readQuestionContext.mock.results[0]!.value; });

    if (pinVisible) {
      const pinned = screen.getByRole("button", { name: /原始问题：CURRENT ORIGINAL QUESTION/ });
      if (keepsExpansion) {
        fireEvent.click(pinned);
        fireEvent.scroll(viewport);
        expect(pinned).toHaveAttribute("aria-expanded", "true");
      }
    } else {
      expect(screen.queryByRole("button", { name: /原始问题：CURRENT ORIGINAL QUESTION/ })).not.toBeInTheDocument();
    }
  });

  it("keeps expansion while a new visible anchor confirms the same question generation", async () => {
    let answerBReads = 0;
    const readQuestionContext = vi.fn(async (request: QuestionContextRequest) => {
      if (request.textOffset === 5) return {
        ...request, state: "ready" as const, revision: "generation-1",
        question: { id: "question-1", text: "续页", imageCount: 0, source: "user" as const, truncated: false, textOffset: 5 },
      };
      if (request.anchorItemId === "answer-b" && ++answerBReads === 1) {
        return { ...request, state: "pending" as const, revision: "generation-1" };
      }
      return {
        ...request, state: "ready" as const, revision: request.anchorItemId === "answer-c" ? "generation-2" : "generation-1",
        question: { id: "question-1", text: "同一个问题", imageCount: 0, source: "user" as const,
          truncated: request.anchorItemId !== "answer-c", textOffset: 0,
          ...(request.anchorItemId === "answer-c" ? {} : { nextTextOffset: 5 }) },
      };
    });
    render(<ConversationViewport threadId="thread-1" connection="ready"
      readQuestionContext={readQuestionContext} history={{ hasMoreBefore: false, loading: false }} onLoadEarlier={vi.fn()}>
      <article data-testid="answer-a" data-question-anchor="true" data-turn-id="turn-1" data-anchor-item-id="answer-a">回答 A</article>
      <article data-testid="answer-b" data-question-anchor="true" data-turn-id="turn-1" data-anchor-item-id="answer-b">回答 B</article>
      <article data-testid="answer-c" data-question-anchor="true" data-turn-id="turn-1" data-anchor-item-id="answer-c">回答 C</article>
    </ConversationViewport>);
    const viewport = screen.getByTestId("timeline-scroll");
    viewport.getBoundingClientRect = () => ({ top: 100, bottom: 500 } as DOMRect);
    const a = screen.getByTestId("answer-a");
    const b = screen.getByTestId("answer-b");
    const c = screen.getByTestId("answer-c");
    a.getBoundingClientRect = () => ({ top: 120, bottom: 220 } as DOMRect);
    b.getBoundingClientRect = () => ({ top: 520, bottom: 620 } as DOMRect);
    c.getBoundingClientRect = () => ({ top: 640, bottom: 740 } as DOMRect);
    fireEvent.scroll(viewport);
    const pinned = await screen.findByRole("button", { name: /原始问题：同一个问题/ });
    fireEvent.click(pinned);
    expect(pinned).toHaveAttribute("aria-expanded", "true");
    await screen.findByText("同一个问题续页");

    a.getBoundingClientRect = () => ({ top: -20, bottom: 80 } as DOMRect);
    b.getBoundingClientRect = () => ({ top: 120, bottom: 220 } as DOMRect);
    fireEvent.scroll(viewport);
    await screen.findByText("正在定位原始问题…");
    await screen.findByRole("button", { name: /原始问题：同一个问题/ });
    expect(screen.getByRole("button", { name: /原始问题：同一个问题续页/ })).toHaveAttribute("aria-expanded", "true");

    b.getBoundingClientRect = () => ({ top: -20, bottom: 80 } as DOMRect);
    c.getBoundingClientRect = () => ({ top: 120, bottom: 220 } as DOMRect);
    fireEvent.scroll(viewport);
    await screen.findByRole("button", { name: /原始问题：同一个问题/ });
    expect(screen.getByRole("button", { name: /原始问题：同一个问题/ })).toHaveAttribute("aria-expanded", "false");
  });

  it("shows pending, not-found, error, and delegated image-only context explicitly", async () => {
    const readQuestionContext = vi.fn(async (request: QuestionContextRequest) => ({
      ...request, state: "not_found" as const, revision: "missing",
    }));
    const view = render(<ConversationViewport threadId="thread-1" connection="ready"
      readQuestionContext={readQuestionContext} history={{ hasMoreBefore: false, loading: false }} onLoadEarlier={vi.fn()}>
      <article data-testid="status-answer" data-question-anchor="true" data-turn-id="turn-1" data-anchor-item-id="answer-1">回答</article>
    </ConversationViewport>);
    const viewport = screen.getByTestId("timeline-scroll");
    viewport.getBoundingClientRect = () => ({ top: 100, bottom: 500 } as DOMRect);
    screen.getByTestId("status-answer").getBoundingClientRect = () => ({ top: 120, bottom: 220 } as DOMRect);
    fireEvent.scroll(viewport);
    expect(screen.getByText("正在定位原始问题…")).toBeVisible();
    await screen.findByText("未找到对应的原始问题");

    const errorReader = vi.fn(async () => { throw new Error("索引暂不可用"); });
    view.rerender(<ConversationViewport threadId="thread-2" connection="ready"
      readQuestionContext={errorReader} history={{ hasMoreBefore: false, loading: false }} onLoadEarlier={vi.fn()}>
      <article data-testid="error-answer" data-question-anchor="true" data-turn-id="turn-2">回答</article>
    </ConversationViewport>);
    screen.getByTestId("error-answer").getBoundingClientRect = () => ({ top: 120, bottom: 220 } as DOMRect);
    fireEvent.scroll(viewport);
    expect(await screen.findByRole("alert")).toHaveTextContent("索引暂不可用");

    const imageReader = vi.fn(async (request: QuestionContextRequest) => ({
      ...request, state: "ready" as const, revision: "image",
      question: { id: "image-question", text: "", imageCount: 2, source: "delegated" as const, sourceThreadId: "child", truncated: false, textOffset: 0 },
    }));
    view.rerender(<ConversationViewport threadId="thread-3" connection="ready"
      readQuestionContext={imageReader} history={{ hasMoreBefore: false, loading: false }} onLoadEarlier={vi.fn()}>
      <article data-testid="image-answer" data-question-anchor="true" data-turn-id="turn-3">回答</article>
    </ConversationViewport>);
    screen.getByTestId("image-answer").getBoundingClientRect = () => ({ top: 120, bottom: 220 } as DOMRect);
    fireEvent.scroll(viewport);
    expect(await screen.findByRole("button", { name: /原始问题：2 张图片/ })).toHaveTextContent("委派问题");
  });
  it.each([
    { layout: "delayed image", initialHeight: 1_000, initialTop: 700, anchoredTop: 900 },
    { layout: "cold short-to-long hydration", initialHeight: 200, initialTop: 0, anchoredTop: 0 },
  ])("keeps following when $layout dispatches scroll before ResizeObserver", ({ initialHeight, initialTop, anchoredTop }) => {
    scrollHeight = initialHeight;
    let resize: (() => void) | undefined;
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resize = callback; }
      observe() {}
      disconnect() {}
    });
    render(<ConversationViewport threadId="images" history={{ hasMoreBefore: false, loading: false }} onLoadEarlier={vi.fn()}>
      <img alt="Delayed image" /><div>Newest assistant final answer</div>
    </ConversationViewport>);
    const viewport = screen.getByTestId("timeline-scroll");
    expect(viewport.scrollTop).toBe(initialTop);

    scrollHeight = 2_000;
    // Scroll anchoring can move down by less than the full image growth.
    viewport.scrollTop = anchoredTop;
    fireEvent.scroll(viewport);
    act(() => resize?.());
    expect(viewport.scrollTop).toBe(1_700);

    // Explicitly reading upward still cancels following delayed images.
    viewport.scrollTop = 500;
    fireEvent.scroll(viewport);
    scrollHeight = 2_500;
    act(() => resize?.());
    expect(viewport.scrollTop).toBe(500);
  });

  it("resets reading-up state when switching tasks and follows composer resizing", () => {
    let resize: (() => void) | undefined;
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resize = callback; }
      observe() {}
      disconnect() {}
    });
    const { rerender } = render(<ConversationViewport threadId="old" history={{ hasMoreBefore: false, loading: false }} onLoadEarlier={vi.fn()}>
      <div>Old task</div>
    </ConversationViewport>);
    const viewport = screen.getByTestId("timeline-scroll");
    viewport.scrollTop = 200;
    fireEvent.scroll(viewport);

    scrollHeight = 2_000;
    rerender(<ConversationViewport threadId="new" history={{ hasMoreBefore: false, loading: false }} onLoadEarlier={vi.fn()}>
      <div>Newest assistant final answer</div>
    </ConversationViewport>);
    expect(viewport.scrollTop).toBe(1_700);

    // A taller composer leaves less room for the conversation.
    clientHeight = 100;
    act(() => resize?.());
    expect(viewport.scrollTop).toBe(1_900);
    viewport.scrollTop = 500;
    fireEvent.scroll(viewport);
    clientHeight = 250;
    act(() => resize?.());
    expect(viewport.scrollTop).toBe(500);
  });

  it("follows delayed content resizing without dragging a reader away from history", () => {
    let resize: (() => void) | undefined;
    vi.stubGlobal("ResizeObserver", class {
      constructor(callback: () => void) { resize = callback; }
      observe() {}
      disconnect() {}
    });
    render(<ConversationViewport threadId="t" history={{ hasMoreBefore: false, loading: false }} onLoadEarlier={vi.fn()}>
      <div>正文和稍后载入的图片</div>
    </ConversationViewport>);
    const viewport = screen.getByTestId("timeline-scroll");
    scrollHeight = 1_400;
    act(() => resize?.());
    expect(viewport.scrollTop).toBe(1_100);
    viewport.scrollTop = 200;
    fireEvent.scroll(viewport);
    scrollHeight = 1_800;
    act(() => resize?.());
    expect(viewport.scrollTop).toBe(200);
  });

  it("does not move composer controls before an execution summary click completes", () => {
    const onInteract = vi.fn();
    render(<ConversationViewport threadId="t" history={{ hasMoreBefore: false, loading: false }} onLoadEarlier={vi.fn()} onInteract={onInteract}>
      <details><summary>执行过程</summary>工具记录</details>
    </ConversationViewport>);
    fireEvent.pointerDown(screen.getByText("执行过程"));
    expect(onInteract).not.toHaveBeenCalled();
  });
  it("opens a conversation at its newest content", () => {
    render(
      <ConversationViewport
        threadId="thread-1"
        history={{ hasMoreBefore: true, loading: false }}
        onLoadEarlier={vi.fn()}
      >
        <div>Latest answer</div>
      </ConversationViewport>,
    );

    expect(screen.getByTestId("timeline-scroll").scrollTop).toBe(700);
  });

  it("loads more history automatically when the latest page cannot fill the viewport", () => {
    scrollHeight = 200;
    clientHeight = 300;
    const onLoadEarlier = vi.fn().mockResolvedValue(undefined);

    render(
      <ConversationViewport
        threadId="thread-1"
        history={{ hasMoreBefore: true, loading: false }}
        onLoadEarlier={onLoadEarlier}
      >
        <div>One short turn</div>
      </ConversationViewport>,
    );

    expect(onLoadEarlier).toHaveBeenCalledTimes(1);
  });

  it("loads older history near the top and preserves the visible anchor after prepending", () => {
    const onLoadEarlier = vi.fn().mockResolvedValue(undefined);
    const { rerender } = render(
      <ConversationViewport
        threadId="thread-1"
        history={{ hasMoreBefore: true, loading: false }}
        onLoadEarlier={onLoadEarlier}
      >
        <div>Latest page</div>
      </ConversationViewport>,
    );
    const viewport = screen.getByTestId("timeline-scroll");
    viewport.scrollTop = 50;

    fireEvent.scroll(viewport);
    expect(onLoadEarlier).toHaveBeenCalledTimes(1);

    rerender(
      <ConversationViewport threadId="thread-1" history={{ hasMoreBefore: true, loading: true }} onLoadEarlier={onLoadEarlier}>
        <div>Latest page, unrelated live update while the gap is loading</div>
      </ConversationViewport>,
    );
    expect(viewport.scrollTop).toBe(50);
    scrollHeight = 1_400;
    rerender(
      <ConversationViewport
        threadId="thread-1"
        history={{ hasMoreBefore: true, loading: true }}
        onLoadEarlier={onLoadEarlier}
      >
        <div>Older page</div>
        <div>Latest page</div>
      </ConversationViewport>,
    );

    expect(viewport.scrollTop).toBe(450);
  });

  it("requires an explicit action when automatic gap recovery is paused", () => {
    scrollHeight = 200;
    clientHeight = 300;
    const onLoadEarlier = vi.fn().mockResolvedValue(undefined);
    render(<ConversationViewport threadId="paused" history={{ hasMoreBefore: true, loading: false, gapRecoveryPaused: true }} onLoadEarlier={onLoadEarlier}>
      <div>Short recovered fragment</div>
    </ConversationViewport>);
    expect(onLoadEarlier).not.toHaveBeenCalled();
    fireEvent.click(screen.getByRole("button", { name: "继续加载遗漏内容" }));
    expect(onLoadEarlier).toHaveBeenCalledWith(false);
  });

  it("follows live output only while the reader remains near the bottom", () => {
    const { rerender } = render(
      <ConversationViewport
        threadId="thread-1"
        history={{ hasMoreBefore: false, loading: false }}
        onLoadEarlier={vi.fn()}
      >
        <div>Initial output</div>
      </ConversationViewport>,
    );
    const viewport = screen.getByTestId("timeline-scroll");
    viewport.scrollTop = 100;
    fireEvent.scroll(viewport);

    scrollHeight = 1_200;
    rerender(
      <ConversationViewport
        threadId="thread-1"
        history={{ hasMoreBefore: false, loading: false }}
        onLoadEarlier={vi.fn()}
      >
        <div>Initial output</div>
        <div>Streaming output</div>
      </ConversationViewport>,
    );
    expect(viewport.scrollTop).toBe(100);

    viewport.scrollTop = 910;
    fireEvent.scroll(viewport);
    scrollHeight = 1_300;
    rerender(
      <ConversationViewport
        threadId="thread-1"
        history={{ hasMoreBefore: false, loading: false }}
        onLoadEarlier={vi.fn()}
      >
        <div>Initial output</div>
        <div>More streaming output</div>
      </ConversationViewport>,
    );
    expect(viewport.scrollTop).toBe(1_000);
  });

  it("notifies the thread view when the conversation content is tapped", () => {
    const onInteract = vi.fn();
    render(
      <ConversationViewport
        threadId="thread-1"
        history={{ hasMoreBefore: false, loading: false }}
        onLoadEarlier={vi.fn()}
        onInteract={onInteract}
      >
        <button type="button">Conversation content</button>
      </ConversationViewport>,
    );

    fireEvent.pointerDown(screen.getByTestId("timeline-scroll"));
    expect(onInteract).toHaveBeenCalledTimes(1);
  });

  it("does not pin the previous turn while the current running turn has no user item yet", () => {
    render(
      <ConversationViewport
        threadId="thread-1"
        history={{ hasMoreBefore: false, loading: false }}
        onLoadEarlier={vi.fn()}
      >
        <article data-user-message="true"><div className="markdown-body">上一轮问题</div></article>
        <div>Current turn is recovering</div>
      </ConversationViewport>,
    );
    const viewport = screen.getByTestId("timeline-scroll");
    const prompt = viewport.querySelector<HTMLElement>("[data-user-message='true']")!;
    viewport.getBoundingClientRect = () => ({ top: 100 } as DOMRect);
    prompt.getBoundingClientRect = () => ({ bottom: 80 } as DOMRect);

    fireEvent.scroll(viewport);

    expect(screen.queryByRole("button", { name: /原始问题/ })).not.toBeInTheDocument();
  });

});
