import { describe, expect, it } from "vitest";
import { initialCodexState, reduceCodexState, type CodexItem, type CodexState } from "./thread-store";

describe("reduceCodexState", () => {
  it("retains the actual failed turn error instead of reporting an idle successful completion", () => {
    const state = reduceCodexState(initialCodexState, {
      method: "turn/completed", params: { threadId: "failed-task", turn: {
        id: "failed-turn", status: "failed", error: { message: '{"detail":"Bad Request"}', additionalDetails: null },
        items: [{ id: "question", type: "userMessage", content: [{ type: "text", text: "Reply CHECK-OK. No tools." }] }],
      } },
    });
    expect(state.threads["failed-task"]).toMatchObject({ status: "error", activeTurnId: undefined });
    expect(state.threads["failed-task"].turns["failed-turn"]).toMatchObject({
      status: "failed", error: { message: '{"detail":"Bad Request"}', additionalDetails: null },
      itemOrder: ["question"],
    });
    const replay = reduceCodexState(state, {
      method: "turn/completed", params: { threadId: "failed-task", turn: { id: "failed-turn", status: "completed" } },
    });
    expect(replay.threads["failed-task"]).toMatchObject({ status: "error" });
    expect(replay.threads["failed-task"].turns["failed-turn"]).toMatchObject({ status: "failed", error: { message: '{"detail":"Bad Request"}' } });
    const idleStatus = reduceCodexState(replay, { method: "thread/status/changed", params: {
      threadId: "failed-task", status: { type: "idle" },
    } });
    expect(idleStatus.threads["failed-task"].status).toBe("error");
  });

  it("upgrades an inferred completed turn to failed while preserving an assistant response", () => {
    const completed = reduceCodexState(initialCodexState, {
      method: "turn/completed", params: { threadId: "t", turn: { id: "turn", status: "completed", items: [
        { id: "answer", type: "agentMessage", text: "Partial result" },
      ] } },
    });
    const failed = reduceCodexState(completed, {
      method: "turn/completed", params: { threadId: "t", turn: {
        id: "turn", status: "failed", error: { message: "Bad Request" },
      } },
    });
    expect(failed.threads.t.turns.turn).toMatchObject({ status: "failed", error: { message: "Bad Request" } });
    expect(failed.threads.t.turns.turn.items.answer.text).toBe("Partial result");
  });

  it("does not turn a newer successful task into an error when an older failure arrives late", () => {
    let state = initialCodexState;
    for (const id of ["older", "newer"]) {
      state = reduceCodexState(state, { method: "turn/completed", params: { threadId: "t", turn: { id, status: "completed" } } });
    }
    const failed = reduceCodexState(state, { method: "turn/completed", params: { threadId: "t", turn: {
      id: "older", status: "failed", error: { message: "Old failure" },
    } } });
    expect(failed.threads.t.status).toBe("idle");
    expect(failed.threads.t.turns.older).toMatchObject({ status: "failed", error: { message: "Old failure" } });
  });

  it("keeps a longer retained raw prefix when reconnect replays an older snapshot", () => {
    const state = reduceCodexState(initialCodexState, {
      method: "item/agentMessage/delta",
      params: { threadId: "t", turnId: "turn", itemId: "a", delta: "**Hello** world" },
    });
    const restored = reduceCodexState(state, {
      method: "gateway/agentMessageSnapshot",
      params: { threadId: "t", turnId: "turn", itemId: "a", text: "**Hello**" },
    });
    expect(restored.threads.t.turns.turn.items.a).toMatchObject({
      text: "**Hello** world", streamedText: "**Hello** world",
    });
  });

  it("does not reopen a completed body when a reconnect snapshot arrives late", () => {
    const state = reduceCodexState(initialCodexState, {
      method: "item/completed",
      params: { threadId: "t", turnId: "turn", item: {
        id: "a", type: "agentMessage", text: "Done", phase: "final_answer",
      } },
    });
    const restored = reduceCodexState(state, {
      method: "gateway/agentMessageSnapshot",
      params: { threadId: "t", turnId: "turn", itemId: "a", text: "Do", phase: "commentary" },
    });
    expect(restored.threads.t.turns.turn.items.a).toEqual(state.threads.t.turns.turn.items.a);
  });

  it("preserves the assistant message phase from item notifications", () => {
    const next = reduceCodexState(initialCodexState, {
      method: "item/completed",
      params: {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          id: "agent-final",
          type: "agentMessage",
          text: "Done",
          phase: "final_answer",
          status: "completed",
        },
      },
    });

    expect(next.threads.t1.turns["turn-1"].items["agent-final"].phase).toBe("final_answer");
  });

  it("appends streamed agent text without mutating the previous state", () => {
    const state = {
      ...initialCodexState,
      threads: {
        t1: {
          id: "t1",
          title: "Task one",
          status: "running" as const,
          turnOrder: ["turn-1"],
          turns: {
            "turn-1": {
              id: "turn-1",
              status: "inProgress" as const,
              itemOrder: ["i1"],
              items: {
                i1: { id: "i1", type: "agentMessage", text: "hello" },
              },
            },
          },
        },
      },
      threadOrder: ["t1"],
    };

    const next = reduceCodexState(state, {
      method: "item/agentMessage/delta",
      params: { threadId: "t1", turnId: "turn-1", itemId: "i1", delta: " world" },
    });

    expect(next.threads.t1.turns["turn-1"].items.i1.text).toBe("hello world");
    expect(state.threads.t1.turns["turn-1"].items.i1.text).toBe("hello");
  });

  it("keeps repeated long chunks because text equality is not an event identity", () => {
    const first = reduceCodexState(initialCodexState, {
      method: "item/agentMessage/delta",
      params: { threadId: "t1", turnId: "turn-1", itemId: "agent-1", delta: "Full response" },
    });
    const repeated = reduceCodexState(first, {
      method: "item/agentMessage/delta",
      params: { threadId: "t1", turnId: "turn-1", itemId: "agent-1", delta: "Full response" },
    });

    expect(repeated.threads.t1.turns["turn-1"].items["agent-1"].text).toBe("Full responseFull response");
    expect(repeated.threads.t1.turns["turn-1"].items["agent-1"].streamedText).toBe("Full responseFull response");
  });

  it("keeps identical short assistant deltas because they can be legitimate tokens", () => {
    const first = reduceCodexState(initialCodexState, {
      method: "item/agentMessage/delta",
      params: { threadId: "t1", turnId: "turn-1", itemId: "agent-1", delta: "哈" },
    });
    const repeated = reduceCodexState(first, {
      method: "item/agentMessage/delta",
      params: { threadId: "t1", turnId: "turn-1", itemId: "agent-1", delta: "哈" },
    });

    expect(repeated.threads.t1.turns["turn-1"].items["agent-1"].text).toBe("哈哈");
    expect(repeated.threads.t1.turns["turn-1"].items["agent-1"].streamedText).toBe("哈哈");
  });

  it("does not duplicate a delta already present in the Desktop visible text", () => {
    const started = reduceCodexState(initialCodexState, {
      method: "turn/started",
      params: { threadId: "t1", turn: { id: "turn-1" } },
    });
    const visible = reduceCodexState(started, {
      method: "desktop/visibleAgentMessage",
      params: {
        threadId: "t1",
        turnId: "turn-1",
        itemId: "agent-1",
        text: "hello world",
      },
    });
    const duplicatedDelta = reduceCodexState(visible, {
      method: "item/agentMessage/delta",
      params: { threadId: "t1", turnId: "turn-1", itemId: "agent-1", delta: " world" },
    });

    expect(duplicatedDelta.threads.t1.turns["turn-1"].items["agent-1"].text).toBe("hello world");
  });

  it("continues streaming after the Desktop visible text catches up", () => {
    const streamed = reduceCodexState(initialCodexState, {
      method: "item/agentMessage/delta",
      params: { threadId: "t1", turnId: "turn-1", itemId: "agent-1", delta: "hello" },
    });
    const visible = reduceCodexState(streamed, {
      method: "desktop/visibleAgentMessage",
      params: {
        threadId: "t1",
        turnId: "turn-1",
        itemId: "agent-1",
        text: "hello world",
      },
    });
    const continued = reduceCodexState(visible, {
      method: "item/agentMessage/delta",
      params: { threadId: "t1", turnId: "turn-1", itemId: "agent-1", delta: "!" },
    });

    expect(continued.threads.t1.turns["turn-1"].items["agent-1"].text).toBe("hello world!");
  });

  it("creates a streamed item inside its server turn when the start notification was missed", () => {
    const next = reduceCodexState(initialCodexState, {
      method: "item/agentMessage/delta",
      params: { threadId: "t1", turnId: "turn-1", itemId: "i1", delta: "hello" },
    });

    expect(next.threadOrder).toEqual(["t1"]);
    expect(next.threads.t1.turnOrder).toEqual(["turn-1"]);
    expect(next.threads.t1.turns["turn-1"].itemOrder).toEqual(["i1"]);
    expect(next.threads.t1.turns["turn-1"].items.i1.text).toBe("hello");
  });

  it("replaces a visible Desktop assistant message and reuses its persisted item", () => {
    const started = reduceCodexState(initialCodexState, {
      method: "turn/started",
      params: { threadId: "t1", turn: { id: "turn-1" } },
    });
    const live = reduceCodexState(started, {
      method: "desktop/visibleAgentMessage",
      params: {
        threadId: "t1",
        turnId: "turn-1",
        itemId: "agent-1",
        text: "Immediate Desktop text",
      },
    });

    expect(live.threads.t1.turns["turn-1"].items["agent-1"]).toMatchObject({
      type: "agentMessage",
      text: "Immediate Desktop text",
      status: "running",
    });

    const persisted = reduceCodexState(live, {
      method: "item/completed",
      params: {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          id: "agent-1",
          type: "agentMessage",
          text: "Immediate Desktop text",
          status: "completed",
        },
      },
    });

    expect(persisted.threads.t1.turns["turn-1"].itemOrder).toEqual(["agent-1"]);
    expect(persisted.threads.t1.turns["turn-1"].items["agent-1"].status).toBe("completed");

    const completed = reduceCodexState(persisted, {
      method: "turn/completed",
      params: { threadId: "t1", turn: { id: "turn-1", status: "completed" } },
    });
    const lateDomUpdate = reduceCodexState(completed, {
      method: "desktop/visibleAgentMessage",
      params: {
        threadId: "t1",
        turnId: "turn-1",
        itemId: "agent-1",
        text: "Immediate Desktop text with final punctuation.",
      },
    });
    expect(lateDomUpdate.threads.t1.status).toBe("idle");
    expect(lateDomUpdate.threads.t1.turns["turn-1"].status).toBe("completed");
    expect(lateDomUpdate.threads.t1.turns["turn-1"].items["agent-1"].status).toBe("completed");
  });

  it("keeps live items from separate turns separated", () => {
    const first = reduceCodexState(initialCodexState, {
      method: "item/started",
      params: {
        threadId: "t1",
        turnId: "turn-1",
        item: { id: "user-1", type: "userMessage", content: [{ type: "text", text: "First" }] },
      },
    });
    const second = reduceCodexState(first, {
      method: "item/started",
      params: {
        threadId: "t1",
        turnId: "turn-2",
        item: { id: "user-2", type: "userMessage", content: [{ type: "text", text: "Second" }] },
      },
    });

    expect(second.threads.t1.turnOrder).toEqual(["turn-1", "turn-2"]);
    expect(second.threads.t1.turns["turn-1"].items["user-1"].text).toBe("First");
    expect(second.threads.t1.turns["turn-2"].items["user-2"].text).toBe("Second");
  });

  it("replaces an optimistic steer when Desktop confirms it in another turn and type spelling", () => {
    const state = {
      ...initialCodexState,
      threadOrder: ["t1"],
      threads: {
        t1: {
          id: "t1",
          title: "Live task",
          status: "running" as const,
          activeTurnId: "turn-1",
          turnOrder: ["turn-1"],
          turns: {
            "turn-1": {
              id: "turn-1",
              status: "inProgress" as const,
              itemOrder: ["agent-before", "web-steer-1"],
              items: {
                "agent-before": {
                  id: "agent-before",
                  type: "agentMessage",
                  text: "Still working",
                },
                "web-steer-1": {
                  id: "web-steer-1",
                  type: "userMessage",
                  text: "Check this image",
                  imageIds: ["uploaded-image"],
                  status: "completed",
                },
              },
            },
          },
        },
      },
    };

    const next = reduceCodexState(state, {
      method: "item/started",
      params: {
        threadId: "t1",
        turnId: "turn-2",
        item: {
          id: "desktop-user-1",
          type: "user_message",
          content: [{ type: "text", text: "Check this image" }],
        },
      },
    });
    const originalTurn = next.threads.t1.turns["turn-1"];
    const authoritativeTurn = next.threads.t1.turns["turn-2"];

    expect(originalTurn.itemOrder).toEqual(["agent-before"]);
    expect(originalTurn.items["web-steer-1"]).toBeUndefined();
    expect(authoritativeTurn.itemOrder).toEqual(["desktop-user-1"]);
    expect(authoritativeTurn.items["desktop-user-1"]).toMatchObject({
      id: "desktop-user-1",
      type: "user_message",
      text: "Check this image",
      imageIds: ["uploaded-image"],
    });
  });

  it("replaces an optimistic image steer when Desktop appends attachment markup", () => {
    const state = {
      ...initialCodexState,
      threadOrder: ["t1"],
      threads: {
        t1: {
          id: "t1",
          title: "Live task",
          status: "running" as const,
          activeTurnId: "turn-1",
          turnOrder: ["turn-1"],
          turns: {
            "turn-1": {
              id: "turn-1",
              status: "inProgress" as const,
              itemOrder: ["web-steer-image"],
              items: {
                "web-steer-image": {
                  id: "web-steer-image",
                  type: "userMessage",
                  text: "调整移动端标题布局",
                  imageIds: ["uploaded-image"],
                  status: "completed",
                },
              },
            },
          },
        },
      },
    };

    const next = reduceCodexState(state, {
      method: "item/started",
      params: {
        threadId: "t1",
        turnId: "turn-2",
        item: {
          id: "desktop-user-image",
          type: "user_message",
          content: [{
            type: "text",
            text: "调整移动端标题布局\n<image name=[Image #1] path=\"/private/upload.jpg\">\n</image>",
          }],
        },
      },
    });

    expect(next.threads.t1.turns["turn-1"].items["web-steer-image"]).toBeUndefined();
    expect(next.threads.t1.turns["turn-2"].items["desktop-user-image"]).toMatchObject({
      text: expect.stringContaining("调整移动端标题布局"),
      imageIds: ["uploaded-image"],
    });
  });

  it("keeps live and persisted user messages without a shared identity", () => {
    const first = reduceCodexState(initialCodexState, {
      method: "item/started",
      params: {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          id: "desktop-live-user",
          type: "userMessage",
          content: [{ type: "text", text: "继续完成这个任务" }],
          imageIds: ["uploaded-image"],
        },
      },
    });
    const duplicated = reduceCodexState(first, {
      method: "item/started",
      params: {
        threadId: "t1",
        turnId: "turn-2",
        item: {
          id: "desktop-persisted-user",
          type: "user_message",
          content: [{ type: "text", text: "继续完成这个任务" }],
        },
      },
    });

    expect(duplicated.threads.t1.turns["turn-1"].itemOrder).toEqual(["desktop-live-user"]);
    expect(duplicated.threads.t1.turns["turn-2"].itemOrder).toEqual(["desktop-persisted-user"]);
    expect(duplicated.threads.t1.turns["turn-2"].items["desktop-persisted-user"]).toMatchObject({
      text: "继续完成这个任务",
    });
    expect(duplicated.threads.t1.turns["turn-2"].items["desktop-persisted-user"].imageIds).toBeUndefined();
  });

  it.each([
    ["same turn", "turn-1", "继续", undefined, undefined],
    ["different turns", "turn-2", "继续", undefined, undefined],
    ["different images", "turn-1", "看看", ["image-a"], ["image-b"]],
    ["image-only messages", "turn-2", "", ["image-a"], ["image-b"]],
  ] as const)("keeps consecutive confirmed messages with %s and replays each item independently", (_label, secondTurn, text, firstImages, secondImages) => {
    const first = { id: "user-a", type: "userMessage", text, imageIds: firstImages };
    const second = { id: "user-b", type: "userMessage", text, imageIds: secondImages };
    let state = reduceCodexState(initialCodexState, {
      method: "item/started", params: { threadId: "t1", turnId: "turn-1", item: first },
    });
    state = reduceCodexState(state, {
      method: "item/completed", params: { threadId: "t1", turnId: "turn-1", item: {
        id: "tool", type: "commandExecution", text: "done",
      } },
    });
    state = reduceCodexState(state, {
      method: "item/started", params: { threadId: "t1", turnId: secondTurn, item: second },
    });
    for (const [turnId, item] of [["turn-1", first], [secondTurn, second]] as const) {
      state = reduceCodexState(state, {
        method: "item/completed", params: { threadId: "t1", turnId, item },
      });
    }
    expect(state.threads.t1.turns["turn-1"].items["user-a"]).toMatchObject({ text, status: "completed" });
    expect(state.threads.t1.turns[secondTurn].items["user-b"]).toMatchObject({ text, status: "completed" });
    expect(state.threads.t1.turns["turn-1"].items["user-a"].imageIds).toEqual(firstImages);
    expect(state.threads.t1.turns[secondTurn].items["user-b"].imageIds).toEqual(secondImages);
    expect(state.threads.t1.turnOrder.flatMap((id) => state.threads.t1.turns[id].itemOrder))
      .toEqual(["user-a", "tool", "user-b"]);
  });

  it.each(["pending", "confirmed"] as const)("preserves a %s message's position when its shared client identity is confirmed late", (lifecycle) => {
    let state = pendingMessages([
      { id: "live-a", type: "userMessage", clientMessageId: "client-a", text: "first", lifecycle },
      { id: "tool", type: "commandExecution", text: "done" },
      { id: "live-b", type: "userMessage", clientMessageId: "client-b", text: "second", lifecycle: "confirmed" },
    ]);
    state = reduceCodexState(state, {
      method: "item/completed", params: { threadId: "t1", turnId: "turn-1", item: {
        id: "persisted-a", type: "userMessage", clientMessageId: "client-a", text: "first",
      } },
    });
    expect(state.threads.t1.turns["turn-1"].itemOrder).toEqual(["persisted-a", "tool", "live-b"]);
    expect(state.threads.t1.turns["turn-1"].items["live-a"]).toBeUndefined();
  });

  function pendingMessages(items: CodexItem[]): CodexState {
    return {
      ...initialCodexState,
      threadOrder: ["t1"],
      threads: { t1: {
        id: "t1", title: "Task", status: "running", turnOrder: ["turn-1"],
        turns: { "turn-1": {
          id: "turn-1", status: "inProgress", itemOrder: items.map((item) => item.id),
          items: Object.fromEntries(items.map((item) => [item.id, item])),
        } },
      } },
    };
  }

  it.each(["看看", ""])("matches out-of-order optimistic image confirmations for text %j", (text) => {
    let state = pendingMessages([
      { id: "web-steer-a", type: "userMessage", text, imageIds: ["image-a"], lifecycle: "pending" },
      { id: "web-steer-b", type: "userMessage", text, imageIds: ["image-b"], lifecycle: "pending" },
    ]);
    const confirmB = {
      method: "item/started", params: { threadId: "t1", turnId: "turn-2", item: {
        id: "confirmed-b", type: "userMessage", text, imageIds: ["image-b"],
      } },
    };
    state = reduceCodexState(state, confirmB);
    expect(state.threads.t1.turns["turn-1"].itemOrder).toEqual(["web-steer-a"]);
    expect(state.threads.t1.turns["turn-2"].items["confirmed-b"].imageIds).toEqual(["image-b"]);
    state = reduceCodexState(state, confirmB);
    expect(state.threads.t1.turns["turn-1"].itemOrder).toEqual(["web-steer-a"]);
    state = reduceCodexState(state, {
      method: "item/started", params: { threadId: "t1", turnId: "turn-2", item: {
        id: "confirmed-a", type: "userMessage", text, imageIds: ["image-a"],
      } },
    });
    expect(state.threads.t1.turns["turn-1"].itemOrder).toEqual([]);
    expect(state.threads.t1.turns["turn-2"].items["confirmed-a"].imageIds).toEqual(["image-a"]);
  });

  it("preserves ambiguous optimistic candidates when confirmation has no client identity", () => {
    const state = pendingMessages([
      { id: "web-steer-a", type: "userMessage", text: "继续", clientMessageId: "a", lifecycle: "pending" },
      { id: "web-steer-b", type: "userMessage", text: "继续", clientMessageId: "b", lifecycle: "pending" },
    ]);
    const confirmed = reduceCodexState(state, {
      method: "item/started", params: { threadId: "t1", turnId: "turn-2", item: {
        id: "confirmed", type: "userMessage", text: "继续",
      } },
    });
    expect(confirmed.threads.t1.turns["turn-1"].itemOrder).toEqual(["web-steer-a", "web-steer-b"]);
  });

  it("does not consume an optimistic message with a conflicting client identity", () => {
    const state = pendingMessages([
      { id: "web-steer-a", type: "userMessage", text: "继续", clientMessageId: "a", lifecycle: "pending" },
    ]);
    const confirmed = reduceCodexState(state, {
      method: "item/started", params: { threadId: "t1", turnId: "turn-2", item: {
        id: "confirmed-b", clientMessageId: "b", type: "userMessage", text: "继续",
      } },
    });
    expect(confirmed.threads.t1.turns["turn-1"].itemOrder).toEqual(["web-steer-a"]);
  });

  it("keeps equal user messages when an assistant reply separates them", () => {
    const first = reduceCodexState(initialCodexState, {
      method: "item/started",
      params: {
        threadId: "t1",
        turnId: "turn-1",
        item: { id: "user-1", type: "userMessage", content: [{ type: "text", text: "再试一次" }] },
      },
    });
    const replied = reduceCodexState(first, {
      method: "item/started",
      params: {
        threadId: "t1",
        turnId: "turn-1",
        item: { id: "agent-1", type: "agentMessage", content: [{ type: "text", text: "已经处理" }] },
      },
    });
    const repeated = reduceCodexState(replied, {
      method: "item/started",
      params: {
        threadId: "t1",
        turnId: "turn-2",
        item: { id: "user-2", type: "userMessage", content: [{ type: "text", text: "再试一次" }] },
      },
    });

    expect(repeated.threads.t1.turns["turn-1"].itemOrder).toEqual(["user-1", "agent-1"]);
    expect(repeated.threads.t1.turns["turn-2"].itemOrder).toEqual(["user-2"]);
  });

  it("keeps consecutive equal user messages when their client identities differ", () => {
    const first = reduceCodexState(initialCodexState, {
      method: "item/started",
      params: {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          id: "user-1",
          clientMessageId: "client-1",
          type: "userMessage",
          content: [{ type: "text", text: "继续" }],
        },
      },
    });
    const second = reduceCodexState(first, {
      method: "item/started",
      params: {
        threadId: "t1",
        turnId: "turn-2",
        item: {
          id: "user-2",
          clientMessageId: "client-2",
          type: "userMessage",
          content: [{ type: "text", text: "继续" }],
        },
      },
    });

    expect(second.threads.t1.turns["turn-1"].itemOrder).toEqual(["user-1"]);
    expect(second.threads.t1.turns["turn-2"].itemOrder).toEqual(["user-2"]);
  });

  it("replaces one identified optimistic message when Desktop omits the client identity", () => {
    const state = {
      ...initialCodexState,
      threadOrder: ["t1"],
      threads: {
        t1: {
          id: "t1",
          title: "Live task",
          status: "running" as const,
          activeTurnId: "turn-1",
          turnOrder: ["turn-1"],
          turns: {
            "turn-1": {
              id: "turn-1",
              status: "inProgress" as const,
              itemOrder: ["web-steer-client-1"],
              items: {
                "web-steer-client-1": {
                  id: "web-steer-client-1",
                  clientMessageId: "client-1",
                  lifecycle: "pending" as const,
                  type: "userMessage",
                  text: "继续",
                },
              },
            },
          },
        },
      },
    };

    const confirmed = reduceCodexState(state, {
      method: "item/started",
      params: {
        threadId: "t1",
        turnId: "turn-2",
        item: {
          id: "desktop-user-1",
          type: "userMessage",
          content: [{ type: "text", text: "继续" }],
        },
      },
    });

    expect(confirmed.threads.t1.turns["turn-1"].itemOrder).toEqual([]);
    expect(confirmed.threads.t1.turns["turn-2"].itemOrder).toEqual(["desktop-user-1"]);
  });

  it("replaces an exact optimistic message when Desktop reuses an authoritative id and text", () => {
    const state = {
      ...initialCodexState,
      threadOrder: ["t1"],
      threads: {
        t1: {
          id: "t1",
          title: "Live task",
          status: "running" as const,
          activeTurnId: "turn-2",
          turnOrder: ["turn-1", "turn-2"],
          turns: {
            "turn-1": {
              id: "turn-1",
              status: "completed" as const,
              itemOrder: ["desktop-reused-user"],
              items: {
                "desktop-reused-user": {
                  id: "desktop-reused-user",
                  clientMessageId: "client-old",
                  lifecycle: "confirmed" as const,
                  type: "userMessage",
                  text: "继续",
                },
              },
            },
            "turn-2": {
              id: "turn-2",
              status: "inProgress" as const,
              itemOrder: ["web-steer-client-new"],
              items: {
                "web-steer-client-new": {
                  id: "web-steer-client-new",
                  clientMessageId: "client-new",
                  lifecycle: "pending" as const,
                  type: "userMessage",
                  text: "继续",
                },
              },
            },
          },
        },
      },
    };

    const confirmed = reduceCodexState(state, {
      method: "item/started",
      params: {
        threadId: "t1",
        turnId: "turn-2",
        item: {
          id: "desktop-reused-user",
          clientMessageId: "client-new",
          type: "userMessage",
          content: [{ type: "text", text: "继续" }],
        },
      },
    });

    expect(confirmed.threads.t1.turns["turn-1"].itemOrder).toEqual([]);
    expect(confirmed.threads.t1.turns["turn-1"].items["desktop-reused-user"]).toBeUndefined();
    expect(confirmed.threads.t1.turns["turn-2"].itemOrder).toEqual(["desktop-reused-user"]);
    expect(confirmed.threads.t1.turns["turn-2"].items["desktop-reused-user"]).toMatchObject({
      clientMessageId: "client-new",
      lifecycle: "confirmed",
      text: "继续",
    });
    expect(confirmed.threads.t1.turnOrder.flatMap((turnId) =>
      confirmed.threads.t1.turns[turnId].itemOrder.filter((itemId) => itemId === "desktop-reused-user")
    )).toHaveLength(1);
  });

  it("does not let an old turn completion stop a newer active turn", () => {
    const first = reduceCodexState(initialCodexState, {
      method: "turn/started",
      params: { threadId: "t1", turn: { id: "turn-1" } },
    });
    const second = reduceCodexState(first, {
      method: "turn/started",
      params: { threadId: "t1", turn: { id: "turn-2" } },
    });
    const lateCompletion = reduceCodexState(second, {
      method: "turn/completed",
      params: { threadId: "t1", turn: { id: "turn-1", status: "completed" } },
    });

    expect(lateCompletion.threads.t1).toMatchObject({
      status: "running",
      activeTurnId: "turn-2",
    });
    expect(lateCompletion.threads.t1.turns["turn-1"].status).toBe("completed");
    expect(lateCompletion.threads.t1.turns["turn-2"].status).toBe("inProgress");
  });

  it("keeps a completed turn terminal when a late tool event arrives", () => {
    const started = reduceCodexState(initialCodexState, {
      method: "turn/started",
      params: { threadId: "t1", turn: { id: "turn-1" } },
    });
    const completed = reduceCodexState(started, {
      method: "turn/completed",
      params: { threadId: "t1", turn: { id: "turn-1", status: "completed" } },
    });
    const lateTool = reduceCodexState(completed, {
      method: "item/mcpToolCall/progress",
      params: {
        threadId: "t1",
        turnId: "turn-1",
        itemId: "tool-1",
        message: "late progress",
      },
    });

    expect(lateTool.threads.t1.status).toBe("idle");
    expect(lateTool.threads.t1.activeTurnId).toBeUndefined();
    expect(lateTool.threads.t1.turns["turn-1"].status).toBe("completed");
    expect(lateTool.threads.t1.turns["turn-1"].items["tool-1"].status).toBe("completed");
  });

  it("finishes still-running items when their turn completes", () => {
    const started = reduceCodexState(initialCodexState, {
      method: "item/started",
      params: {
        threadId: "t1",
        turnId: "turn-1",
        item: { id: "tool-1", type: "commandExecution", command: "pnpm test" },
      },
    });

    const completed = reduceCodexState(started, {
      method: "turn/completed",
      params: { threadId: "t1", turn: { id: "turn-1", status: "completed" } },
    });

    expect(completed.threads.t1.turns["turn-1"].status).toBe("completed");
    expect(completed.threads.t1.turns["turn-1"].items["tool-1"].status).toBe("completed");
  });

  it("renders a Desktop image event immediately without exposing its local path envelope", () => {
    const next = reduceCodexState(initialCodexState, {
      method: "item/started",
      params: {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          id: "desktop-image",
          type: "userMessage",
          content: [{
            type: "text",
            text: "# Files mentioned by the user:\n\nprivate.png\n\n## My request:\n看看这张图\n<image name=[Image #1] path=\"/private/image.png\">\n</image>",
          }],
          imageIds: ["imported-image"],
        },
      },
    });

    expect(next.threads.t1.turns["turn-1"].items["desktop-image"]).toMatchObject({
      text: "看看这张图",
      imageIds: ["imported-image"],
    });
  });

  it("updates thread status from notifications", () => {
    const next = reduceCodexState(initialCodexState, {
      method: "thread/status/changed",
      params: { threadId: "t1", status: "idle" },
    });

    expect(next.threads.t1.status).toBe("idle");
  });

  it("keeps the latest Desktop todo list with normalized live statuses", () => {
    const next = reduceCodexState(initialCodexState, {
      method: "turn/plan/updated",
      params: {
        threadId: "t1",
        turnId: "turn-1",
        explanation: "Implementation plan",
        plan: [
          { step: "Inspect protocol", status: "completed" },
          { step: "Build UI", status: "in_progress" },
          { step: "Run tests", status: "pending" },
        ],
      },
    });

    expect(next.threads.t1.todoList).toEqual({
      turnId: "turn-1",
      explanation: "Implementation plan",
      items: [
        { step: "Inspect protocol", status: "completed" },
        { step: "Build UI", status: "inProgress" },
        { step: "Run tests", status: "pending" },
      ],
    });
  });

  it("clears a turn todo list when that turn reaches a terminal state", () => {
    const started = reduceCodexState(initialCodexState, {
      method: "turn/started",
      params: { threadId: "t1", turn: { id: "turn-1" } },
    });
    const planned = reduceCodexState(started, {
      method: "turn/plan/updated",
      params: {
        threadId: "t1",
        turnId: "turn-1",
        plan: [{ step: "Finish", status: "inProgress" }],
      },
    });
    const completed = reduceCodexState(planned, {
      method: "turn/completed",
      params: { threadId: "t1", turn: { id: "turn-1", status: "completed" } },
    });

    expect(completed.threads.t1.todoList).toBeUndefined();
  });

  it("aggregates command, plan, tool, file, and terminal event streams in their turn", () => {
    const notifications = [
      {
        method: "item/commandExecution/outputDelta",
        params: { threadId: "t1", turnId: "turn-1", itemId: "command", delta: "PASS\n" },
      },
      {
        method: "item/commandExecution/terminalInteraction",
        params: { threadId: "t1", turnId: "turn-1", itemId: "command", stdin: "y\n" },
      },
      {
        method: "item/plan/delta",
        params: { threadId: "t1", turnId: "turn-1", itemId: "plan", delta: "Run tests" },
      },
      {
        method: "item/mcpToolCall/progress",
        params: { threadId: "t1", turnId: "turn-1", itemId: "tool", message: "Searching" },
      },
      {
        method: "item/fileChange/patchUpdated",
        params: {
          threadId: "t1",
          turnId: "turn-1",
          itemId: "files",
          changes: [{ path: "src/app.ts", kind: "update" }, { path: "src/new.ts", kind: "add" }],
        },
      },
    ];

    const state = notifications.reduce(reduceCodexState, initialCodexState);
    const items = state.threads.t1.turns["turn-1"].items;
    expect(items.command).toMatchObject({
      type: "commandExecution",
      text: "PASS\n> y\n",
      status: "running",
    });
    expect(items.plan).toMatchObject({ type: "plan", text: "Run tests" });
    expect(items.tool).toMatchObject({ type: "mcpToolCall", text: "Searching" });
    expect(items.files).toMatchObject({
      type: "fileChange",
      text: "update src/app.ts\nadd src/new.ts",
    });
    expect(state.threads.t1.turns["turn-1"].itemOrder).toEqual([
      "command",
      "plan",
      "tool",
      "files",
    ]);
  });

  it("applies authoritative name and settings notifications", () => {
    const named = reduceCodexState(initialCodexState, {
      method: "thread/name/updated",
      params: { threadId: "t1", name: "Desktop title" },
    });
    const configured = reduceCodexState(named, {
      method: "thread/settings/updated",
      params: {
        threadId: "t1",
        threadSettings: {
          model: "gpt-5.6-sol",
          effort: "high",
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandboxPolicy: { type: "dangerFullAccess" },
          activePermissionProfile: null,
        },
      },
    });

    expect(configured.threads.t1).toMatchObject({
      title: "Desktop title",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      permission: "full-access",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "dangerFullAccess" },
    });
  });

  it("distinguishes Desktop guardian approval from normal request approval", () => {
    const configured = reduceCodexState(initialCodexState, {
      method: "thread/settings/updated",
      params: {
        threadId: "t1",
        threadSettings: {
          approvalPolicy: "on-request",
          approvalsReviewer: "guardian_subagent",
          sandboxPolicy: { type: "workspaceWrite" },
          activePermissionProfile: { id: ":workspace" },
        },
      },
    });

    expect(configured.threads.t1).toMatchObject({
      permission: "guardian-approvals",
      permissionProfile: ":workspace",
      approvalPolicy: "on-request",
      approvalsReviewer: "guardian_subagent",
    });
  });
});
