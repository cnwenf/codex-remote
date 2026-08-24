import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { ConversationViewport } from "./conversation-viewport";

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
});
