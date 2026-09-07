import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexThread } from "../../protocol/thread-store";
import { ConversationViewport, currentThreadQuestion } from "./conversation-viewport";

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

  it("pins the latest user question after it scrolls above the viewport and collapses outside", () => {
    const question = "这是一个很长的用户问题，需要在离开窗口后固定在顶部，并且默认只显示两行。";
    render(
      <ConversationViewport
        threadId="thread-1"
        history={{ hasMoreBefore: false, loading: false }}
        currentQuestion={question}
        onLoadEarlier={vi.fn()}
      >
        <article data-user-message="true">
          <div className="markdown-body">{question}</div>
        </article>
        <div>Long running answer</div>
      </ConversationViewport>,
    );
    const viewport = screen.getByTestId("timeline-scroll");
    const prompt = viewport.querySelector<HTMLElement>("[data-user-message='true']")!;
    viewport.getBoundingClientRect = () => ({ top: 100 } as DOMRect);
    prompt.getBoundingClientRect = () => ({ bottom: 80 } as DOMRect);

    fireEvent.scroll(viewport);
    const pinned = screen.getByRole("button", { name: `展开原始问题：${question}` });
    expect(pinned).toHaveTextContent(question);
    expect(pinned).toHaveAttribute("aria-expanded", "false");
    expect(pinned).toHaveClass("pinned-user-question-collapsed");

    fireEvent.click(pinned);
    expect(pinned).toHaveAttribute("aria-expanded", "true");
    expect(pinned).toHaveClass("pinned-user-question-expanded");

    fireEvent.pointerDown(document.body);
    expect(pinned).toHaveAttribute("aria-expanded", "false");

    prompt.getBoundingClientRect = () => ({ bottom: 140 } as DOMRect);
    fireEvent.scroll(viewport);
    expect(screen.queryByRole("button", { name: `展开原始问题：${question}` })).not.toBeInTheDocument();
  });

  it.each(Array.from({ length: 11 }, (_, index) => 150 + index))(
    "keeps the pinned question stable across the %ipx flow boundary",
    (shiftedBottom) => {
      const question = "原始问题";
      vi.spyOn(HTMLElement.prototype, "getBoundingClientRect").mockImplementation(function (this: HTMLElement) {
        if (this.dataset.testid === "timeline-scroll") return { top: 150 } as DOMRect;
        if (this.matches("[data-user-message='true']")) {
          const pinned = document.querySelector(".pinned-user-question");
          const pinnedInFlow = pinned && !pinned.parentElement?.matches(".pinned-user-question-layer");
          return { bottom: pinnedInFlow ? shiftedBottom : 149 } as DOMRect;
        }
        return {} as DOMRect;
      });
      render(
        <ConversationViewport
          threadId="thread-1"
          history={{ hasMoreBefore: false, loading: false }}
          currentQuestion={question}
          onLoadEarlier={vi.fn()}
        >
          <article data-user-message="true">{question}</article>
          <div>Long final answer</div>
        </ConversationViewport>,
      );

      fireEvent.scroll(screen.getByTestId("timeline-scroll"));

      const pinned = screen.getByRole("button", { name: `展开原始问题：${question}` });
      expect(pinned).toBeVisible();
      fireEvent.click(pinned);
      expect(pinned).toHaveAttribute("aria-expanded", "true");
      fireEvent.pointerDown(document.body);
      expect(pinned).toHaveAttribute("aria-expanded", "false");
    },
  );

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

  it("selects the raw user text only from the current turn", () => {
    const thread: CodexThread = {
      id: "thread-1",
      title: "Task",
      status: "running",
      activeTurnId: "turn-current",
      turnOrder: ["turn-old", "turn-current"],
      turns: {
        "turn-old": {
          id: "turn-old",
          status: "completed",
          itemOrder: ["old-user"],
          items: { "old-user": { id: "old-user", type: "userMessage", text: "上一轮问题" } },
        },
        "turn-current": {
          id: "turn-current",
          status: "inProgress",
          itemOrder: ["current-user"],
          items: { "current-user": { id: "current-user", type: "user_message", text: "**当前**\n问题" } },
        },
      },
    };

    expect(currentThreadQuestion(thread)).toBe("**当前**\n问题");
    thread.activeTurnId = undefined;
    expect(currentThreadQuestion(thread)).toBeUndefined();
    thread.activeTurnId = "turn-current";
    thread.turns["turn-current"].itemOrder = [];
    expect(currentThreadQuestion(thread)).toBeUndefined();
    thread.status = "idle";
    expect(currentThreadQuestion(thread)).toBeUndefined();
  });
});
