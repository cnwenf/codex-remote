import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { CodexThread } from "../../protocol/thread-store";
import { ConversationViewport, currentThreadQuestion } from "./conversation-viewport";

let scrollHeight = 1_000;
let clientHeight = 300;

Object.defineProperty(HTMLElement.prototype, "scrollHeight", {
  configurable: true,
  get: () => scrollHeight,
});
Object.defineProperty(HTMLElement.prototype, "clientHeight", {
  configurable: true,
  get: () => clientHeight,
});

afterEach(() => {
  scrollHeight = 1_000;
  clientHeight = 300;
});

describe("ConversationViewport", () => {
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

    expect(screen.getByTestId("timeline-scroll").scrollTop).toBe(1_000);
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
    expect(viewport.scrollTop).toBe(1_300);
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
