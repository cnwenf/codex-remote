import { act, renderHook, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { QuestionContext, QuestionContextRequest } from "../../protocol/question-context";
import { useQuestionContext, type QuestionAnchor } from "./use-question-context";

function ready(
  request: QuestionContextRequest,
  id: string,
  text: string,
  nextTextOffset?: number,
  revision = "generation-1",
): QuestionContext {
  return {
    ...request,
    state: "ready",
    revision,
    question: {
      id,
      text,
      imageCount: 0,
      source: "user",
      truncated: nextTextOffset !== undefined,
      textOffset: request.textOffset ?? 0,
      ...(nextTextOffset === undefined ? {} : { nextTextOffset }),
    },
  };
}

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason: Error) => void;
  const promise = new Promise<T>((done, fail) => { resolve = done; reject = fail; });
  return { promise, resolve, reject };
}

afterEach(() => vi.useRealTimers());

describe("useQuestionContext", () => {
  it("deduplicates an unchanged visible anchor across streaming renders", async () => {
    const readQuestionContext = vi.fn(async (request: QuestionContextRequest) => ready(request, "q-1", "解释日志"));
    const { result, rerender } = renderHook(({ stream }) => useQuestionContext({
      threadId: "thread-1",
      anchor: { turnId: "turn-1", anchorItemId: "answer-1" },
      connection: "ready",
      readQuestionContext,
    }), { initialProps: { stream: "first" } });

    await waitFor(() => expect(result.current.context?.state).toBe("ready"));
    rerender({ stream: "continued" });

    expect(result.current.text).toBe("解释日志");
    expect(readQuestionContext).toHaveBeenCalledTimes(1);
  });

  it("isolates late responses when scrolling to another turn or same-turn supplement", async () => {
    const first = deferred<QuestionContext>();
    const second = deferred<QuestionContext>();
    const signals: AbortSignal[] = [];
    const readQuestionContext = vi.fn()
      .mockImplementationOnce((_request, signal) => { signals.push(signal); return first.promise; })
      .mockImplementationOnce((_request, signal) => { signals.push(signal); return second.promise; });
    const { result, rerender } = renderHook(({ anchor }) => useQuestionContext({
      threadId: "thread-1",
      anchor,
      connection: "ready",
      readQuestionContext,
    }), { initialProps: { anchor: { turnId: "turn-1", anchorItemId: "answer-1" } } });

    rerender({ anchor: { turnId: "turn-1", anchorItemId: "answer-2" } });
    expect(result.current.context).toBeUndefined();
    expect(signals[0].aborted).toBe(true);
    await act(async () => second.resolve(ready({ threadId: "thread-1", turnId: "turn-1", anchorItemId: "answer-2" }, "q-2", "补充后的问题")));
    expect(result.current.text).toBe("补充后的问题");
    await act(async () => first.resolve(ready({ threadId: "thread-1", turnId: "turn-1", anchorItemId: "answer-1" }, "q-1", "旧问题")));
    expect(result.current.text).toBe("补充后的问题");
  });

  it("retries only after a resolved pending response and stops after ready", async () => {
    vi.useFakeTimers();
    const readQuestionContext = vi.fn()
      .mockResolvedValueOnce({ threadId: "t", turnId: "turn", anchorItemId: "answer", state: "pending", revision: "1" })
      .mockImplementationOnce(async (request: QuestionContextRequest) => ready(request, "q", "已定位"));
    const { result } = renderHook(() => useQuestionContext({
      threadId: "t",
      anchor: { turnId: "turn", anchorItemId: "answer" },
      connection: "ready",
      readQuestionContext,
    }));

    await act(async () => { await Promise.resolve(); });
    expect(readQuestionContext).toHaveBeenCalledTimes(1);
    await act(async () => { vi.advanceTimersByTime(250); await Promise.resolve(); });
    expect(readQuestionContext).toHaveBeenCalledTimes(2);
    expect(result.current.text).toBe("已定位");
    vi.advanceTimersByTime(10_000);
    expect(readQuestionContext).toHaveBeenCalledTimes(2);
  });

  it("caps pending backoff at five seconds and cancels low-frequency polling on unmount", async () => {
    vi.useFakeTimers();
    const readQuestionContext = vi.fn(async () => ({
      threadId: "t", turnId: "turn", anchorItemId: "answer", state: "pending" as const, revision: "pending",
    }));
    const { unmount } = renderHook(() => useQuestionContext({
      threadId: "t", anchor: { turnId: "turn", anchorItemId: "answer" }, connection: "ready", readQuestionContext,
    }));

    await act(async () => { await Promise.resolve(); });
    for (const delay of [200, 500, 1_000, 2_000, 5_000]) {
      await act(async () => { vi.advanceTimersByTime(delay); await Promise.resolve(); });
    }
    expect(readQuestionContext).toHaveBeenCalledTimes(6);
    unmount();
    await act(async () => { vi.advanceTimersByTime(30_000); await Promise.resolve(); });
    expect(readQuestionContext).toHaveBeenCalledTimes(6);
  });

  it("revalidates turn-level context that has no exact item anchor", async () => {
    vi.useFakeTimers();
    const readQuestionContext = vi.fn()
      .mockImplementationOnce(async (request) => ready(request, "q-1", "原问题"))
      .mockImplementationOnce(async (request) => ready(request, "q-2", "同轮新确认问题"));
    const { result } = renderHook(() => useQuestionContext({
      threadId: "t", anchor: { turnId: "turn" }, connection: "ready", readQuestionContext,
    }));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.text).toBe("原问题");

    await act(async () => { vi.advanceTimersByTime(2_000); await Promise.resolve(); });
    expect(result.current.text).toBe("同轮新确认问题");
    expect(readQuestionContext).toHaveBeenCalledTimes(2);
  });

  it("loads one bounded continuation page and resets it for a new question", async () => {
    const readQuestionContext = vi.fn(async (request: QuestionContextRequest) => request.textOffset === 4096
      ? ready(request, "q-1", "B".repeat(12))
      : ready(request, request.anchorItemId === "answer-2" ? "q-2" : "q-1", request.anchorItemId === "answer-2" ? "新问题" : "A".repeat(4096), request.anchorItemId === "answer-2" ? undefined : 4096));
    const { result, rerender } = renderHook(({ anchorItemId }) => useQuestionContext({
      threadId: "t",
      anchor: { turnId: "turn", anchorItemId },
      connection: "ready",
      readQuestionContext,
    }), { initialProps: { anchorItemId: "answer-1" } });
    await waitFor(() => expect(result.current.text).toHaveLength(4096));

    await act(async () => { await result.current.loadMore(); });
    expect(result.current.text).toHaveLength(4108);
    expect(readQuestionContext).toHaveBeenLastCalledWith(
      { threadId: "t", turnId: "turn", anchorItemId: "answer-1", textOffset: 4096 },
      expect.any(AbortSignal),
    );

    rerender({ anchorItemId: "answer-2" });
    expect(result.current.context).toBeUndefined();
    await waitFor(() => expect(result.current.text).toBe("新问题"));
  });

  it("polls a pending continuation and never splices pages across revisions", async () => {
    vi.useFakeTimers();
    const readQuestionContext = vi.fn(async (request: QuestionContextRequest) => {
      if (request.textOffset === 4096 && readQuestionContext.mock.calls.length === 2) {
        return { ...request, state: "pending" as const, revision: "generation-1" };
      }
      if (request.textOffset === 4096) return ready(request, "q", "旧页不得拼接", undefined, "generation-2");
      return readQuestionContext.mock.calls.length >= 4
        ? ready(request, "q", "新代际首页", undefined, "generation-2")
        : ready(request, "q", "A".repeat(4096), 4096, "generation-1");
    });
    const { result } = renderHook(() => useQuestionContext({
      threadId: "t", anchor: { turnId: "turn", anchorItemId: "answer" }, connection: "ready", readQuestionContext,
    }));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.text).toHaveLength(4096);

    let loading!: Promise<void>;
    act(() => { loading = result.current.loadMore(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });
    await act(async () => { await loading; });
    await act(async () => { await Promise.resolve(); });

    expect(result.current.text).toBe("新代际首页");
    expect(result.current.text).not.toContain("旧页不得拼接");
  });

  it("surfaces a continuation error and lets the reader retry the same page", async () => {
    const readQuestionContext = vi.fn()
      .mockImplementationOnce(async (request: QuestionContextRequest) => ready(request, "q", "A", 1))
      .mockRejectedValueOnce(new Error("续页网络失败"))
      .mockImplementationOnce(async (request: QuestionContextRequest) => ready(request, "q", "B"));
    const { result } = renderHook(() => useQuestionContext({
      threadId: "t", anchor: { turnId: "turn", anchorItemId: "answer" }, connection: "ready", readQuestionContext,
    }));
    await waitFor(() => expect(result.current.text).toBe("A"));

    await act(async () => { await result.current.loadMore(); });
    expect(result.current.loadMoreError).toBe("续页网络失败");
    expect(result.current.nextTextOffset).toBe(1);

    await act(async () => { await result.current.loadMore(); });
    expect(result.current.text).toBe("AB");
    expect(result.current.loadMoreError).toBeUndefined();
  });

  it("clears stale context across task switches and reconnects before revalidating", async () => {
    const readQuestionContext = vi.fn(async (request: QuestionContextRequest) => ready(
      request,
      `${request.threadId}-${readQuestionContext.mock.calls.length}`,
      `${request.threadId}-${readQuestionContext.mock.calls.length}`,
    ));
    const { result, rerender } = renderHook(({ threadId, connection }) => useQuestionContext({
      threadId,
      anchor: { turnId: "turn", anchorItemId: "answer" },
      connection,
      readQuestionContext,
    }), { initialProps: { threadId: "thread-1", connection: "ready" as "ready" | "reconnecting" } });
    await waitFor(() => expect(result.current.text).toBe("thread-1-1"));

    rerender({ threadId: "thread-2", connection: "ready" });
    expect(result.current.context).toBeUndefined();
    await waitFor(() => expect(result.current.text).toBe("thread-2-2"));

    rerender({ threadId: "thread-2", connection: "reconnecting" });
    expect(result.current.context).toBeUndefined();
    rerender({ threadId: "thread-2", connection: "ready" });
    await waitFor(() => expect(result.current.text).toBe("thread-2-3"));
  });

  it("does not commit an old continuation after an unanchored generation refresh", async () => {
    vi.useFakeTimers();
    const oldPage = deferred<QuestionContext>();
    const readQuestionContext = vi.fn((request: QuestionContextRequest) => {
      if (request.textOffset === 1) return oldPage.promise;
      return Promise.resolve(readQuestionContext.mock.calls.length === 1
        ? ready(request, "q", "OLD_FIRST", 1, "generation-1")
        : ready(request, "q", "NEW_FIRST", undefined, "generation-2"));
    });
    const { result } = renderHook(() => useQuestionContext({
      threadId: "t", anchor: { turnId: "turn" }, connection: "ready", readQuestionContext,
    }));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.text).toBe("OLD_FIRST");

    let loading!: Promise<void>;
    act(() => { loading = result.current.loadMore(); });
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000); });
    expect(result.current.text).toBe("NEW_FIRST");

    await act(async () => {
      oldPage.resolve(ready({ threadId: "t", turnId: "turn", textOffset: 1 }, "q", "OLD_PAGE", undefined, "generation-1"));
      await loading;
    });
    expect(result.current.text).toBe("NEW_FIRST");
  });

  it("aborts an unresolved continuation after returning through a cached anchor and unmounting", async () => {
    let continuationSignal: AbortSignal | undefined;
    const readQuestionContext = vi.fn((request: QuestionContextRequest, signal?: AbortSignal) => {
      if (request.textOffset === 1) {
        continuationSignal = signal;
        return new Promise<QuestionContext>(() => undefined);
      }
      return Promise.resolve(ready(request, request.anchorItemId!, request.anchorItemId!, 1));
    });
    const { result, rerender, unmount } = renderHook(({ anchorItemId }) => useQuestionContext({
      threadId: "t", anchor: { turnId: "turn", anchorItemId }, connection: "ready", readQuestionContext,
    }), { initialProps: { anchorItemId: "answer-a" } });
    await waitFor(() => expect(result.current.text).toBe("answer-a"));
    rerender({ anchorItemId: "answer-b" });
    await waitFor(() => expect(result.current.text).toBe("answer-b"));
    rerender({ anchorItemId: "answer-a" });
    await waitFor(() => expect(result.current.text).toBe("answer-a"));

    act(() => { void result.current.loadMore(); });
    await act(async () => { await Promise.resolve(); });
    unmount();

    expect(continuationSignal?.aborted).toBe(true);
  });

  it("cancels a continuation pending retry when unmounted", async () => {
    vi.useFakeTimers();
    let continuationSignal: AbortSignal | undefined;
    const readQuestionContext = vi.fn(async (request: QuestionContextRequest, signal?: AbortSignal) => {
      if (request.textOffset === 1) {
        continuationSignal = signal;
        return { ...request, state: "pending" as const, revision: "generation-1" };
      }
      return ready(request, "q", "A", 1);
    });
    const { result, unmount } = renderHook(() => useQuestionContext({
      threadId: "t", anchor: { turnId: "turn", anchorItemId: "answer" }, connection: "ready", readQuestionContext,
    }));
    await act(async () => { await Promise.resolve(); });
    act(() => { void result.current.loadMore(); });
    await act(async () => { await Promise.resolve(); });
    expect(readQuestionContext).toHaveBeenCalledTimes(2);

    unmount();
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });

    expect(continuationSignal?.aborted).toBe(true);
    expect(readQuestionContext).toHaveBeenCalledTimes(2);
  });

  it.each(["not_found", "error"] as const)("rechecks anchored %s context until it becomes ready", async (state) => {
    vi.useFakeTimers();
    const readQuestionContext = vi.fn()
      .mockResolvedValueOnce({ threadId: "t", turnId: "turn", anchorItemId: "answer", state, revision: "generation-1" })
      .mockImplementationOnce(async (request: QuestionContextRequest) => ready(request, "q", "已补齐"));
    const { result } = renderHook(() => useQuestionContext({
      threadId: "t", anchor: { turnId: "turn", anchorItemId: "answer" }, connection: "ready", readQuestionContext,
    }));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.context?.state).toBe(state);

    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });

    expect(result.current.text).toBe("已补齐");
    expect(readQuestionContext).toHaveBeenCalledTimes(2);
  });

  it("revalidates a successful cached anchor after A to B to A", async () => {
    const readQuestionContext = vi.fn(async (request: QuestionContextRequest) => {
      const revisitingA = request.anchorItemId === "answer-a" && readQuestionContext.mock.calls.length === 3;
      return ready(request, request.anchorItemId!, revisitingA ? "A generation 2" : request.anchorItemId!, undefined,
        revisitingA ? "generation-2" : "generation-1");
    });
    const { result, rerender } = renderHook(({ anchorItemId }) => useQuestionContext({
      threadId: "t", anchor: { turnId: "turn", anchorItemId }, connection: "ready", readQuestionContext,
    }), { initialProps: { anchorItemId: "answer-a" } });
    await waitFor(() => expect(result.current.text).toBe("answer-a"));
    rerender({ anchorItemId: "answer-b" });
    await waitFor(() => expect(result.current.text).toBe("answer-b"));
    rerender({ anchorItemId: "answer-a" });

    await waitFor(() => expect(result.current.text).toBe("A generation 2"));
    expect(readQuestionContext).toHaveBeenCalledTimes(3);
  });

  it("keeps loaded pages when another anchor returns pending before confirming the same question", async () => {
    vi.useFakeTimers();
    const readQuestionContext = vi.fn((request: QuestionContextRequest) => {
      if (request.anchorItemId === "answer-b" &&
        readQuestionContext.mock.calls.filter(([value]) => value.anchorItemId === "answer-b").length === 1) {
        return Promise.resolve({ ...request, state: "pending" as const, revision: "generation-1" });
      }
      return Promise.resolve(request.textOffset === 1
        ? ready(request, "q", "B")
        : ready(request, "q", "A", 1));
    });
    const { result, rerender } = renderHook(({ anchorItemId }) => useQuestionContext({
      threadId: "t", anchor: { turnId: "turn", anchorItemId }, connection: "ready", readQuestionContext,
    }), { initialProps: { anchorItemId: "answer-a" } });
    await act(async () => { await Promise.resolve(); });
    expect(result.current.text).toBe("A");
    await act(async () => { await result.current.loadMore(); });
    expect(result.current.text).toBe("AB");

    rerender({ anchorItemId: "answer-b" });
    expect(result.current.context).toBeUndefined();
    await act(async () => { await Promise.resolve(); });
    expect(result.current.context?.state).toBe("pending");
    expect(result.current.text).toBe("");
    await act(async () => { await vi.advanceTimersByTimeAsync(200); });

    expect(result.current.text).toBe("AB");
  });

  it.each(["not_found", "error"] as const)(
    "keeps loaded pages while another anchor is temporarily %s before confirming the same question",
    async (state) => {
      vi.useFakeTimers();
      const readQuestionContext = vi.fn((request: QuestionContextRequest) => {
        if (request.anchorItemId === "answer-b" &&
          readQuestionContext.mock.calls.filter(([value]) => value.anchorItemId === "answer-b").length === 1) {
          return Promise.resolve({ ...request, state, revision: "generation-1" });
        }
        return Promise.resolve(request.textOffset === 1
          ? ready(request, "q", "B")
          : ready(request, "q", "A", 1));
      });
      const { result, rerender } = renderHook(({ anchorItemId }) => useQuestionContext({
        threadId: "t", anchor: { turnId: "turn", anchorItemId }, connection: "ready", readQuestionContext,
      }), { initialProps: { anchorItemId: "answer-a" } });
      await act(async () => { await Promise.resolve(); });
      await act(async () => { await result.current.loadMore(); });
      expect(result.current.text).toBe("AB");

      rerender({ anchorItemId: "answer-b" });
      await act(async () => { await Promise.resolve(); });
      expect(result.current.context?.state).toBe(state);
      expect(result.current.text).toBe("");
      await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });

      expect(result.current.text).toBe("AB");
    },
  );

  it("resets canceled page state across tasks without letting the old finally clear a new page", async () => {
    const oldPage = deferred<QuestionContext>();
    const newPage = deferred<QuestionContext>();
    let oldSignal: AbortSignal | undefined;
    const readQuestionContext = vi.fn((request: QuestionContextRequest, signal?: AbortSignal) => {
      if (request.threadId === "t1" && request.textOffset === 1) {
        oldSignal = signal;
        return oldPage.promise;
      }
      if (request.threadId === "t2" && request.textOffset === 1) return newPage.promise;
      return Promise.resolve(ready(request, `q-${request.threadId}`, request.threadId, 1));
    });
    const { result, rerender } = renderHook(({ threadId }) => useQuestionContext({
      threadId, anchor: { turnId: "turn", anchorItemId: "answer" }, connection: "ready", readQuestionContext,
    }), { initialProps: { threadId: "t1" } });
    await waitFor(() => expect(result.current.text).toBe("t1"));
    let oldLoad!: Promise<void>;
    act(() => { oldLoad = result.current.loadMore(); });
    await act(async () => { await Promise.resolve(); });

    rerender({ threadId: "t2" });
    expect(oldSignal?.aborted).toBe(true);
    expect(result.current.loadingMore).toBe(false);
    await waitFor(() => expect(result.current.text).toBe("t2"));
    let newLoad!: Promise<void>;
    act(() => { newLoad = result.current.loadMore(); });
    await act(async () => { await Promise.resolve(); });
    expect(result.current.loadingMore).toBe(true);

    await act(async () => { oldPage.reject(new Error("canceled old page")); await oldLoad; });
    expect(result.current.loadingMore).toBe(true);
    await act(async () => {
      newPage.resolve(ready({ threadId: "t2", turnId: "turn", anchorItemId: "answer", textOffset: 1 }, "q-t2", "B"));
      await newLoad;
    });
    expect(result.current.text).toBe("t2B");
    expect(result.current.loadingMore).toBe(false);
  });

  it("does not expose a previous question page error after confirming another question", async () => {
    const readQuestionContext = vi.fn((request: QuestionContextRequest) => {
      if (request.anchorItemId === "answer-a" && request.textOffset === 1) {
        return Promise.reject(new Error("OLD_PAGE_ERROR"));
      }
      return Promise.resolve(ready(request, request.anchorItemId === "answer-a" ? "q-a" : "q-b",
        request.anchorItemId === "answer-a" ? "A" : "B", request.anchorItemId === "answer-a" ? 1 : undefined));
    });
    const { result, rerender } = renderHook(({ anchorItemId }) => useQuestionContext({
      threadId: "t", anchor: { turnId: "turn", anchorItemId }, connection: "ready", readQuestionContext,
    }), { initialProps: { anchorItemId: "answer-a" } });
    await waitFor(() => expect(result.current.text).toBe("A"));
    await act(async () => { await result.current.loadMore(); });
    expect(result.current.loadMoreError).toBe("OLD_PAGE_ERROR");

    rerender({ anchorItemId: "answer-b" });
    await waitFor(() => expect(result.current.text).toBe("B"));
    expect(result.current.loadingMore).toBe(false);
    expect(result.current.loadMoreError).toBeUndefined();
  });

  it("cancels a pending continuation when the visible anchor disappears", async () => {
    vi.useFakeTimers();
    let pageSignal: AbortSignal | undefined;
    let pageCalls = 0;
    const readQuestionContext = vi.fn(async (request: QuestionContextRequest, signal?: AbortSignal) => {
      if (request.textOffset === 1) {
        pageCalls += 1;
        pageSignal = signal;
        return { ...request, state: "pending" as const, revision: "generation-1" };
      }
      return ready(request, "q", "A", 1);
    });
    const { result, rerender } = renderHook(({ anchor }) => useQuestionContext({
      threadId: "t", anchor, connection: "ready", readQuestionContext,
    }), { initialProps: { anchor: { turnId: "turn", anchorItemId: "answer" } as QuestionAnchor | undefined } });
    await act(async () => { await Promise.resolve(); });
    act(() => { void result.current.loadMore(); });
    await act(async () => { await Promise.resolve(); });
    expect(pageCalls).toBe(1);

    rerender({ anchor: undefined });
    expect(pageSignal?.aborted).toBe(true);
    expect(result.current.loadingMore).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(pageCalls).toBe(1);
  });

  it("cancels a pending continuation while a different turn remains unconfirmed", async () => {
    vi.useFakeTimers();
    let oldPageSignal: AbortSignal | undefined;
    let oldPageCalls = 0;
    const readQuestionContext = vi.fn((request: QuestionContextRequest, signal?: AbortSignal) => {
      if (request.turnId === "turn-a" && request.textOffset === 1) {
        oldPageCalls += 1;
        oldPageSignal = signal;
        return Promise.resolve({ ...request, state: "pending" as const, revision: "generation-1" });
      }
      if (request.turnId === "turn-b") return new Promise<QuestionContext>(() => undefined);
      return Promise.resolve(ready(request, "q-a", "A", 1));
    });
    const { result, rerender } = renderHook(({ anchor }) => useQuestionContext({
      threadId: "t", anchor, connection: "ready", readQuestionContext,
    }), { initialProps: { anchor: { turnId: "turn-a", anchorItemId: "answer-a" } } });
    await act(async () => { await Promise.resolve(); });
    act(() => { void result.current.loadMore(); });
    await act(async () => { await Promise.resolve(); });

    rerender({ anchor: { turnId: "turn-b", anchorItemId: "answer-b" } });
    expect(result.current.context).toBeUndefined();
    expect(oldPageSignal?.aborted).toBe(true);
    expect(result.current.loadingMore).toBe(false);
    await act(async () => { await vi.advanceTimersByTimeAsync(1_000); });
    expect(oldPageCalls).toBe(1);
  });

  it("retries an initial request timeout from an explicit error state", async () => {
    vi.useFakeTimers();
    const readQuestionContext = vi.fn()
      .mockRejectedValueOnce(new Error("原始问题请求超时"))
      .mockImplementationOnce(async (request: QuestionContextRequest) => ready(request, "q", "已恢复"));
    const { result } = renderHook(() => useQuestionContext({
      threadId: "t", anchor: { turnId: "turn", anchorItemId: "answer" }, connection: "ready", readQuestionContext,
    }));
    await act(async () => { await Promise.resolve(); });
    expect(result.current.context).toMatchObject({ state: "error", message: expect.stringMatching(/超时/) });

    await act(async () => { await vi.advanceTimersByTimeAsync(5_000); });
    expect(readQuestionContext).toHaveBeenCalledTimes(2);
    expect(result.current.text).toBe("已恢复");
  });

  it.each([
    ["thread", (request: QuestionContextRequest) => ready({ ...request, threadId: "foreign" }, "q", "WRONG")],
    ["turn", (request: QuestionContextRequest) => ready({ ...request, turnId: "foreign" }, "q", "WRONG")],
    ["anchor", (request: QuestionContextRequest) => ready({ ...request, anchorItemId: "foreign" }, "q", "WRONG")],
    ["offset", (request: QuestionContextRequest) => ({
      ...ready(request, "q", "WRONG"),
      question: { ...ready(request, "q", "WRONG").question!, textOffset: 123 },
    })],
  ] as const)("refuses a valid-shaped response with a foreign %s identity", async (_case, response) => {
    const readQuestionContext = vi.fn(async (request: QuestionContextRequest) => response(request));
    const { result } = renderHook(() => useQuestionContext({
      threadId: "t", anchor: { turnId: "turn", anchorItemId: "answer" }, connection: "ready", readQuestionContext,
    }));

    await waitFor(() => expect(result.current.context?.state).toBe("error"));
    expect(result.current.text).toBe("");
  });

  it("refuses a continuation whose returned text offset does not match the request", async () => {
    const readQuestionContext = vi.fn(async (request: QuestionContextRequest) => {
      const context = ready(request, "q", request.textOffset ? "WRONG_PAGE" : "A", request.textOffset ? undefined : 1);
      return request.textOffset ? { ...context, question: { ...context.question!, textOffset: 0 } } : context;
    });
    const { result } = renderHook(() => useQuestionContext({
      threadId: "t", anchor: { turnId: "turn", anchorItemId: "answer" }, connection: "ready", readQuestionContext,
    }));
    await waitFor(() => expect(result.current.text).toBe("A"));

    await act(async () => { await result.current.loadMore(); });

    expect(result.current.text).toBe("A");
    expect(result.current.loadMoreError).toMatch(/身份/);
  });
});
