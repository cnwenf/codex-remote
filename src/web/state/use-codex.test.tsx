import { act, renderHook, waitFor } from "@testing-library/react";
import { describe, expect, it, vi } from "vitest";
import { CodexSocket, type BrowserSocket } from "../api/socket";
import { initialCodexState, type CodexState } from "../../protocol/thread-store";
import { addOptimisticUserMessage, ConversationReconciler, useCodex } from "./use-codex";

class FakeBrowserSocket implements BrowserSocket {
  readonly OPEN = 1;
  readyState = this.OPEN;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;
  constructor() {
    queueMicrotask(() => this.serverSend({ type: "session", state: "ready" }));
  }
  send(data: string) { this.sent.push(data); }
  close() { this.readyState = 3; this.onclose?.(); }
  serverSend(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

function taskListRequests(fake: FakeBrowserSocket, start = 0) {
  const requests = fake.sent.slice(start).map((value) => JSON.parse(value).payload);
  return {
    live: requests.find((request) => request.method === "thread/list"),
    desktop: requests.find((request) => request.method === "desktopState/listThreads"),
  };
}

function latestTurnResponse(socket: CodexSocket, turn: { id: string; status: string }) {
  const request = socket.request.bind(socket);
  vi.spyOn(socket, "request").mockImplementation((method, params, options) => {
    if (method !== "thread/turns/list") return request(method, params, options);
    expect(params).toEqual({ threadId: "t1", limit: 1, sortDirection: "desc", itemsView: "notLoaded" });
    return Promise.resolve({ data: [{ ...turn, items: [], itemsView: "notLoaded" }], nextCursor: null });
  });
}

function runningCommandState(): CodexState {
  return { stale: false, threadOrder: ["t1"], threads: { t1: {
    id: "t1", title: "Task", status: "running", activeTurnId: "turn-1", turnOrder: ["turn-1"],
    turns: { "turn-1": { id: "turn-1", status: "inProgress", itemOrder: ["tool-1"], items: {
      "tool-1": { id: "tool-1", type: "commandExecution", text: "", status: "running" },
    } } },
  } } };
}

describe("ConversationReconciler", () => {
  it("preserves the assistant message phase from a Desktop snapshot", () => {
    const reconciler = new ConversationReconciler();

    const next = reconciler.hydrate(initialCodexState, {
      desktopMirror: true,
      thread: {
        id: "t1",
        status: { type: "idle" },
        turns: [{
          id: "turn-1",
          status: "completed",
          items: [{
            id: "agent-final",
            type: "agentMessage",
            text: "Done",
            phase: "final_answer",
          }],
        }],
      },
    });

    expect(next.threads.t1.turns["turn-1"].items["agent-final"].phase).toBe("final_answer");
  });

  it("keeps a snapshot final-answer phase when the matching live item has no phase", () => {
    const reconciler = new ConversationReconciler();
    const state: CodexState = {
      stale: false,
      threadOrder: ["t1"],
      threads: {
        t1: {
          id: "t1",
          title: "Task",
          status: "idle",
          turnOrder: ["turn-1"],
          turns: {
            "turn-1": {
              id: "turn-1",
              status: "completed",
              itemOrder: ["agent-final"],
              items: {
                "agent-final": {
                  id: "agent-final",
                  type: "agentMessage",
                  text: "Done",
                  phase: undefined,
                },
              },
            },
          },
        },
      },
    };

    const next = reconciler.hydrate(state, {
      desktopMirror: true,
      thread: {
        id: "t1",
        status: { type: "idle" },
        turns: [{
          id: "turn-1",
          status: "completed",
          items: [{
            id: "agent-final",
            type: "agentMessage",
            text: "Done",
            phase: "final_answer",
          }],
        }],
      },
    });

    expect(next.threads.t1.turns["turn-1"].items["agent-final"].phase).toBe("final_answer");
  });

  it("selects the latest in-progress turn from a recovered Desktop snapshot", () => {
    const reconciler = new ConversationReconciler();

    const next = reconciler.hydrate(initialCodexState, {
      desktopMirror: true,
      thread: {
        id: "t1",
        status: { type: "active" },
        turns: [
          {
            id: "turn-stale",
            status: "inProgress",
            items: [{ id: "old-tool", type: "commandExecution", status: "running" }],
          },
          {
            id: "turn-current",
            status: "inProgress",
            items: [{ id: "new-agent", type: "agentMessage", text: "current output" }],
          },
        ],
      },
    });

    expect(next.threads.t1.activeTurnId).toBe("turn-current");
    expect(next.threads.t1.turns["turn-stale"]).toMatchObject({ status: "completed" });
    expect(next.threads.t1.turns["turn-stale"].items["old-tool"]).toMatchObject({ status: "completed" });
  });

  it("does not restore a completed turn todo from a stale Desktop snapshot", () => {
    const reconciler = new ConversationReconciler();
    const state: CodexState = {
      stale: false,
      threadOrder: ["t1"],
      threads: {
        t1: {
          id: "t1",
          title: "Task",
          status: "idle",
          turnOrder: ["turn-1"],
          turns: {
            "turn-1": {
              id: "turn-1",
              status: "completed",
              itemOrder: ["agent-1"],
              items: {
                "agent-1": { id: "agent-1", type: "agentMessage", text: "newer final text" },
              },
            },
          },
        },
      },
    };

    const next = reconciler.hydrate(state, {
      desktopMirror: true,
      thread: {
        id: "t1",
        status: { type: "active" },
        turns: [{
          id: "turn-1",
          status: "inProgress",
          items: [
            { id: "agent-1", type: "agentMessage", text: "older" },
            {
              id: "todo-1",
              type: "todoList",
              plan: [{ step: "Already done", status: "inProgress" }],
            },
          ],
        }],
      },
    });

    expect(next.threads.t1.status).toBe("idle");
    expect(next.threads.t1.turns["turn-1"].status).toBe("completed");
    expect(next.threads.t1.turns["turn-1"].items["agent-1"].text).toBe("newer final text");
    expect(next.threads.t1.todoList).toBeUndefined();
  });

  it("keeps an accepted queue promotion until an authoritative message confirms it", () => {
    const reconciler = new ConversationReconciler();
    const current = {
      t1: [{
        id: "client-1",
        text: "continue",
        lifecycle: "promoting" as const,
        promotedAt: 1,
      }],
    };

    const reconciled = reconciler.reconcileQueueSnapshot(current, "t1", [], 20_000);
    expect(reconciled.t1).toEqual([expect.objectContaining({ id: "client-1", lifecycle: "promoting" })]);
  });

  it("marks an unconfirmed queue promotion failed after the confirmation window", () => {
    const reconciler = new ConversationReconciler();
    const current = {
      t1: [{
        id: "client-1",
        text: "continue",
        lifecycle: "promoting" as const,
        promotedAt: 1,
      }],
    };

    const reconciled = reconciler.reconcileQueueSnapshot(current, "t1", [], 30_002);
    expect(reconciled.t1).toEqual([expect.objectContaining({ id: "client-1", lifecycle: "failed" })]);
  });

  it("confirms only the matching promoted message from a Desktop snapshot", () => {
    const reconciler = new ConversationReconciler();
    const current = {
      t1: [
        { id: "client-1", text: "continue", lifecycle: "promoting" as const },
        { id: "client-2", text: "continue", lifecycle: "promoting" as const },
      ],
    };

    const reconciled = reconciler.confirmQueuedFromSnapshot(current, {
      thread: {
        id: "t1",
        turns: [{
          id: "turn-1",
          items: [{
            id: "user-2",
            type: "userMessage",
            clientMessageId: "client-2",
            text: "continue",
          }],
        }],
      },
    });

    expect(reconciled.t1).toEqual([expect.objectContaining({ id: "client-1" })]);
  });

  it("does not let a replayed queue confirmation remove another identical promoted message", () => {
    const reconciler = new ConversationReconciler();
    const current = {
      t1: [
        { id: "client-1", text: "continue", lifecycle: "promoting" as const },
        { id: "client-2", text: "continue", lifecycle: "promoting" as const },
      ],
    };
    const reconciled = reconciler.confirmQueuedFromSnapshot(current, {
      thread: {
        id: "t1",
        turns: [{
          id: "turn-1",
          items: ["live-2", "persisted-2"].map((id) => ({
            id, type: "userMessage", clientMessageId: "client-2", text: "continue",
          })),
        }],
      },
    });
    expect(reconciled.t1).toEqual([expect.objectContaining({ id: "client-1" })]);
  });

  it("confirms a promoted message when Desktop wraps the user text in an attachment envelope", () => {
    const reconciler = new ConversationReconciler();
    const current = {
      t1: [{ id: "client-1", text: "continue", lifecycle: "promoting" as const }],
    };

    const reconciled = reconciler.confirmQueuedFromSnapshot(current, {
      thread: {
        id: "t1",
        turns: [{
          id: "turn-1",
          items: [{
            id: "user-1",
            type: "userMessage",
            text: "# Files mentioned by the user:\n\n## My request:\ncontinue",
          }],
        }],
      },
    });

    expect(reconciled.t1).toEqual([]);
  });

  it("normalizes both sides of fallback confirmation when queued text contains a request marker", () => {
    const reconciler = new ConversationReconciler();
    const current = {
      t1: [{
        id: "client-1",
        text: "## My request:\ncontinue",
        lifecycle: "promoting" as const,
      }],
    };

    const reconciled = reconciler.confirmQueuedFromSnapshot(current, {
      thread: {
        id: "t1",
        turns: [{
          id: "turn-1",
          items: [{ id: "user-1", type: "userMessage", text: "## My request:\ncontinue" }],
        }],
      },
    });

    expect(reconciled.t1).toEqual([]);
  });

  it("uses an explicit same-turn terminal Desktop snapshot to close retained running state", () => {
    const reconciler = new ConversationReconciler();
    const next = reconciler.hydrate(runningCommandState(), {
      desktopMirror: true,
      thread: { id: "t1", status: { type: "idle" }, turns: [{
        id: "turn-1", status: "completed", items: [],
      }] },
    });

    expect(next.threads.t1.status).toBe("idle");
    expect(next.threads.t1.activeTurnId).toBeUndefined();
    expect(next.threads.t1.turns["turn-1"].status).toBe("completed");
    expect(next.threads.t1.turns["turn-1"].items["tool-1"].status).toBe("completed");
  });

  it("does not let an empty idle Desktop snapshot close retained running state", () => {
    const next = new ConversationReconciler().hydrate(runningCommandState(), {
      desktopMirror: true,
      thread: { id: "t1", status: { type: "idle" }, turns: [] },
    });

    expect(next.threads.t1.status).toBe("running");
    expect(next.threads.t1.activeTurnId).toBe("turn-1");
    expect(next.threads.t1.turns["turn-1"].status).toBe("inProgress");
    expect(next.threads.t1.turns["turn-1"].items["tool-1"].status).toBe("running");
  });

  it("does not let an idle older-history page close the current running turn", () => {
    const reconciler = new ConversationReconciler();
    const state: CodexState = {
      stale: false,
      threadOrder: ["t1"],
      threads: {
        t1: {
          id: "t1",
          title: "Task",
          status: "running",
          activeTurnId: "turn-current",
          turnOrder: ["turn-current"],
          turns: {
            "turn-current": {
              id: "turn-current",
              status: "inProgress",
              itemOrder: ["agent-current"],
              items: {
                "agent-current": { id: "agent-current", type: "agentMessage", text: "working" },
              },
            },
          },
        },
      },
    };

    const next = reconciler.hydrate(state, {
      desktopMirror: true,
      thread: {
        id: "t1",
        status: { type: "idle" },
        turns: [{ id: "turn-old", status: "completed", items: [] }],
      },
    }, "prepend");

    expect(next.threads.t1.status).toBe("running");
    expect(next.threads.t1.activeTurnId).toBe("turn-current");
    expect(next.threads.t1.turns["turn-current"].status).toBe("inProgress");
  });

  it("keeps client message identity while hydrating a Desktop snapshot", () => {
    const reconciler = new ConversationReconciler();
    const next = reconciler.hydrate(initialCodexState, {
      thread: {
        id: "t1",
        turns: [{
          id: "turn-1",
          status: "completed",
          items: [{
            id: "desktop-user-1",
            type: "userMessage",
            clientUserMessageId: "client-1",
            text: "continue",
          }],
        }],
      },
    });

    expect(next.threads.t1.turns["turn-1"].items["desktop-user-1"].clientMessageId).toBe("client-1");
  });

  it("reconciles one authoritative snapshot item with only one of two identical pending sends", () => {
    const reconciler = new ConversationReconciler();
    const base: CodexState = {
      stale: false,
      threadOrder: ["t1"],
      threads: {
        t1: {
          id: "t1",
          title: "Live",
          status: "running",
          activeTurnId: "turn-1",
          turnOrder: ["turn-1"],
          turns: { "turn-1": { id: "turn-1", status: "inProgress", itemOrder: [], items: {} } },
        },
      },
    };
    const first = reconciler.stageUserMessage(base, "t1", "turn-1", "web-steer-1", "继续", []);
    const second = reconciler.stageUserMessage(first, "t1", "turn-1", "web-steer-2", "继续", []);

    const hydrated = reconciler.hydrate(second, {
      desktopMirror: true,
      thread: {
        id: "t1",
        status: { type: "active" },
        turns: [{
          id: "turn-1",
          status: "inProgress",
          items: [{ id: "desktop-user", type: "user_message", text: "继续", clientMessageId: "web-steer-1" }],
        }],
      },
    });
    const matching = Object.values(hydrated.threads.t1.turns["turn-1"].items)
      .filter((item) => item.type.toLocaleLowerCase().includes("user") && item.text === "继续");

    expect(matching).toHaveLength(2);
    expect(matching.map((item) => item.id)).toContain("desktop-user");
  });

  it("reconciles a live confirmed user item with the same Desktop snapshot item id rewrite", () => {
    const reconciler = new ConversationReconciler();
    const state: CodexState = {
      stale: false,
      threadOrder: ["t1"],
      threads: {
        t1: {
          id: "t1",
          title: "Live",
          status: "idle",
          turnOrder: ["turn-1"],
          turns: {
            "turn-1": {
              id: "turn-1",
              status: "completed",
              itemOrder: ["live-user", "live-agent"],
              items: {
                "live-user": {
                  id: "live-user",
                  type: "userMessage",
                  text: "同一条实时消息",
                  lifecycle: "confirmed",
                },
                "live-agent": { id: "live-agent", type: "agentMessage", text: "收到" },
              },
            },
          },
        },
      },
    };

    const hydrated = reconciler.hydrate(state, {
      desktopMirror: true,
      thread: {
        id: "t1",
        status: { type: "idle" },
        turns: [{
          id: "turn-1",
          status: "completed",
          completeFromTurnStart: true,
          items: [
            { id: "item-40", type: "userMessage", text: "同一条实时消息" },
            { id: "item-41", type: "agentMessage", text: "收到" },
          ],
        }],
      },
    });
    const userItems = Object.values(hydrated.threads.t1.turns["turn-1"].items)
      .filter((item) => item.type.toLocaleLowerCase().includes("user"));

    expect(userItems).toHaveLength(1);
    expect(userItems[0].id).toBe("item-40");
  });

  it("preserves two identical confirmed sends when a complete snapshot rewrites both ids", () => {
    const reconciler = new ConversationReconciler();
    const state: CodexState = {
      stale: false,
      threadOrder: ["t1"],
      threads: {
        t1: {
          id: "t1",
          title: "Live",
          status: "idle",
          turnOrder: ["turn-1"],
          turns: {
            "turn-1": {
              id: "turn-1",
              status: "completed",
              itemOrder: ["live-user-1", "live-user-2"],
              items: {
                "live-user-1": { id: "live-user-1", type: "userMessage", text: "继续", lifecycle: "confirmed" },
                "live-user-2": { id: "live-user-2", type: "userMessage", text: "继续", lifecycle: "confirmed" },
              },
            },
          },
        },
      },
    };

    const hydrated = reconciler.hydrate(state, {
      desktopMirror: true,
      thread: {
        id: "t1",
        status: { type: "idle" },
        turns: [{
          id: "turn-1",
          status: "completed",
          completeFromTurnStart: true,
          items: [
            { id: "snapshot-user-1", type: "userMessage", text: "继续" },
            { id: "snapshot-user-2", type: "userMessage", text: "继续" },
          ],
        }],
      },
    });
    const userItems = Object.values(hydrated.threads.t1.turns["turn-1"].items)
      .filter((item) => item.type.toLocaleLowerCase().includes("user"));

    expect(userItems.map((item) => item.id)).toEqual(["snapshot-user-1", "snapshot-user-2"]);
  });

  it("does not merge identical confirmed sends when the snapshot starts inside a turn", () => {
    const reconciler = new ConversationReconciler();
    const state: CodexState = {
      stale: false,
      threadOrder: ["t1"],
      threads: {
        t1: {
          id: "t1",
          title: "Live",
          status: "running",
          activeTurnId: "turn-1",
          turnOrder: ["turn-1"],
          turns: {
            "turn-1": {
              id: "turn-1",
              status: "inProgress",
              itemOrder: ["live-first"],
              items: {
                "live-first": { id: "live-first", type: "userMessage", text: "继续", lifecycle: "confirmed" },
              },
            },
          },
        },
      },
    };

    const hydrated = reconciler.hydrate(state, {
      desktopMirror: true,
      thread: {
        id: "t1",
        status: { type: "active" },
        turns: [{
          id: "turn-1",
          status: "inProgress",
          items: [{ id: "snapshot-later", type: "userMessage", text: "继续" }],
        }],
      },
    });
    const userItems = Object.values(hydrated.threads.t1.turns["turn-1"].items)
      .filter((item) => item.type.toLocaleLowerCase().includes("user"));

    expect(userItems.map((item) => item.id)).toEqual(["snapshot-later", "live-first"]);
  });

  it("does not consume a new pending message with an old same-text item omitted from the snapshot", () => {
    const reconciler = new ConversationReconciler();
    const state: CodexState = {
      stale: false,
      threadOrder: ["t1"],
      threads: {
        t1: {
          id: "t1",
          title: "Live",
          status: "running",
          activeTurnId: "turn-current",
          turnOrder: ["turn-old", "turn-current"],
          turns: {
            "turn-old": {
              id: "turn-old",
              status: "completed",
              itemOrder: ["old-user"],
              items: { "old-user": { id: "old-user", type: "user_message", text: "继续", lifecycle: "confirmed" } },
            },
            "turn-current": {
              id: "turn-current",
              status: "inProgress",
              itemOrder: ["web-steer-new"],
              items: {
                "web-steer-new": {
                  id: "web-steer-new",
                  type: "userMessage",
                  text: "继续",
                  clientMessageId: "web-steer-new",
                  lifecycle: "pending",
                },
              },
            },
          },
        },
      },
    };

    const hydrated = reconciler.hydrate(state, {
      desktopMirror: true,
      thread: {
        id: "t1",
        status: { type: "active" },
        turns: [{ id: "turn-current", status: "inProgress", items: [] }],
      },
    });

    expect(hydrated.threads.t1.turns["turn-current"].items["web-steer-new"]).toMatchObject({
      text: "继续",
      lifecycle: "pending",
    });
  });

  it.each(["snapshot", "prepend"] as const)(
    "does not consume a current pending message with an unchanged old item included in a %s page",
    (placement) => {
      const reconciler = new ConversationReconciler();
      const state: CodexState = {
        stale: false,
        threadOrder: ["t1"],
        threads: {
          t1: {
            id: "t1",
            title: "Live",
            status: "running",
            activeTurnId: "turn-current",
            turnOrder: ["turn-old", "turn-current"],
            turns: {
              "turn-old": {
                id: "turn-old",
                status: "completed",
                itemOrder: ["old-user"],
                items: { "old-user": { id: "old-user", type: "user_message", text: "继续", lifecycle: "confirmed" } },
              },
              "turn-current": {
                id: "turn-current",
                status: "inProgress",
                itemOrder: ["web-steer-new"],
                items: {
                  "web-steer-new": {
                    id: "web-steer-new",
                    type: "userMessage",
                    text: "继续",
                    clientMessageId: "web-steer-new",
                    lifecycle: "pending",
                  },
                },
              },
            },
          },
        },
      };
      const hydrated = reconciler.hydrate(state, {
        desktopMirror: true,
        thread: {
          id: "t1",
          status: { type: "active" },
          turns: [
            { id: "turn-old", status: "completed", items: [{ id: "old-user", type: "user_message", text: "继续" }] },
            { id: "turn-current", status: "inProgress", items: [] },
          ],
        },
      }, placement);

      expect(hydrated.threads.t1.turns["turn-current"].items["web-steer-new"]).toMatchObject({
        text: "继续",
        lifecycle: "pending",
      });
    },
  );
});

describe("start acknowledgement and history identity ordering", () => {
  it.each([
    ["ack", "live", "history"], ["ack", "history", "live"],
    ["live", "ack", "history"], ["live", "history", "ack"],
    ["history", "ack", "live"], ["history", "live", "ack"],
  ])("shows one submission after %s, %s, %s and reconnect replay", async (...order) => {
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    const { result, unmount } = renderHook(() => useCodex(socket));
    const liveId = "01a0811a-d125-7b80-827d-c2e3ace32034";
    const diskId = "msg_01a0811a-d123-7622-8539-ae36da0d8f2b";
    const history = { thread: { id: "t1", status: "active", turns: [{ id: "turn-1", status: "inProgress", items: [
      { id: diskId, type: "userMessage", text: "继续", itemIdAliases: [liveId] },
    ] }] } };
    const live = () => fake.serverSend({ type: "rpc", payload: { method: "item/completed", params: {
      threadId: "t1", turnId: "turn-1", item: { id: liveId, type: "userMessage", text: "继续" },
    } } });
    try {
      await act(() => result.current.connect("secret", "ws://local/rpc"));
      let selection!: Promise<void>;
      act(() => { selection = result.current.selectThread("t1"); });
      const initial = JSON.parse(fake.sent.at(-1)!).payload;
      act(() => fake.serverSend({ type: "rpc", payload: { id: initial.id, result: { thread: { id: "t1", turns: [] } } } }));
      await act(() => selection);
      let sending!: Promise<void>;
      act(() => { sending = result.current.sendInstruction("继续"); });
      const start = JSON.parse(fake.sent.at(-1)!).payload;
      expect(start.method).toBe("turn/start");
      for (const step of order) {
        if (step === "live") act(live);
        if (step === "ack") {
          act(() => fake.serverSend({ type: "rpc", payload: { id: start.id, result: { turn: { id: "turn-1" } } } }));
          await act(() => sending);
        }
        if (step === "history") {
          act(() => { selection = result.current.selectThread("t1"); });
          const read = JSON.parse(fake.sent.at(-1)!).payload;
          act(() => fake.serverSend({ type: "rpc", payload: { id: read.id, result: history } }));
          await act(() => selection);
        }
      }
      act(() => {
        fake.serverSend({ type: "session", state: "reconnecting" });
        fake.serverSend({ type: "session", state: "ready" });
        live();
        fake.serverSend({ type: "rpc", payload: { method: "turn/completed", params: { threadId: "t1", turn: {
          id: "turn-1", status: "completed", items: [
            { id: liveId, type: "userMessage", text: "继续" },
            { id: "final", type: "agentMessage", text: "DONE", phase: "final_answer" },
          ],
        } } } });
      });
      expect(result.current.selectedThread?.turnOrder).toEqual(["turn-1"]);
      expect(result.current.selectedThread?.turns["turn-1"].itemOrder).toEqual([diskId, "final"]);
      expect(result.current.selectedThread?.turns["turn-1"].items.final.text).toBe("DONE");
      expect(result.current.selectedThread?.status).toBe("idle");
    } finally { unmount(); }
  });
});

describe("Desktop history gaps", () => {
  it("waits for the initial history read before polling or establishing another cursor", async () => {
    vi.useFakeTimers();
    const socket = new CodexSocket(() => new FakeBrowserSocket());
    let releaseInitial!: (value: unknown) => void;
    const initial = new Promise(resolve => { releaseInitial = resolve; });
    const turn = (id: string) => ({ id, status: "completed", items: [{ id, type: "agentMessage", text: id }] });
    const latest = {
      desktopMirror: true, historyRange: { start: 500, end: 900 },
      history: { hasMoreBefore: true, beforeCursor: "500" },
      thread: { id: "t1", status: "idle", turns: [turn("latest")] },
    };
    let reads = 0;
    vi.spyOn(socket, "request").mockImplementation(async (method, params) => {
      if (method === "thread/list" || method === "desktopState/listThreads") return { data: [{ id: "t1", status: "idle" }] };
      if (method === "desktopState/readThread") {
        if (++reads === 1) return initial;
        if ((params as { history: { beforeCursor?: string } }).history.beforeCursor === "500") return {
          desktopMirror: true, historyRange: { start: 0, end: 500 }, history: { hasMoreBefore: false },
          thread: { id: "t1", status: "idle", turns: [turn("oldest")] },
        };
        return latest;
      }
      return {};
    });
    const { result, unmount } = renderHook(() => useCodex(socket));
    try {
      await act(() => result.current.connect("secret", "ws://local/rpc"));
      await act(() => result.current.refreshThreads());
      let select!: Promise<void>;
      act(() => { select = result.current.selectThread("t1"); });
      await act(() => vi.advanceTimersByTimeAsync(4_000));
      expect(reads).toBe(1);
      await act(async () => { releaseInitial(latest); await select; });
      await act(() => result.current.loadEarlierThreadHistory());
      expect(result.current.selectedThread?.turnOrder).toEqual(["oldest", "latest"]);
      expect(result.current.selectedThreadHistory.hasMoreBefore).toBe(false);
      await act(() => vi.advanceTimersByTimeAsync(2_000));
      expect(reads).toBe(3);
      expect(result.current.selectedThreadHistory.hasMoreBefore).toBe(false);
    } finally { unmount(); vi.useRealTimers(); }
  });

  it.each(["before-discovery", "initial-read-failed"])("bootstraps bounded Desktop history after a partial native resume: %s", async (failure) => {
    vi.useFakeTimers();
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    const turn = (id: string) => ({ id, status: "completed", items: [{ id, type: "agentMessage", text: id }] });
    let reads = 0;
    const request = vi.spyOn(socket, "request").mockImplementation(async (method, params) => {
      if (method === "thread/list" || method === "desktopState/listThreads") return { data: [{ id: "t1", status: "idle" }] };
      if (method === "thread/resume") return { thread: { id: "t1", status: "idle", turns: [turn("latest")] } };
      if (method === "desktopState/readThread") {
        if (failure === "initial-read-failed" && reads++ === 0) throw new Error("temporary mirror failure");
        const history = (params as { history: { limitTurns: number; beforeCursor?: string } }).history;
        const older = history.beforeCursor === "500";
        return {
          desktopMirror: true,
          historyRange: { start: older ? 0 : 500, end: older ? 500 : 900 },
          history: older ? { hasMoreBefore: false } : { hasMoreBefore: true, beforeCursor: "500" },
          thread: { id: "t1", status: "idle", turns: older ? [turn("oldest")] : history.limitTurns === 1 ? [turn("latest")] : [turn("previous"), turn("latest")] },
        };
      }
      return {};
    });
    const { result, unmount } = renderHook(() => useCodex(socket));
    try {
      await act(() => result.current.connect("secret", "ws://local/rpc"));
      act(() => fake.serverSend({ type: "session", state: "ready", transport: "desktop-live", readOnly: false }));
      if (failure === "initial-read-failed") await act(() => result.current.refreshThreads());
      await act(() => result.current.selectThread("t1"));
      expect(result.current.selectedThread?.turnOrder).toEqual(["latest"]);
      if (failure === "before-discovery") await act(() => result.current.refreshThreads());
      await act(() => vi.advanceTimersByTimeAsync(2_000));
      expect(result.current.selectedThreadHistory).toMatchObject({ hasMoreBefore: true, beforeCursor: "500" });
      expect(result.current.selectedThread?.turnOrder).toEqual(["previous", "latest"]);
      await act(() => result.current.loadEarlierThreadHistory());
      expect(result.current.selectedThread?.turnOrder).toEqual(["oldest", "previous", "latest"]);
      expect(result.current.selectedThreadHistory.hasMoreBefore).toBe(false);
      const readsBeforePoll = request.mock.calls.length;
      await act(() => vi.advanceTimersByTimeAsync(2_000));
      const poll = request.mock.calls.slice(readsBeforePoll).find(([method]) => method === "desktopState/readThread");
      expect(poll?.[1]).toEqual({ threadId: "t1", history: { limitTurns: 1, maxBytes: 2 * 1024 * 1024 } });
      expect(result.current.selectedThreadHistory.hasMoreBefore).toBe(false);
    } finally { unmount(); vi.useRealTimers(); }
  });

  it("keeps newer non-overlapping mirror turns after retained native history", async () => {
    vi.useFakeTimers();
    const socket = new CodexSocket(() => new FakeBrowserSocket());
    const turn = (id: string, startedAt: number) => ({ id, startedAt, status: "completed", items: [{ id, type: "agentMessage", text: id }] });
    let reads = 0;
    vi.spyOn(socket, "request").mockImplementation(async (method) => {
      if (method === "thread/list" || method === "desktopState/listThreads") return { data: [{ id: "t1", status: "idle" }] };
      if (method === "thread/resume") return { thread: { id: "t1", status: "idle", turns: [turn("native-old", 1)] } };
      if (method === "desktopState/readThread") {
        if (++reads === 1) throw new Error("temporary mirror failure");
        return {
          desktopMirror: true, historyRange: { start: 500, end: 900 },
          history: { hasMoreBefore: true, beforeCursor: "500" },
          thread: { id: "t1", status: "idle", turns: [turn("newer-mirror", 2)] },
        };
      }
      return {};
    });
    const { result, unmount } = renderHook(() => useCodex(socket));
    try {
      await act(() => result.current.connect("secret", "ws://local/rpc"));
      await act(() => result.current.refreshThreads());
      await act(() => result.current.selectThread("t1"));
      expect(result.current.selectedThread?.turnOrder).toEqual(["native-old"]);
      await act(() => vi.advanceTimersByTimeAsync(2_000));
      expect(result.current.selectedThread?.turnOrder).toEqual(["native-old", "newer-mirror"]);
      expect(result.current.selectedThreadHistory).toMatchObject({ hasMoreBefore: true, beforeCursor: "500" });
    } finally { unmount(); vi.useRealTimers(); }
  });

  it("inserts a recovered page between retained native history and a newer live turn", async () => {
    vi.useFakeTimers();
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    const turn = (id: string, startedAt: number) => ({ id, startedAt, status: "completed", items: [{ id, type: "agentMessage", text: id }] });
    let releasePage!: (value: unknown) => void;
    const page = new Promise(resolve => { releasePage = resolve; });
    let reads = 0;
    vi.spyOn(socket, "request").mockImplementation(async (method) => {
      if (method === "thread/list" || method === "desktopState/listThreads") return { data: [{ id: "t1", status: "idle" }] };
      if (method === "thread/resume") return { thread: { id: "t1", status: "idle", turns: [turn("native-old", 1)] } };
      if (method === "desktopState/readThread") {
        if (++reads === 1) throw new Error("temporary mirror failure");
        return page;
      }
      return {};
    });
    const { result, unmount } = renderHook(() => useCodex(socket));
    try {
      await act(() => result.current.connect("secret", "ws://local/rpc"));
      await act(() => result.current.refreshThreads());
      await act(() => result.current.selectThread("t1"));
      await act(() => vi.advanceTimersByTimeAsync(2_000));
      act(() => fake.serverSend({ type: "rpc", payload: { method: "turn/started", params: {
        threadId: "t1", turn: { id: "live-new", status: "inProgress", startedAt: 3, items: [] },
      } } }));
      await act(async () => releasePage({
        desktopMirror: true, historyRange: { start: 500, end: 900 },
        history: { hasMoreBefore: true, beforeCursor: "500" },
        thread: { id: "t1", status: "idle", turns: [turn("mirror-middle", 2)] },
      }));
      expect(result.current.selectedThread?.turnOrder).toEqual(["native-old", "mirror-middle", "live-new"]);
      expect(result.current.selectedThread?.activeTurnId).toBe("live-new");
    } finally { unmount(); vi.useRealTimers(); }
  });

  it("places a missing whole turn and partial-turn items before their right-hand history anchors", () => {
    const reconciler = new ConversationReconciler();
    const turn = (id: string, ids: string[]) => ({ id, status: "completed", items: ids.map(id => ({ id, type: "agentMessage", text: id })) });
    const state = reconciler.hydrate(initialCodexState, { thread: { id: "t", turns: [turn("a", ["a"]), turn("b", ["first", "last"]), { ...turn("d", ["d"]), status: "inProgress" }] } });
    const withTurn = reconciler.hydrate(state, { historyAnchor: { turnId: "d", itemId: "d" }, thread: { id: "t", turns: [turn("c", ["c"])] } }, "prepend");
    expect(withTurn.threads.t.turnOrder).toEqual(["a", "b", "c", "d"]);
    const withItem = reconciler.hydrate(withTurn, { historyAnchor: { turnId: "b", itemId: "last" }, thread: { id: "t", turns: [turn("b", ["middle"])] } }, "prepend");
    expect(withItem.threads.t.turns.b.itemOrder).toEqual(["first", "middle", "last"]);
    for (const historyAnchor of [undefined, { turnId: "a", itemId: "a" }]) {
      const after = reconciler.hydrate(state, { historyAnchor, historyAfterAnchor: { turnId: "b", itemId: "first" },
        thread: { id: "t", turns: [turn("c", ["c"])] } }, "prepend");
      expect(after.threads.t.turnOrder).toEqual(["a", "b", "c", "d"]);
      expect(after.threads.t.activeTurnId).toBe("d");
    }
    const afterItem = reconciler.hydrate(state, { historyAfterAnchor: { turnId: "b", itemId: "first" },
      thread: { id: "t", turns: [turn("b", ["middle"])] } }, "prepend");
    expect(afterItem.threads.t.turns.b.itemOrder).toEqual(["first", "middle", "last"]);
    const replay = reconciler.hydrate(state, { historyAnchor: { turnId: "a" }, historyAfterAnchor: { turnId: "b" },
      thread: { id: "t", turns: [turn("a", ["late-tool"]), turn("c", ["c"])] } }, "prepend");
    expect(replay.threads.t.turnOrder).toEqual(["a", "b", "c", "d"]);
    expect(replay.threads.t.turns.a.items["late-tool"].text).toBe("late-tool");
  });
  it.each(["back", "archive", "delete"])("recovers a new paginated image and cancels late gap pages on %s", async (exitAction) => {
    vi.useFakeTimers();
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    const page = (start: number, end: number, turns: unknown[]) => ({
      desktopMirror: true, historyRange: { start, end },
      history: start ? { hasMoreBefore: true, beforeCursor: String(start) } : { hasMoreBefore: false },
      thread: { id: "t1", status: "idle", turns },
    });
    const turn = (id: string, items: unknown[]) => ({ id, status: "completed", items });
    let latest = page(0, 100, [turn("old", [{ id: "old-final", type: "agentMessage", text: "Earlier" }])]);
    let resolveLateGap: ((value: unknown) => void) | undefined;
    const gaps: string[] = [];
    vi.spyOn(socket, "request").mockImplementation(async (method, params) => {
      if (method === "thread/list" || method === "desktopState/listThreads") return { data: [{ id: "t1", status: "idle" }] };
      if (method === "desktopState/readThread") {
        const cursor = (params as any).history.beforeCursor;
        if (!cursor) return latest;
        gaps.push(cursor);
        if (cursor === "2000") return new Promise(resolve => { resolveLateGap = resolve; });
        if (cursor === "300") return page(150, 300, [turn("new", [{ id: "tool", type: "commandExecution", text: "echo ok" }])]);
        if (cursor === "150") return page(50, 150, [turn("new", [{ id: "question", type: "userMessage", text: "Picture", imageIds: ["image-a"] }])]);
        if (Number(cursor) > 400) return page(Number(cursor) - 100, Number(cursor), [turn(`turn-${cursor}`, [])]);
        throw new Error("Unexpected history cursor");
      }
      return {};
    });
    const { result, unmount } = renderHook(() => useCodex(socket));
    try {
      await act(() => result.current.connect("secret", "ws://local/rpc"));
      await act(() => result.current.refreshThreads());
      await act(() => result.current.selectThread("t1"));
      latest = page(300, 400, [turn("new", [{ id: "final", type: "agentMessage", text: "Image received", phase: "final_answer" }])]);
      await act(() => vi.advanceTimersByTimeAsync(2_000));
      expect(gaps).toEqual(["300"]);
      await act(() => vi.advanceTimersByTimeAsync(2_000));
      expect(gaps).toEqual(["300", "150"]);
      expect(result.current.selectedThread?.turns.new.items.question.imageIds).toEqual(["image-a"]);
      expect(result.current.selectedThread?.turns.new.items.final.text).toBe("Image received");
      expect(result.current.selectedThread?.status).toBe("idle");
      expect(result.current.selectedThreadHistory.hasMoreBefore).toBe(false);
      await act(() => vi.advanceTimersByTimeAsync(2_000));
      expect(gaps).toHaveLength(2);
      latest = page(1_400, 1_500, [turn("after-offline", [{ id: "last-final", type: "agentMessage", text: "Last" }])]);
      await act(() => vi.advanceTimersByTimeAsync(20_000));
      expect(gaps).toHaveLength(10); // Two original pages plus eight automatic recovery pages.
      expect(result.current.selectedThreadHistory).toMatchObject({ hasMoreBefore: true, beforeCursor: "600" });
      await act(() => result.current.loadEarlierThreadHistory(true));
      expect(gaps).toHaveLength(10);
      await act(() => result.current.loadEarlierThreadHistory());
      expect(gaps.at(-1)).toBe("600");
      await act(() => result.current.loadEarlierThreadHistory());
      expect(gaps.at(-1)).toBe("500");
      expect(result.current.selectedThreadHistory.hasMoreBefore).toBe(false);
      latest = page(2_000, 2_100, [turn("after-switch", [])]);
      await act(() => vi.advanceTimersByTimeAsync(2_000));
      expect(resolveLateGap).toBeTypeOf("function");
      expect(result.current.selectedThreadHistory.loading).toBe(true);
      await act(async () => {
        if (exitAction === "back") result.current.clearSelection();
        else if (exitAction === "archive") await result.current.archiveThread("t1");
        else await result.current.deleteThread("t1");
      });
      await act(async () => resolveLateGap?.(page(1_500, 2_000, [turn("late-gap", [{ id: "late", type: "agentMessage", text: "Late page" }])])));
      expect(result.current.state.threads.t1?.turns["late-gap"]).toBeUndefined();
    } finally { unmount(); vi.useRealTimers(); }
  });
});

describe("useCodex", () => {
  it("applies a deadline only to the read-only question RPC", async () => {
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    const request = vi.spyOn(socket, "request").mockResolvedValue({
      threadId: "t", turnId: "turn", anchorItemId: "answer", state: "not_found", revision: "1",
    });
    const { result } = renderHook(() => useCodex(socket));

    await result.current.readQuestionContext({ threadId: "t", turnId: "turn", anchorItemId: "answer" });

    expect(request).toHaveBeenCalledWith(
      "desktopState/readQuestionContext",
      { threadId: "t", turnId: "turn", anchorItemId: "answer" },
      { signal: undefined, timeoutMs: 10_000 },
    );
  });

  it("marks only the first task-list request as loading", async () => {
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    const { result } = renderHook(() => useCodex(socket));
    await act(() => result.current.connect("secret", "ws://local/rpc"));

    expect(result.current.threadsLoading).toBe(true);
    let firstRefresh: Promise<void>;
    act(() => { firstRefresh = result.current.refreshThreads(); });
    const firstRequests = fake.sent.map((value) => JSON.parse(value).payload);
    const firstList = firstRequests.find((request) => request.method === "thread/list");
    const firstDesktopList = firstRequests.find((request) => request.method === "desktopState/listThreads");
    fake.serverSend({ type: "rpc", payload: { id: firstList.id, result: { data: [] } } });
    fake.serverSend({ type: "rpc", payload: { id: firstDesktopList.id, result: { data: [] } } });
    await act(() => firstRefresh);
    expect(result.current.threadsLoading).toBe(false);

    let backgroundRefresh: Promise<void>;
    const backgroundStart = fake.sent.length;
    act(() => { backgroundRefresh = result.current.refreshThreads(); });
    expect(result.current.threadsLoading).toBe(false);
    const backgroundRequests = fake.sent.slice(backgroundStart).map((value) => JSON.parse(value).payload);
    const backgroundList = backgroundRequests.find((request) => request.method === "thread/list");
    const backgroundDesktopList = backgroundRequests.find((request) => request.method === "desktopState/listThreads");
    fake.serverSend({ type: "rpc", payload: { id: backgroundList.id, result: { data: [] } } });
    fake.serverSend({ type: "rpc", payload: { id: backgroundDesktopList.id, result: { data: [] } } });
    await act(() => backgroundRefresh);
  });

  it("ignores an older task-list result that finishes after a newer refresh", async () => {
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    const { result } = renderHook(() => useCodex(socket));
    await act(() => result.current.connect("secret", "ws://local/rpc"));

    let olderRefresh: Promise<void>;
    act(() => { olderRefresh = result.current.refreshThreads(); });
    const olderLive = JSON.parse(fake.sent[0]).payload;
    fake.serverSend({ type: "rpc", payload: { id: olderLive.id, result: { data: [] } } });
    await waitFor(() => expect(fake.sent.map((value) => JSON.parse(value).payload.method))
      .toContain("desktopState/listThreads"));
    const olderDesktop = fake.sent.map((value) => JSON.parse(value).payload)
      .find((request) => request.method === "desktopState/listThreads");

    let newerRefresh: Promise<void>;
    act(() => { newerRefresh = result.current.refreshThreads(); });
    const newerLive = fake.sent.map((value) => JSON.parse(value).payload)
      .filter((request) => request.method === "thread/list").at(-1);
    fake.serverSend({
      type: "rpc",
      payload: { id: newerLive.id, result: { data: [{ id: "new-task", name: "New task" }] } },
    });
    await waitFor(() => expect(fake.sent.map((value) => JSON.parse(value).payload)
      .filter((request) => request.method === "desktopState/listThreads")).toHaveLength(2));
    const newerDesktop = fake.sent.map((value) => JSON.parse(value).payload)
      .filter((request) => request.method === "desktopState/listThreads").at(-1);
    fake.serverSend({
      type: "rpc",
      payload: { id: newerDesktop.id, result: { data: [{ id: "new-task", title: "New task" }] } },
    });
    await act(() => newerRefresh);

    fake.serverSend({ type: "rpc", payload: { id: olderDesktop.id, result: { data: [] } } });
    await act(() => olderRefresh);

    expect(result.current.state.threadOrder).toEqual(["new-task"]);
    expect(result.current.threadsLoading).toBe(false);
    expect(result.current.threadsError).toBeUndefined();
  });

  it("falls back to the Desktop task list when the live list times out", async () => {
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    const { result } = renderHook(() => useCodex(socket));
    await act(() => result.current.connect("secret", "ws://local/rpc"));
    act(() => fake.serverSend({ type: "session", state: "reconnecting" }));
    vi.useFakeTimers();
    try {
      let refresh: Promise<void>;
      act(() => { refresh = result.current.refreshThreads(); });
      await act(async () => undefined);
      const requests = fake.sent.map((value) => JSON.parse(value).payload);
      expect(requests.map((request) => request.method)).toEqual([
        "thread/list",
        "desktopState/listThreads",
      ]);
      const desktopList = requests.find((request) => request.method === "desktopState/listThreads");
      fake.serverSend({
        type: "rpc",
        payload: { id: desktopList.id, result: { data: [{ id: "desktop-task", title: "Desktop task" }] } },
      });

      await act(() => vi.advanceTimersByTimeAsync(10_000));
      await act(() => refresh);
      expect(result.current.state.threadOrder).toEqual(["desktop-task"]);
      expect(result.current.threadsLoading).toBe(false);
      expect(result.current.threadsError).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("reports bounded initial list failure and ignores both late timed-out results", async () => {
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    const { result } = renderHook(() => useCodex(socket));
    await act(() => result.current.connect("secret", "ws://local/rpc"));
    act(() => fake.serverSend({ type: "session", state: "reconnecting" }));
    vi.useFakeTimers();
    try {
      let timedOutRefresh!: Promise<void>;
      act(() => { timedOutRefresh = result.current.refreshThreads(); });
      await act(async () => undefined);
      const timedOutRequests = fake.sent.map((value) => JSON.parse(value).payload);
      expect(timedOutRequests).toHaveLength(2);
      let failure: unknown;
      const observedFailure = timedOutRefresh.catch((cause) => { failure = cause; });
      await act(() => vi.advanceTimersByTimeAsync(10_000));
      await act(() => observedFailure);
      expect(failure).toEqual(new Error("读取对话列表失败"));
      expect(result.current.threadsLoading).toBe(false);
      expect(result.current.threadsError).toBe("读取对话列表失败");

      let retry: Promise<void>;
      act(() => { retry = result.current.refreshThreads(); });
      await act(async () => undefined);
      const retryRequests = fake.sent.map((value) => JSON.parse(value).payload).slice(2);
      const liveRetry = retryRequests.find((request) => request.method === "thread/list");
      const desktopRetry = retryRequests.find((request) => request.method === "desktopState/listThreads");
      fake.serverSend({
        type: "rpc",
        payload: { id: liveRetry.id, result: { data: [{ id: "recovered", name: "Recovered" }] } },
      });
      fake.serverSend({
        type: "rpc",
        payload: { id: desktopRetry.id, result: { data: [{ id: "recovered", title: "Recovered" }] } },
      });
      await act(() => retry);
      expect(vi.getTimerCount()).toBe(0);

      for (const request of timedOutRequests) {
        act(() => fake.serverSend({ type: "rpc", payload: { id: request.id, result: { data: [] } } }));
      }
      await act(async () => undefined);
      expect(result.current.state.threadOrder).toEqual(["recovered"]);
      expect(result.current.threadsError).toBeUndefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it("settles the initial failure while a newer task-list refresh remains pending", async () => {
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    const { result } = renderHook(() => useCodex(socket));
    await act(() => result.current.connect("secret", "ws://local/rpc"));

    let olderRefresh!: Promise<void>;
    act(() => { olderRefresh = result.current.refreshThreads(); });
    await act(async () => undefined);
    const olderRequests = fake.sent.map((value) => JSON.parse(value).payload);
    let newerRefresh!: Promise<void>;
    act(() => { newerRefresh = result.current.refreshThreads(); });
    await act(async () => undefined);
    const newerRequests = fake.sent.map((value) => JSON.parse(value).payload).slice(2);

    for (const request of olderRequests) {
      fake.serverSend({ type: "rpc", payload: { id: request.id, error: { code: -1, message: "offline" } } });
    }
    let failure: unknown;
    await act(async () => {
      try {
        await olderRefresh;
      } catch (cause) {
        failure = cause;
      }
    });
    expect(failure).toEqual(new Error("读取对话列表失败"));
    expect(result.current.threadsLoading).toBe(false);
    expect(result.current.threadsError).toBe("读取对话列表失败");

    for (const request of newerRequests) {
      fake.serverSend({ type: "rpc", payload: { id: request.id, error: { code: -1, message: "offline" } } });
    }
    await act(async () => { await newerRefresh.catch(() => undefined); });
  });

  it("does not let an older success clear a newer task-list failure", async () => {
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    const { result } = renderHook(() => useCodex(socket));
    await act(() => result.current.connect("secret", "ws://local/rpc"));

    let olderRefresh!: Promise<void>;
    act(() => { olderRefresh = result.current.refreshThreads(); });
    const olderRequests = taskListRequests(fake);
    let newerRefresh!: Promise<void>;
    act(() => { newerRefresh = result.current.refreshThreads(); });
    const newerRequests = taskListRequests(fake, 2);

    fake.serverSend({ type: "rpc", payload: { id: newerRequests.live.id, error: { code: -1, message: "offline" } } });
    fake.serverSend({ type: "rpc", payload: { id: newerRequests.desktop.id, error: { code: -1, message: "offline" } } });
    await act(async () => { await newerRefresh.catch(() => undefined); });

    fake.serverSend({
      type: "rpc",
      payload: { id: olderRequests.live.id, result: { data: [{ id: "old-task", name: "Old task" }] } },
    });
    fake.serverSend({
      type: "rpc",
      payload: { id: olderRequests.desktop.id, result: { data: [{ id: "old-task", title: "Old task" }] } },
    });
    await act(() => olderRefresh);

    expect(result.current.state.threadOrder).toEqual([]);
    expect(result.current.threadsError).toBe("读取对话列表失败");
  });

  it("settles a failed initial task-list request as an explicit error", async () => {
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    const { result } = renderHook(() => useCodex(socket));
    await act(() => result.current.connect("secret", "ws://local/rpc"));

    let refresh: Promise<void>;
    act(() => { refresh = result.current.refreshThreads(); });
    const requests = fake.sent.map((value) => JSON.parse(value).payload);
    const liveList = requests.find((request) => request.method === "thread/list");
    const desktopList = requests.find((request) => request.method === "desktopState/listThreads");
    fake.serverSend({ type: "rpc", payload: { id: liveList.id, error: { code: -1, message: "offline" } } });
    fake.serverSend({ type: "rpc", payload: { id: desktopList.id, error: { code: -1, message: "offline" } } });
    let failure: unknown;
    await act(async () => {
      try {
        await refresh;
      } catch (cause) {
        failure = cause;
      }
    });

    expect(failure).toEqual(new Error("读取对话列表失败"));
    expect(result.current.threadsLoading).toBe(false);
    expect(result.current.threadsError).toBe("读取对话列表失败");
  });

  it("loads and normalizes the task list", async () => {
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    const { result } = renderHook(() => useCodex(socket));
    await act(() => result.current.connect("secret", "ws://local/rpc"));

    let refresh: Promise<void>;
    act(() => {
      refresh = result.current.refreshThreads();
    });
    const { live: request, desktop: metadataRequest } = taskListRequests(fake);
    fake.serverSend({
      type: "rpc",
      payload: {
        id: request.id,
        result: {
          data: [
            { id: "t1", name: "Fix login race", cwd: "/code/app", updatedAt: 42 },
          ],
        },
      },
    });
    fake.serverSend({
      type: "rpc",
      payload: {
        id: metadataRequest.id,
        result: {
          data: [{
            id: "t1",
            title: "Desktop title",
            cwd: "/code/app",
            isPinned: true,
            model: "gpt-desktop",
            reasoningEffort: "high",
            permission: ":workspace",
            updatedAt: 43,
          }],
        },
      },
    });
    await act(() => refresh);

    expect(result.current.state.threadOrder).toEqual(["t1"]);
    expect(result.current.state.threads.t1).toMatchObject({
      title: "Desktop title",
      sectionName: "Pinned",
      model: "gpt-desktop",
      reasoningEffort: "high",
      permission: ":workspace",
    });
  });

  it.each([
    ["active", "unknown", "running"],
    ["active", "idle", "running"],
    ["idle", "active", "idle"],
    ["systemError", "idle", "error"],
    ["notLoaded", "active", "running"],
    [undefined, "active", "running"],
  ])("uses live list status %s with history fallback %s", async (liveStatus, historyStatus, expected) => {
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    const { result } = renderHook(() => useCodex(socket));
    await act(() => result.current.connect("secret", "ws://local/rpc"));
    let refresh: Promise<void>;
    act(() => { refresh = result.current.refreshThreads(); });
    const { live, desktop } = taskListRequests(fake);
    fake.serverSend({ type: "rpc", payload: { id: live.id, result: {
      data: [{ id: "t1", name: "Live title", status: { type: liveStatus } }],
    } } });
    fake.serverSend({ type: "rpc", payload: { id: desktop.id, result: {
      data: [{ id: "t1", title: "Desktop title", isPinned: true, status: { type: historyStatus } }],
    } } });
    await act(() => refresh);
    expect(result.current.state.threads.t1).toMatchObject({
      status: expected, title: "Desktop title", sectionName: "Pinned",
    });
  });

  it("recovers a new Desktop turn from the list after missing its start event", async () => {
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    const { result } = renderHook(() => useCodex(socket));
    await act(() => result.current.connect("secret", "ws://local/rpc"));
    act(() => {
      fake.serverSend({ type: "rpc", payload: { method: "turn/started", params: { threadId: "t1", turn: { id: "old" } } } });
      fake.serverSend({ type: "rpc", payload: { method: "turn/completed", params: { threadId: "t1", turn: { id: "old", status: "completed" } } } });
    });
    // Only the transport is doubled: the hook, event reducer and list merge are real.
    const request = socket.request.bind(socket);
    vi.spyOn(socket, "request").mockImplementation((method, params, options) => {
      if (method === "thread/turns/list") {
        expect(params).toEqual({ threadId: "t1", limit: 1, sortDirection: "desc", itemsView: "notLoaded" });
        return Promise.resolve({ data: [{ id: "new", status: "inProgress", items: [], itemsView: "notLoaded" }], nextCursor: "older" }) as ReturnType<typeof request>;
      }
      return request(method, params, options);
    });
    let refresh: Promise<void>;
    act(() => { refresh = result.current.refreshThreads(); });
    const { live, desktop } = taskListRequests(fake);
    fake.serverSend({ type: "rpc", payload: { id: live.id, result: { data: [{ id: "t1", status: { type: "active" } }] } } });
    fake.serverSend({ type: "rpc", payload: { id: desktop.id, result: { data: [{ id: "t1", status: { type: "active" } }] } } });
    await act(() => refresh);
    expect(result.current.state.threads.t1).toMatchObject({ status: "running", activeTurnId: "new" });
    expect(result.current.state.threads.t1.turns.old.status).toBe("completed");
  });

  it("does not let a stale idle list snapshot overwrite an active turn", async () => {
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    latestTurnResponse(socket, { id: "live-turn", status: "inProgress" });
    const { result } = renderHook(() => useCodex(socket));
    await act(() => result.current.connect("secret", "ws://local/rpc"));

    async function refreshWithIdleSnapshot() {
      let refresh: Promise<void>;
      const start = fake.sent.length;
      act(() => { refresh = result.current.refreshThreads(); });
      const { live: listRequest, desktop: metadataRequest } = taskListRequests(fake, start);
      fake.serverSend({
        type: "rpc",
        payload: { id: listRequest.id, result: { data: [{ id: "t1", name: "Task", status: { type: "idle" } }] } },
      });
      fake.serverSend({
        type: "rpc",
        payload: { id: metadataRequest.id, result: { data: [{ id: "t1", title: "Task" }] } },
      });
      await act(() => refresh);
    }

    await refreshWithIdleSnapshot();
    act(() => {
      fake.serverSend({
        type: "rpc",
        payload: { method: "turn/started", params: { threadId: "t1", turn: { id: "live-turn" } } },
      });
    });
    expect(result.current.state.threads.t1).toMatchObject({ status: "running", activeTurnId: "live-turn" });

    await refreshWithIdleSnapshot();
    expect(result.current.state.threads.t1).toMatchObject({ status: "running", activeTurnId: "live-turn" });

    act(() => {
      fake.serverSend({
        type: "rpc",
        payload: { method: "turn/completed", params: { threadId: "t1", turn: { id: "live-turn", status: "completed" } } },
      });
    });
    await refreshWithIdleSnapshot();
    expect(result.current.state.threads.t1).toMatchObject({ status: "idle", activeTurnId: undefined });
  });

  it.each([
    { name: "missed completion", known: "inProgress", listed: "idle", turnId: "old", turnStatus: "completed", expected: "idle", active: undefined },
    { name: "missed failure", known: "inProgress", listed: "systemError", turnId: "old", turnStatus: "failed", expected: "error", active: undefined },
    { name: "missed whole later turn", known: "inProgress", listed: "idle", turnId: "new", turnStatus: "completed", expected: "idle", active: undefined },
    { name: "missed whole later failed turn", known: "inProgress", listed: "systemError", turnId: "new", turnStatus: "failed", expected: "error", active: undefined },
    { name: "stale same-turn activity", known: "completed", listed: "active", turnId: "old", turnStatus: "inProgress", expected: "idle", active: undefined },
    { name: "completion during read", known: "completed", listed: "active", turnId: "new", turnStatus: "inProgress", event: "complete", expected: "idle", active: undefined },
    { name: "failure during read", known: "completed", listed: "active", turnId: "new", turnStatus: "inProgress", event: "fail", expected: "error", active: undefined },
    { name: "failed terminal with unavailable metadata", known: "failed", listed: "active", turnId: "new", turnStatus: "inProgress", event: "reject", expected: "error", active: undefined },
    { name: "failed terminal with unverified idle", known: "failed", listed: "idle", turnId: "new", turnStatus: "completed", event: "reject", expected: "error", active: undefined },
    { name: "newer start during read", known: "completed", listed: "active", turnId: "new", turnStatus: "inProgress", event: "start", expected: "running", active: "newer" },
    { name: "unavailable metadata", known: "completed", listed: "active", turnId: "new", turnStatus: "inProgress", event: "reject", expected: "idle", active: undefined },
  ])("reconciles list conflicts without losing messages: $name", async (scenario) => {
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    const { result } = renderHook(() => useCodex(socket));
    await act(() => result.current.connect("secret", "ws://local/rpc"));
    const event = (method: string, params: unknown) => fake.serverSend({ type: "rpc", payload: { method, params } });
    act(() => {
      event("turn/started", { threadId: "t1", turn: { id: "old" } });
      event("item/completed", { threadId: "t1", turnId: "old", item: { id: "answer", type: "agentMessage", text: "Keep this answer", phase: "final_answer" } });
      if (scenario.known !== "inProgress") event("turn/completed", { threadId: "t1", turn: { id: "old", status: scenario.known } });
    });
    const request = socket.request.bind(socket);
    vi.spyOn(socket, "request").mockImplementation((method, params, options) => {
      if (method !== "thread/turns/list") return request(method, params, options);
      expect(params).toEqual({ threadId: "t1", limit: 1, sortDirection: "desc", itemsView: "notLoaded" });
      if (scenario.event === "reject") return Promise.reject(new Error("bridge unavailable"));
      if (scenario.event === "start") event("turn/started", { threadId: "t1", turn: { id: "newer" } });
      if (scenario.event === "complete" || scenario.event === "fail") {
        event("turn/started", { threadId: "t1", turn: { id: "new" } });
        event("turn/completed", { threadId: "t1", turn: { id: "new", status: scenario.event === "fail" ? "failed" : "completed" } });
      }
      return Promise.resolve({ data: [{ id: scenario.turnId, status: scenario.turnStatus, items: [], itemsView: "notLoaded" }] });
    });
    let refresh: Promise<void>;
    act(() => { refresh = result.current.refreshThreads(); });
    const { live, desktop } = taskListRequests(fake);
    fake.serverSend({ type: "rpc", payload: { id: live.id, result: { data: [{ id: "t1", status: { type: scenario.listed } }] } } });
    fake.serverSend({ type: "rpc", payload: { id: desktop.id, result: { data: [{ id: "t1", status: { type: "unknown" } }] } } });
    await act(() => refresh);
    expect(result.current.state.threads.t1).toMatchObject({ status: scenario.expected, activeTurnId: scenario.active });
    expect(result.current.state.threads.t1.turns.old.items.answer).toMatchObject({ text: "Keep this answer", phase: "final_answer" });
  });

  it("does not let a stale active list restart a completed turn", async () => {
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    latestTurnResponse(socket, { id: "turn-1", status: "completed" });
    const { result } = renderHook(() => useCodex(socket));
    await act(() => result.current.connect("secret", "ws://local/rpc"));

    act(() => {
      fake.serverSend({
        type: "rpc",
        payload: { method: "turn/started", params: { threadId: "t1", turn: { id: "turn-1" } } },
      });
      fake.serverSend({
        type: "rpc",
        payload: {
          method: "turn/completed",
          params: { threadId: "t1", turn: { id: "turn-1", status: "completed" } },
        },
      });
    });
    expect(result.current.state.threads.t1).toMatchObject({ status: "idle", activeTurnId: undefined });

    let refresh: Promise<void>;
    act(() => { refresh = result.current.refreshThreads(); });
    const { live: liveList, desktop: desktopList } = taskListRequests(fake);
    fake.serverSend({
      type: "rpc",
      payload: {
        id: liveList.id,
        result: { data: [{ id: "t1", name: "Task", status: { type: "active" } }] },
      },
    });
    fake.serverSend({
      type: "rpc",
      payload: { id: desktopList.id, result: { data: [{ id: "t1", title: "Task" }] } },
    });
    await act(() => refresh);

    expect(result.current.state.threads.t1).toMatchObject({ status: "idle", activeTurnId: undefined });
  });

  it.each(["inProgress", "completed"])("keeps a newer history snapshot when older %s status metadata arrives late", async (status) => {
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    const { result } = renderHook(() => useCodex(socket));
    await act(() => result.current.connect("secret", "ws://local/rpc"));
    act(() => {
      fake.serverSend({ type: "rpc", payload: { method: "turn/started", params: { threadId: "t1", turn: { id: "old" } } } });
      fake.serverSend({ type: "rpc", payload: { method: "turn/completed", params: { threadId: "t1", turn: { id: "old", status: "completed" } } } });
    });
    let refresh: Promise<void>;
    act(() => { refresh = result.current.refreshThreads(); });
    const { live, desktop } = taskListRequests(fake);
    fake.serverSend({ type: "rpc", payload: { id: live.id, result: { data: [{ id: "t1", status: "active" }] } } });
    fake.serverSend({ type: "rpc", payload: { id: desktop.id, result: { data: [{ id: "t1", status: "unknown" }] } } });
    await waitFor(() => expect(fake.sent.map(raw => JSON.parse(raw).payload.method)).toContain("thread/turns/list"));
    const metadata = fake.sent.map(raw => JSON.parse(raw).payload).find(r => r.method === "thread/turns/list");
    let selection: Promise<void>;
    act(() => { selection = result.current.selectThread("t1"); });
    const resume = fake.sent.map(raw => JSON.parse(raw).payload).find(r => r.method === "desktopState/readThread");
    fake.serverSend({ type: "rpc", payload: { id: resume.id, result: { thread: {
      id: "t1", status: "active", turns: [{ id: "old", status: "completed", items: [] }, { id: "newest", status: "inProgress", items: [
        { id: "progress", type: "agentMessage", text: "Newest progress", phase: "commentary" },
      ] }],
    } } } });
    await act(() => selection);
    expect(result.current.state.threads.t1).toMatchObject({ status: "running", activeTurnId: "newest", turnOrder: ["old", "newest"] });
    fake.serverSend({ type: "rpc", payload: { id: metadata.id, result: { data: [{ id: "middle", status, items: [] }] } } });
    await act(() => refresh);
    expect(result.current.state.threads.t1).toMatchObject({ status: "running", activeTurnId: "newest", turnOrder: ["old", "newest"] });
    expect(result.current.state.threads.t1.turns.newest.items.progress.text).toBe("Newest progress");
  });

  it("recovers the active turn identity before stopping a running task", async () => {
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    const { result } = renderHook(() => useCodex(socket));
    await act(() => result.current.connect("secret", "ws://local/rpc"));

    let selection: Promise<void>;
    act(() => { selection = result.current.selectThread("t1"); });
    const resume = JSON.parse(fake.sent.at(-1) as string).payload;
    expect(resume.method).toBe("thread/resume");
    fake.serverSend({
      type: "rpc",
      payload: {
        id: resume.id,
        result: {
          thread: {
            id: "t1",
            status: { type: "active" },
            turns: [{ id: "old-turn", status: "completed", items: [] }],
          },
        },
      },
    });
    await act(() => selection);
    expect(result.current.selectedThread).toMatchObject({ status: "running", activeTurnId: undefined });

    let stopping: Promise<void>;
    act(() => { stopping = result.current.interrupt(); });
    const activity = JSON.parse(fake.sent.at(-1) as string).payload;
    expect(activity).toMatchObject({
      method: "gateway/threadActivity/read",
      params: { threadId: "t1" },
    });
    fake.serverSend({
      type: "rpc",
      payload: { id: activity.id, result: { status: "running", turnId: "live-turn" } },
    });
    await waitFor(() => expect(JSON.parse(fake.sent.at(-1) as string).payload.method).toBe("turn/interrupt"));
    const interrupt = JSON.parse(fake.sent.at(-1) as string).payload;
    expect(interrupt.params).toEqual({ threadId: "t1", turnId: "live-turn" });
    fake.serverSend({ type: "rpc", payload: { id: interrupt.id, result: {} } });
    await act(() => stopping);

    expect(result.current.selectedThread).toMatchObject({ status: "running", activeTurnId: "live-turn" });
  });

  it("times out a conflicting metadata read without accepting its late response", async () => {
    vi.useFakeTimers();
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    const { result, unmount } = renderHook(() => useCodex(socket));
    try {
      await act(() => result.current.connect("secret", "ws://local/rpc"));
      act(() => {
        fake.serverSend({ type: "rpc", payload: { method: "turn/started", params: { threadId: "t1", turn: { id: "old" } } } });
        fake.serverSend({ type: "rpc", payload: { method: "turn/completed", params: { threadId: "t1", turn: { id: "old", status: "completed" } } } });
      });
      let refresh: Promise<void>;
      act(() => { refresh = result.current.refreshThreads(); });
      const { live, desktop } = taskListRequests(fake);
      fake.serverSend({ type: "rpc", payload: { id: live.id, result: { data: [{ id: "t1", status: "active" }] } } });
      fake.serverSend({ type: "rpc", payload: { id: desktop.id, result: { data: [{ id: "t1", status: "unknown" }] } } });
      await act(async () => {});
      const metadata = fake.sent.map(raw => JSON.parse(raw).payload).find(r => r.method === "thread/turns/list");
      expect(metadata.params).toMatchObject({ limit: 1, itemsView: "notLoaded" });
      await act(() => vi.advanceTimersByTimeAsync(5_001));
      await act(() => refresh);
      act(() => fake.serverSend({ type: "rpc", payload: { id: metadata.id, result: { data: [{ id: "late", status: "inProgress" }] } } }));
      expect(result.current.threadsLoading).toBe(false);
      expect(result.current.state.threads.t1).toMatchObject({ status: "idle", activeTurnId: undefined, turnOrder: ["old"] });
    } finally {
      unmount();
      socket.disconnect();
      vi.useRealTimers();
    }
  });

  it("ignores old status metadata after a newer list refresh has settled", async () => {
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    const { result } = renderHook(() => useCodex(socket));
    await act(() => result.current.connect("secret", "ws://local/rpc"));
    act(() => {
      fake.serverSend({ type: "rpc", payload: { method: "turn/started", params: { threadId: "t1", turn: { id: "old" } } } });
      fake.serverSend({ type: "rpc", payload: { method: "turn/completed", params: { threadId: "t1", turn: { id: "old", status: "completed" } } } });
    });
    let older: Promise<void>;
    act(() => { older = result.current.refreshThreads(); });
    const first = taskListRequests(fake);
    fake.serverSend({ type: "rpc", payload: { id: first.live.id, result: { data: [{ id: "t1", status: "active" }] } } });
    fake.serverSend({ type: "rpc", payload: { id: first.desktop.id, result: { data: [{ id: "t1", status: "unknown" }] } } });
    await waitFor(() => expect(fake.sent.map(raw => JSON.parse(raw).payload.method)).toContain("thread/turns/list"));
    const metadata = fake.sent.map(raw => JSON.parse(raw).payload).find(r => r.method === "thread/turns/list");
    let newer: Promise<void>;
    const start = fake.sent.length;
    act(() => { newer = result.current.refreshThreads(); });
    const second = taskListRequests(fake, start);
    fake.serverSend({ type: "rpc", payload: { id: second.live.id, result: { data: [{ id: "t1", status: "idle" }] } } });
    fake.serverSend({ type: "rpc", payload: { id: second.desktop.id, result: { data: [{ id: "t1", title: "Newest title" }] } } });
    await act(() => newer);
    fake.serverSend({ type: "rpc", payload: { id: metadata.id, result: { data: [{ id: "late", status: "inProgress" }] } } });
    await act(() => older);
    expect(result.current.state.threads.t1).toMatchObject({ status: "idle", title: "Newest title", activeTurnId: undefined, turnOrder: ["old"] });
  });

  it("treats a stop request that raced with turn completion as already stopped", async () => {
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    const { result } = renderHook(() => useCodex(socket));
    await act(() => result.current.connect("secret", "ws://local/rpc"));

    act(() => {
      fake.serverSend({
        type: "rpc",
        payload: { method: "turn/started", params: { threadId: "t1", turn: { id: "turn-1" } } },
      });
    });
    let selection: Promise<void>;
    act(() => { selection = result.current.selectThread("t1"); });
    const resume = JSON.parse(fake.sent.at(-1) as string).payload;
    fake.serverSend({
      type: "rpc",
      payload: {
        id: resume.id,
        result: {
          thread: { id: "t1", status: { type: "active" }, turns: [{ id: "turn-1", status: "inProgress", items: [] }] },
        },
      },
    });
    await act(() => selection);

    let stopping: Promise<void>;
    act(() => { stopping = result.current.interrupt(); });
    const interrupt = JSON.parse(fake.sent.at(-1) as string).payload;
    expect(interrupt).toMatchObject({
      method: "turn/interrupt",
      params: { threadId: "t1", turnId: "turn-1" },
    });
    fake.serverSend({
      type: "rpc",
      payload: { id: interrupt.id, error: { code: -32000, message: "no active turn to stop" } },
    });
    await act(() => stopping);

    expect(result.current.selectedThread).toMatchObject({ status: "idle", activeTurnId: undefined });
    expect(result.current.selectedThread?.turns["turn-1"].status).toBe("interrupted");
  });

  it("keeps a newer turn running when an older stop request reports no active turn", async () => {
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    const { result } = renderHook(() => useCodex(socket));
    await act(() => result.current.connect("secret", "ws://local/rpc"));

    act(() => {
      fake.serverSend({
        type: "rpc",
        payload: { method: "turn/started", params: { threadId: "t1", turn: { id: "turn-1" } } },
      });
    });
    let selection: Promise<void>;
    act(() => { selection = result.current.selectThread("t1"); });
    const resume = JSON.parse(fake.sent.at(-1) as string).payload;
    fake.serverSend({
      type: "rpc",
      payload: {
        id: resume.id,
        result: {
          thread: { id: "t1", status: { type: "active" }, turns: [{ id: "turn-1", status: "inProgress", items: [] }] },
        },
      },
    });
    await act(() => selection);

    let stopping: Promise<void>;
    act(() => { stopping = result.current.interrupt(); });
    const interrupt = JSON.parse(fake.sent.at(-1) as string).payload;
    act(() => {
      fake.serverSend({
        type: "rpc",
        payload: { method: "turn/started", params: { threadId: "t1", turn: { id: "turn-2" } } },
      });
    });
    fake.serverSend({
      type: "rpc",
      payload: { id: interrupt.id, error: { code: -32000, message: "no active turn to stop" } },
    });
    await act(() => stopping);

    expect(result.current.selectedThread).toMatchObject({ status: "running", activeTurnId: "turn-2" });
    expect(result.current.selectedThread?.turns["turn-2"].status).toBe("inProgress");
  });

  it("keeps the Desktop snapshot visible while the live bridge is read-only", async () => {
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    const { result } = renderHook(() => useCodex(socket));
    await act(() => result.current.connect("secret", "ws://local/rpc"));

    let refresh: Promise<void>;
    act(() => { refresh = result.current.refreshThreads(); });
    const { live: liveRequest, desktop: snapshotRequest } = taskListRequests(fake);
    fake.serverSend({
      type: "rpc",
      payload: {
        id: liveRequest.id,
        error: { code: -32001, message: "Desktop bridge is read-only" },
      },
    });
    fake.serverSend({
      type: "rpc",
      payload: {
        id: snapshotRequest.id,
        result: {
          data: [{ id: "snapshot-1", title: "Still available", cwd: "/code/app" }],
        },
      },
    });
    await act(() => refresh);

    expect(result.current.connection).toBe("ready");
    expect(result.current.desktopStateAvailable).toBe(true);
    expect(result.current.state.threads["snapshot-1"]?.title).toBe("Still available");
  });

  it("keeps using Desktop history after a transient metadata refresh failure", async () => {
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    const { result } = renderHook(() => useCodex(socket));
    await act(() => result.current.connect("secret", "ws://local/rpc"));

    let firstRefresh: Promise<void>;
    act(() => { firstRefresh = result.current.refreshThreads(); });
    const { live: firstList, desktop: firstDesktopList } = taskListRequests(fake);
    fake.serverSend({ type: "rpc", payload: { id: firstList.id, result: { data: [{ id: "t1" }] } } });
    fake.serverSend({
      type: "rpc",
      payload: { id: firstDesktopList.id, result: { data: [{ id: "t1", title: "Desktop task" }] } },
    });
    await act(() => firstRefresh);
    expect(result.current.desktopStateAvailable).toBe(true);

    let secondRefresh: Promise<void>;
    act(() => { secondRefresh = result.current.refreshThreads(); });
    const { live: secondList, desktop: secondDesktopList } = taskListRequests(fake, 2);
    fake.serverSend({ type: "rpc", payload: { id: secondList.id, result: { data: [{ id: "t1" }] } } });
    fake.serverSend({
      type: "rpc",
      payload: { id: secondDesktopList.id, error: { code: -32001, message: "bridge temporarily unavailable" } },
    });
    await act(() => secondRefresh);

    let selection: Promise<void>;
    act(() => { selection = result.current.selectThread("t1"); });
    const historyRequest = JSON.parse(fake.sent.at(-1) as string).payload;
    expect(historyRequest).toMatchObject({
      method: "desktopState/readThread",
      params: { threadId: "t1", history: { limitTurns: 8, maxBytes: 2 * 1024 * 1024 } },
    });
    fake.serverSend({
      type: "rpc",
      payload: {
        id: historyRequest.id,
        result: {
          desktopMirror: true,
          thread: {
            id: "t1",
            turns: [{
              id: "turn-1",
              status: "completed",
              items: [{ id: "user-1", type: "userMessage", text: "", imageIds: ["image-1"] }],
            }],
          },
        },
      },
    });
    await act(() => selection);

    expect(result.current.selectedThread?.turns["turn-1"].items["user-1"].imageIds)
      .toEqual(["image-1"]);
  });

  it("opens a Desktop thread from its latest page and prepends older history on demand", async () => {
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    const { result } = renderHook(() => useCodex(socket));
    await act(() => result.current.connect("secret", "ws://local/rpc"));

    let refresh: Promise<void>;
    act(() => { refresh = result.current.refreshThreads(); });
    const { live: listRequest, desktop: desktopListRequest } = taskListRequests(fake);
    fake.serverSend({ type: "rpc", payload: { id: listRequest.id, result: { data: [] } } });
    fake.serverSend({
      type: "rpc",
      payload: { id: desktopListRequest.id, result: { data: [{ id: "t1", title: "Large task" }] } },
    });
    await act(() => refresh);

    let selection: Promise<void>;
    act(() => { selection = result.current.selectThread("t1"); });
    const latestRequest = JSON.parse(fake.sent.at(-1) as string).payload;
    expect(latestRequest).toMatchObject({
      method: "desktopState/readThread",
      params: { threadId: "t1", history: { limitTurns: 8, maxBytes: 2 * 1024 * 1024 } },
    });
    fake.serverSend({
      type: "rpc",
      payload: {
        id: latestRequest.id,
        result: {
          desktopMirror: true,
          history: { hasMoreBefore: true, beforeCursor: "500" },
          thread: {
            id: "t1",
            turns: [{
              id: "turn-new",
              status: "completed",
              items: [{ id: "new", type: "agentMessage", text: "Newest" }],
            }],
          },
        },
      },
    });
    await act(() => selection);

    expect(result.current.selectedThread?.turnOrder).toEqual(["turn-new"]);
    expect(result.current.selectedThreadHistory).toMatchObject({ hasMoreBefore: true, loading: false });

    let older: Promise<void>;
    act(() => { older = result.current.loadEarlierThreadHistory(); });
    const olderRequest = JSON.parse(fake.sent.at(-1) as string).payload;
    expect(olderRequest).toMatchObject({
      method: "desktopState/readThread",
      params: {
        threadId: "t1",
        history: { beforeCursor: "500", limitTurns: 8, maxBytes: 2 * 1024 * 1024 },
      },
    });
    fake.serverSend({
      type: "rpc",
      payload: {
        id: olderRequest.id,
        result: {
          desktopMirror: true,
          history: { hasMoreBefore: true, beforeCursor: "200" },
          thread: {
            id: "t1",
            turns: [
              {
                id: "turn-old",
                status: "completed",
                items: [{ id: "old", type: "userMessage", text: "Older" }],
              },
              {
                id: "turn-new",
                status: "inProgress",
                items: [{ id: "early-new", type: "userMessage", text: "Earlier part" }],
              },
            ],
          },
        },
      },
    });
    await act(() => older);

    expect(result.current.selectedThread?.turnOrder).toEqual(["turn-old", "turn-new"]);
    expect(result.current.selectedThread?.turns["turn-new"].status).toBe("completed");
    expect(result.current.selectedThread?.activeTurnId).toBeUndefined();
    expect(result.current.selectedThreadHistory).toMatchObject({
      beforeCursor: "200",
      hasMoreBefore: true,
      loading: false,
    });

    let reopened: Promise<void>;
    act(() => { reopened = result.current.selectThread("t1"); });
    const reopenedRequest = JSON.parse(fake.sent.at(-1) as string).payload;
    fake.serverSend({
      type: "rpc",
      payload: {
        id: reopenedRequest.id,
        result: {
          desktopMirror: true,
          history: { hasMoreBefore: true, beforeCursor: "500" },
          thread: {
            id: "t1",
            turns: [{
              id: "turn-new",
              status: "completed",
              items: [{ id: "new", type: "agentMessage", text: "Newest" }],
            }],
          },
        },
      },
    });
    await act(() => reopened);

    expect(result.current.selectedThread?.turnOrder).toEqual(["turn-old", "turn-new"]);
    expect(result.current.selectedThreadHistory.beforeCursor).toBe("200");

    let oldest: Promise<void>;
    act(() => { oldest = result.current.loadEarlierThreadHistory(); });
    const oldestRequest = JSON.parse(fake.sent.at(-1) as string).payload;
    expect(oldestRequest.params.history.beforeCursor).toBe("200");
    fake.serverSend({
      type: "rpc",
      payload: {
        id: oldestRequest.id,
        result: {
          desktopMirror: true,
          history: { hasMoreBefore: false },
          thread: { id: "t1", turns: [] },
        },
      },
    });
    await act(() => oldest);
  });

  it("resumes a Desktop-backed thread without reloading its full history before sending", async () => {
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    const { result } = renderHook(() => useCodex(socket));
    await act(() => result.current.connect("secret", "ws://local/rpc"));
    act(() => {
      fake.serverSend({ type: "session", state: "ready", transport: "desktop-live", readOnly: false });
    });

    let refresh: Promise<void>;
    act(() => { refresh = result.current.refreshThreads(); });
    const { live: listRequest, desktop: desktopListRequest } = taskListRequests(fake);
    fake.serverSend({ type: "rpc", payload: { id: listRequest.id, result: { data: [] } } });
    fake.serverSend({
      type: "rpc",
      payload: { id: desktopListRequest.id, result: { data: [{ id: "t1", title: "Desktop task" }] } },
    });
    await act(() => refresh);

    let selection: Promise<void>;
    act(() => { selection = result.current.selectThread("t1"); });
    const mirrorRequest = JSON.parse(fake.sent.at(-1) as string).payload;
    fake.serverSend({
      type: "rpc",
      payload: {
        id: mirrorRequest.id,
        result: {
          desktopMirror: true,
          history: { hasMoreBefore: false },
          thread: {
            id: "t1",
            name: "Desktop task",
            status: { type: "idle" },
            turns: [{
              id: "stored-turn",
              status: "completed",
              items: [{ id: "stored-agent", type: "agentMessage", text: "Stored" }],
            }],
          },
        },
      },
    });
    await waitFor(() => expect(fake.sent).toHaveLength(4));
    const resumeRequest = JSON.parse(fake.sent.at(-1) as string).payload;
    expect(resumeRequest).toMatchObject({
      method: "thread/resume",
      params: { threadId: "t1", excludeTurns: true },
    });
    fake.serverSend({
      type: "rpc",
      payload: { id: resumeRequest.id, result: { thread: { id: "t1", turns: [] } } },
    });
    await act(() => selection);

    expect(result.current.selectedThread?.turnOrder).toEqual(["stored-turn"]);
    let sending: Promise<void>;
    act(() => { sending = result.current.sendInstruction("Continue"); });
    expect(result.current.selectedThread?.status).toBe("running");
    const optimisticTurnId = result.current.selectedThread?.turnOrder.at(-1) as string;
    expect(optimisticTurnId).toMatch(/^web-start-turn-/);
    expect(Object.values(result.current.selectedThread?.turns[optimisticTurnId].items ?? {}))
      .toEqual([
        expect.objectContaining({ type: "userMessage", text: "Continue", lifecycle: "pending" }),
      ]);
    const turnRequest = JSON.parse(fake.sent.at(-1) as string).payload;
    expect(turnRequest).toMatchObject({
      method: "turn/start",
      params: { threadId: "t1", input: [{ type: "text", text: "Continue" }] },
    });
    fake.serverSend({
      type: "rpc",
      payload: {
        method: "turn/started",
        params: { threadId: "t1", turn: { id: "live-turn" } },
      },
    });
    await act(() => sending);
    expect(result.current.selectedThread?.status).toBe("running");
    fake.serverSend({ type: "rpc", payload: { id: turnRequest.id, result: {} } });
  });

  it("keeps a Desktop-backed thread blocked when its lightweight resume fails", async () => {
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    const { result } = renderHook(() => useCodex(socket));
    await act(() => result.current.connect("secret", "ws://local/rpc"));
    act(() => {
      fake.serverSend({ type: "session", state: "ready", transport: "desktop-live", readOnly: false });
    });

    let refresh: Promise<void>;
    act(() => { refresh = result.current.refreshThreads(); });
    const { live: listRequest, desktop: desktopListRequest } = taskListRequests(fake);
    fake.serverSend({ type: "rpc", payload: { id: listRequest.id, result: { data: [] } } });
    fake.serverSend({
      type: "rpc",
      payload: { id: desktopListRequest.id, result: { data: [{ id: "t1", title: "Desktop task" }] } },
    });
    await act(() => refresh);

    let selection: Promise<void>;
    act(() => { selection = result.current.selectThread("t1"); });
    const mirrorRequest = JSON.parse(fake.sent.at(-1) as string).payload;
    fake.serverSend({
      type: "rpc",
      payload: {
        id: mirrorRequest.id,
        result: {
          desktopMirror: true,
          history: { hasMoreBefore: false },
          thread: { id: "t1", name: "Desktop task", status: { type: "idle" }, turns: [] },
        },
      },
    });
    await waitFor(() => expect(fake.sent).toHaveLength(4));
    const resumeRequest = JSON.parse(fake.sent.at(-1) as string).payload;
    fake.serverSend({
      type: "rpc",
      payload: { id: resumeRequest.id, error: { code: -1, message: "thread not found" } },
    });
    let failure: unknown;
    await act(async () => {
      try {
        await selection;
      } catch (cause) {
        failure = cause;
      }
    });

    expect(failure).toEqual(new Error("thread not found"));
    expect(result.current.selectedThreadError).toBe("thread not found");
    await expect(result.current.sendInstruction("Must not send")).rejects.toThrow("thread not found");
    expect(fake.sent.some((raw) => JSON.parse(raw).payload.method === "turn/start")).toBe(false);
  });

  it("loads model reasoning and permission choices from the app server", async () => {
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    const { result } = renderHook(() => useCodex(socket));
    await act(() => result.current.connect("secret", "ws://local/rpc"));

    let refresh: Promise<void>;
    act(() => { refresh = result.current.refreshCreationOptions("/code/app"); });
    const modelRequest = JSON.parse(fake.sent.at(-3) as string).payload;
    const permissionRequest = JSON.parse(fake.sent.at(-2) as string).payload;
    const visibilityRequest = JSON.parse(fake.sent.at(-1) as string).payload;
    expect(permissionRequest).toMatchObject({
      method: "permissionProfile/list",
      params: { limit: 100, cwd: "/code/app" },
    });
    fake.serverSend({
      type: "rpc",
      payload: {
        id: modelRequest.id,
        result: {
          data: [{
            id: "gpt-test",
            model: "gpt-test",
            displayName: "GPT Test",
            hidden: false,
            isDefault: true,
            defaultReasoningEffort: "medium",
            supportedReasoningEfforts: [
              { reasoningEffort: "low", description: "Fast" },
              { reasoningEffort: "high", description: "Deep" },
            ],
          }],
        },
      },
    });
    fake.serverSend({
      type: "rpc",
      payload: {
        id: visibilityRequest.id,
        result: { guardianApprovals: true, fullAccess: true },
      },
    });
    fake.serverSend({
      type: "rpc",
      payload: {
        id: permissionRequest.id,
        result: { data: [
          { id: ":read-only", description: null, allowed: true },
          { id: ":workspace", description: null, allowed: true },
          { id: ":danger-full-access", description: null, allowed: true },
        ] },
      },
    });
    await act(() => refresh);

    expect(result.current.creationOptions.models[0]).toMatchObject({
      id: "gpt-test",
      displayName: "GPT Test",
      defaultReasoningEffort: "medium",
      reasoningEfforts: ["low", "high"],
    });
    expect(result.current.creationOptions.permissions).toEqual([
      {
        id: "auto",
        label: "请求批准",
        description: "编辑外部文件和使用互联网时始终询问",
      },
      {
        id: "guardian-approvals",
        label: "帮我批准",
        description: "仅对检测到的风险操作请求批准",
      },
      {
        id: "full-access",
        label: "完全访问权限",
        description: "可不受限制地访问互联网和你电脑上的任何文件",
      },
    ]);
  });

  it("starts a new conversation with project model permission and reasoning settings", async () => {
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    const { result } = renderHook(() => useCodex(socket));
    await act(() => result.current.connect("secret", "ws://local/rpc"));

    let creation: Promise<string | undefined>;
    act(() => {
      creation = result.current.createThread({
        cwd: "/code/rdsai",
        model: "gpt-test",
        reasoningEffort: "high",
        permission: "full-access",
      });
    });
    const startRequest = JSON.parse(fake.sent.at(-1) as string).payload;
    expect(startRequest).toMatchObject({
      method: "thread/start",
      params: {
        cwd: "/code/rdsai",
        model: "gpt-test",
        permissions: ":danger-full-access",
        approvalPolicy: "never",
        approvalsReviewer: "user",
        config: { model_reasoning_effort: "high" },
      },
    });
    fake.serverSend({
      type: "rpc",
      payload: { id: startRequest.id, result: { thread: { id: "new-thread", cwd: "/code/rdsai" } } },
    });
    await waitFor(() => expect(fake.sent).toHaveLength(3));
    const refreshRequests = fake.sent.slice(1).map((value) => JSON.parse(value).payload);
    const listRequest = refreshRequests.find((request) => request.method === "thread/list");
    const metadataRequest = refreshRequests.find((request) => request.method === "desktopState/listThreads");
    fake.serverSend({
      type: "rpc",
      payload: { id: listRequest.id, result: { data: [{ id: "new-thread", cwd: "/code/rdsai" }] } },
    });
    fake.serverSend({
      type: "rpc",
      payload: { id: metadataRequest.id, result: { data: [{ id: "new-thread", cwd: "/code/rdsai" }] } },
    });
    await act(() => creation);

    expect(result.current.selectedThreadId).toBe("new-thread");
    expect(result.current.state.threads["new-thread"]).toMatchObject({
      status: "idle",
      model: "gpt-test",
      reasoningEffort: "high",
      permission: "full-access",
    });
  });

  it("uses composer setting changes for the next turn", async () => {
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    const { result } = renderHook(() => useCodex(socket));
    await act(() => result.current.connect("secret", "ws://local/rpc"));

    let selection: Promise<void>;
    act(() => { selection = result.current.selectThread("t1"); });
    const resumeRequest = JSON.parse(fake.sent.at(-1) as string).payload;
    fake.serverSend({
      type: "rpc",
      payload: {
        id: resumeRequest.id,
        result: {
          thread: { id: "t1", status: { type: "idle" }, turns: [] },
          model: "gpt-old",
          reasoningEffort: "medium",
          approvalPolicy: "on-request",
          approvalsReviewer: "user",
          sandbox: { type: "workspaceWrite" },
          activePermissionProfile: { id: ":workspace" },
        },
      },
    });
    await act(() => selection);

    let saving: Promise<void> | undefined;
    act(() => { saving = result.current.updateSelectedThreadSettings({
      model: "gpt-next",
      reasoningEffort: "high",
      permission: "full-access",
    }); });
    const settingsRequest = JSON.parse(fake.sent.at(-1) as string).payload;
    expect(settingsRequest).toMatchObject({
      method: "thread/settings/update",
      params: {
        threadId: "t1",
        model: "gpt-next",
        effort: "high",
        permissions: ":danger-full-access",
        approvalPolicy: "never",
        approvalsReviewer: "user",
      },
    });
    fake.serverSend({ type: "rpc", payload: { id: settingsRequest.id, result: {} } });
    await act(() => saving);
    act(() => { void result.current.sendInstruction("Use these settings"); });

    const turnRequest = JSON.parse(fake.sent.at(-1) as string).payload;
    expect(turnRequest).toMatchObject({
      method: "turn/start",
      params: {
        threadId: "t1",
        model: "gpt-next",
        effort: "high",
        permissions: ":danger-full-access",
        approvalPolicy: "never",
        approvalsReviewer: "user",
      },
    });
  });

  it("reports a settings rejection without discarding messages received while saving", async () => {
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    const { result } = renderHook(() => useCodex(socket));
    await act(() => result.current.connect("secret", "ws://local/rpc"));
    let selection: Promise<void>;
    act(() => { selection = result.current.selectThread("t1"); });
    const resume = JSON.parse(fake.sent.at(-1) as string).payload;
    fake.serverSend({ type: "rpc", payload: { id: resume.id, result: {
      thread: { id: "t1", status: { type: "idle" }, turns: [] },
      approvalPolicy: "on-request",
      activePermissionProfile: { id: ":workspace" },
    } } });
    await act(() => selection);

    let save: unknown;
    act(() => { save = result.current.updateSelectedThreadSettings({ permission: "full-access" }); });
    const update = JSON.parse(fake.sent.at(-1) as string).payload;
    act(() => fake.serverSend({ type: "rpc", payload: {
      method: "item/agentMessage/delta",
      params: { threadId: "t1", turnId: "turn-1", itemId: "agent-1", delta: "Keep this live text" },
    } }));
    await act(async () => {
      const rejected = expect(save).rejects.toThrow("Settings unavailable");
      fake.serverSend({ type: "rpc", payload: {
        id: update.id,
        error: { code: -32003, message: "Settings unavailable" },
      } });
      await rejected;
    });

    expect(result.current.selectedThread?.permission).toBe("auto");
    expect(result.current.selectedThread?.turns["turn-1"].items["agent-1"].text)
      .toBe("Keep this live text");
  });

  it("reduces streamed notifications into state", async () => {
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    const { result } = renderHook(() => useCodex(socket));
    await act(() => result.current.connect("secret", "ws://local/rpc"));

    act(() => {
      fake.serverSend({
        type: "rpc",
        payload: {
          method: "item/agentMessage/delta",
          params: { threadId: "t1", turnId: "turn-1", itemId: "i1", delta: "Checks complete" },
        },
      });
    });

    expect(result.current.state.threads.t1.turns["turn-1"].items.i1.text).toBe("Checks complete");
  });

  it("resumes a stored thread and keeps live events that arrive before the response", async () => {
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    const { result } = renderHook(() => useCodex(socket));
    await act(() => result.current.connect("secret", "ws://local/rpc"));

    let selection: Promise<void>;
    act(() => { selection = result.current.selectThread("t1"); });
    const request = JSON.parse(fake.sent.at(-1) as string).payload;
    expect(request).toMatchObject({ method: "thread/resume", params: { threadId: "t1" } });

    act(() => {
      fake.serverSend({
        type: "rpc",
        payload: {
          method: "item/agentMessage/delta",
          params: { threadId: "t1", turnId: "live-turn", itemId: "live-agent", delta: "Live" },
        },
      });
    });
    fake.serverSend({
      type: "rpc",
      payload: {
        id: request.id,
        result: {
          thread: {
            id: "t1",
            name: "Stored task",
            status: { type: "active" },
            turns: [{
              id: "stored-turn",
              status: "completed",
              items: [{ id: "stored-agent", type: "agentMessage", text: "Stored" }],
            }],
          },
          model: "gpt-test",
          reasoningEffort: "high",
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandbox: { type: "dangerFullAccess" },
          activePermissionProfile: null,
        },
      },
    });
    await act(() => selection);

    expect(result.current.state.threads.t1.turnOrder).toEqual(["stored-turn", "live-turn"]);
    expect(result.current.state.threads.t1.turns["live-turn"].items["live-agent"].text).toBe("Live");
    expect(result.current.state.threads.t1).toMatchObject({
      model: "gpt-test",
      reasoningEffort: "high",
      permission: "full-access",
      approvalPolicy: "never",
      approvalsReviewer: "user",
    });
  });

  it("keeps Queue until final when polling sees an older idle snapshot after turn start", async () => {
    vi.useFakeTimers();
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    const { result } = renderHook(() => useCodex(socket));
    try {
      await act(() => result.current.connect("secret", "ws://local/rpc"));
      act(() => fake.serverSend({ type: "session", state: "ready", transport: "desktop-live", readOnly: false }));
      let selection: Promise<void>;
      act(() => { selection = result.current.selectThread("t1"); });
      const request = JSON.parse(fake.sent.at(-1) as string).payload;
      fake.serverSend({ type: "rpc", payload: { id: request.id, result: {
        desktopMirror: true,
        thread: { id: "t1", status: "idle", turns: [{ id: "old-turn", status: "completed", items: [
          { id: "old-answer", type: "agentMessage", text: "旧答案" },
        ] }] },
      } } });
      await act(() => selection);

      act(() => fake.serverSend({ type: "rpc", payload: {
        method: "turn/started", params: { threadId: "t1", turn: { id: "new-turn" } },
      } }));
      const pollStart = fake.sent.length;
      await act(() => vi.advanceTimersByTimeAsync(2_000));
      const poll = fake.sent.slice(pollStart).map((raw) => JSON.parse(raw).payload)
        .find((sent) => sent.method === "desktopState/readThread");
      expect(poll).toBeTruthy();
      act(() => fake.serverSend({ type: "rpc", payload: { id: poll.id, result: {
        desktopMirror: true,
        thread: { id: "t1", status: "idle", turns: [{ id: "old-turn", status: "completed", items: [
          { id: "old-answer", type: "agentMessage", text: "旧答案" },
        ] }] },
      } } }));
      await act(async () => {});
      expect(result.current.state.threads.t1).toMatchObject({ status: "running", activeTurnId: "new-turn" });

      let queued: Promise<void>;
      act(() => { queued = result.current.sendInstruction("Queue next"); });
      const queueRequest = JSON.parse(fake.sent.at(-1) as string).payload;
      expect(queueRequest.method).toBe("desktop/queue/add");
      act(() => fake.serverSend({ type: "rpc", payload: { id: queueRequest.id, result: {
        message: { id: "queued-1", text: "Queue next" },
      } } }));
      await act(() => queued);

      for (const item of [
        { id: "commentary", type: "agentMessage", text: "处理中", phase: "commentary" },
        { id: "final", type: "agentMessage", text: "完成", phase: "final_answer" },
      ]) act(() => fake.serverSend({ type: "rpc", payload: {
        method: "item/completed", params: { threadId: "t1", turnId: "new-turn", item },
      } }));
      act(() => fake.serverSend({ type: "rpc", payload: {
        method: "turn/completed", params: { threadId: "t1", turn: { id: "new-turn", status: "completed" } },
      } }));
      expect(result.current.state.threads.t1).toMatchObject({ status: "idle", activeTurnId: undefined });
      expect(result.current.state.threads.t1.turns["new-turn"].items.final.phase).toBe("final_answer");

      let sent: Promise<void>;
      act(() => { sent = result.current.sendInstruction("Send next"); });
      const turnRequest = JSON.parse(fake.sent.at(-1) as string).payload;
      expect(turnRequest.method).toBe("turn/start");
      act(() => fake.serverSend({ type: "rpc", payload: { id: turnRequest.id, result: {} } }));
      await act(() => sent);
    } finally {
      vi.useRealTimers();
    }
  });

  it("prefers a completed resume snapshot over a partial live item with the same id", async () => {
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    const { result } = renderHook(() => useCodex(socket));
    await act(() => result.current.connect("secret", "ws://local/rpc"));

    let selection: Promise<void>;
    act(() => { selection = result.current.selectThread("t1"); });
    const request = JSON.parse(fake.sent.at(-1) as string).payload;
    act(() => {
      fake.serverSend({
        type: "rpc",
        payload: {
          method: "item/agentMessage/delta",
          params: { threadId: "t1", turnId: "turn-1", itemId: "agent-1", delta: "Hel" },
        },
      });
    });
    fake.serverSend({
      type: "rpc",
      payload: {
        id: request.id,
        result: {
          thread: {
            id: "t1",
            status: { type: "idle" },
            turns: [{
              id: "turn-1",
              status: "completed",
              items: [{ id: "agent-1", type: "agentMessage", text: "Hello", status: "completed" }],
            }],
          },
        },
      },
    });
    await act(() => selection);

    expect(result.current.state.threads.t1.turns["turn-1"]).toMatchObject({
      status: "completed",
      items: { "agent-1": { text: "Hello", status: "completed" } },
    });
    expect(result.current.state.threads.t1.activeTurnId).toBeUndefined();
  });

  it("exposes catalog errors without disconnecting the ready session", async () => {
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    const { result } = renderHook(() => useCodex(socket));
    await act(() => result.current.connect("secret", "ws://local/rpc"));

    let refresh: Promise<void>;
    act(() => { refresh = result.current.refreshCreationOptions(); });
    const modelRequest = JSON.parse(fake.sent.at(-3) as string).payload;
    const permissionRequest = JSON.parse(fake.sent.at(-2) as string).payload;
    const visibilityRequest = JSON.parse(fake.sent.at(-1) as string).payload;
    fake.serverSend({
      type: "rpc",
      payload: { id: modelRequest.id, error: { code: -1, message: "catalog unavailable" } },
    });
    fake.serverSend({
      type: "rpc",
      payload: { id: permissionRequest.id, result: { data: [] } },
    });
    fake.serverSend({
      type: "rpc",
      payload: {
        id: visibilityRequest.id,
        result: { guardianApprovals: true, fullAccess: true },
      },
    });
    await act(() => refresh);

    expect(result.current.connection).toBe("ready");
    expect(result.current.creationOptions).toMatchObject({
      loading: false,
      error: "catalog unavailable",
      permissions: [],
    });
  });

  it("exposes resume failures and keeps the selected thread blocked for retry", async () => {
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    const { result } = renderHook(() => useCodex(socket));
    await act(() => result.current.connect("secret", "ws://local/rpc"));

    let selection: Promise<void>;
    act(() => { selection = result.current.selectThread("missing"); });
    const request = JSON.parse(fake.sent.at(-1) as string).payload;
    fake.serverSend({
      type: "rpc",
      payload: { id: request.id, error: { code: -1, message: "thread unavailable" } },
    });
    await waitFor(() => expect(fake.sent).toHaveLength(2));
    const mirrorRequest = JSON.parse(fake.sent.at(-1) as string).payload;
    fake.serverSend({
      type: "rpc",
      payload: { id: mirrorRequest.id, error: { code: -1, message: "mirror unavailable" } },
    });
    let failure: unknown;
    await act(async () => {
      try {
        await selection;
      } catch (cause) {
        failure = cause;
      }
    });

    expect(failure).toEqual(new Error("thread unavailable"));
    expect(result.current.selectedThreadLoading).toBe(false);
    expect(result.current.selectedThreadError).toBe("thread unavailable");
  });

  it("falls back to the Desktop SQLite mirror when Desktop owns the active writer", async () => {
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    const { result } = renderHook(() => useCodex(socket));
    await act(() => result.current.connect("secret", "ws://local/rpc"));

    let selection: Promise<void>;
    act(() => { selection = result.current.selectThread("t1"); });
    const resumeRequest = JSON.parse(fake.sent.at(-1) as string).payload;
    fake.serverSend({
      type: "rpc",
      payload: { id: resumeRequest.id, error: { code: -1, message: "already has an active writer" } },
    });
    await waitFor(() => expect(fake.sent).toHaveLength(2));
    const mirrorRequest = JSON.parse(fake.sent.at(-1) as string).payload;
    expect(mirrorRequest).toMatchObject({ method: "desktopState/readThread", params: { threadId: "t1" } });
    fake.serverSend({
      type: "rpc",
      payload: {
        id: mirrorRequest.id,
        result: {
          desktopMirror: true,
          thread: {
            id: "t1",
            name: "Desktop task",
            cwd: "/tmp/project",
            status: { type: "active" },
            turns: [{
              id: "turn-1",
              status: "inProgress",
              items: [
                { id: "agent-1", type: "agentMessage", text: "Live from Desktop" },
                {
                  id: "todo-1",
                  type: "todoList",
                  explanation: "Current plan",
                  plan: [{ step: "Keep working", status: "inProgress" }],
                },
              ],
            }],
          },
        },
      },
    });
    await act(() => selection);

    expect(result.current.selectedThreadError).toBeUndefined();
    expect(result.current.selectedThread).toMatchObject({ desktopMirror: true, status: "running" });
    expect(result.current.selectedThread?.todoList).toEqual({
      turnId: "turn-1",
      explanation: "Current plan",
      items: [{ step: "Keep working", status: "inProgress" }],
    });
    expect(result.current.selectedThread?.turns["turn-1"].items["agent-1"].text).toBe("Live from Desktop");

    act(() => {
      fake.serverSend({
        type: "session",
        state: "ready",
        transport: "desktop-live",
        readOnly: false,
      });
    });
    expect(result.current.desktopControlAvailable).toBe(true);

    const image = validPngFile("screen.png", 400, 300);
    const fetchMock = vi.fn().mockResolvedValue({
      ok: true,
      json: async () => ({ id: "upload-1", name: "screen.png", mimeType: "image/png", size: 5 }),
    });
    vi.stubGlobal("fetch", fetchMock);
    let queueing: Promise<void>;
    act(() => { queueing = result.current.sendInstruction("Continue from the phone", [image]); });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(fake.sent.length).toBeGreaterThan(2));
    const queueRequest = JSON.parse(fake.sent.at(-1) as string).payload;
    expect(queueRequest).toMatchObject({
      method: "desktop/queue/add",
      params: {
        threadId: "t1",
        cwd: "/tmp/project",
        input: [
          { type: "text", text: "Continue from the phone" },
          { type: "remoteImage", id: "upload-1" },
        ],
      },
    });
    fake.serverSend({
      type: "rpc",
      payload: {
        id: queueRequest.id,
        result: { message: { id: "queued-1", text: "Continue from the phone", createdAt: 1 } },
      },
    });
    await act(() => queueing);
    expect(result.current.selectedQueuedMessages).toEqual([
      expect.objectContaining({ id: "queued-1", text: "Continue from the phone" }),
    ]);

    let imageOnlyQueueing: Promise<void>;
    act(() => { imageOnlyQueueing = result.current.sendInstruction("", [image]); });
    await waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(2));
    const imageOnlyQueueRequest = JSON.parse(fake.sent.at(-1) as string).payload;
    expect(imageOnlyQueueRequest).toMatchObject({
      method: "desktop/queue/add",
      params: {
        threadId: "t1",
        text: "",
        cwd: "/tmp/project",
        input: [{ type: "remoteImage", id: "upload-1" }],
      },
    });
    fake.serverSend({
      type: "rpc",
      payload: {
        id: imageOnlyQueueRequest.id,
        result: { message: { id: "queued-image-1", text: "", createdAt: 2 } },
      },
    });
    await act(() => imageOnlyQueueing);
    expect(result.current.selectedQueuedMessages).toEqual([
      expect.objectContaining({ id: "queued-1", text: "Continue from the phone" }),
      expect.objectContaining({ id: "queued-image-1", text: "" }),
    ]);

    let promoting: Promise<void>;
    act(() => { promoting = result.current.steerQueuedMessage("queued-1"); });
    const promoteRequest = JSON.parse(fake.sent.at(-1) as string).payload;
    expect(promoteRequest).toMatchObject({
      method: "desktop/queue/steer",
      params: { threadId: "t1", messageId: "queued-1", expectedTurnId: "turn-1" },
    });
    fake.serverSend({ type: "rpc", payload: { id: promoteRequest.id, result: { messageId: "queued-1" } } });
    await act(() => promoting);
    expect(result.current.selectedQueuedMessages).toEqual([
      expect.objectContaining({ id: "queued-image-1", text: "" }),
      expect.objectContaining({ id: "queued-1", text: "Continue from the phone", lifecycle: "promoting" }),
    ]);

    let steering: Promise<void>;
    act(() => { steering = result.current.sendInstruction("Guide immediately", [], "steer"); });
    const steeringQueueRequest = JSON.parse(fake.sent.at(-1) as string).payload;
    expect(steeringQueueRequest).toMatchObject({
      method: "desktop/queue/add",
      params: { threadId: "t1", text: "Guide immediately" },
    });
    fake.serverSend({
      type: "rpc",
      payload: {
        id: steeringQueueRequest.id,
        result: { message: { id: "queued-steer-1", text: "Guide immediately", createdAt: 2 } },
      },
    });
    await waitFor(() => expect(JSON.parse(fake.sent.at(-1) as string).payload.method).toBe("desktop/queue/steer"));
    const immediateSteerRequest = JSON.parse(fake.sent.at(-1) as string).payload;
    expect(immediateSteerRequest).toMatchObject({
      method: "desktop/queue/steer",
      params: { threadId: "t1", messageId: "queued-steer-1", expectedTurnId: "turn-1" },
    });
    fake.serverSend({ type: "rpc", payload: { id: immediateSteerRequest.id, result: { messageId: "queued-steer-1" } } });
    await act(() => steering);
    expect(result.current.selectedQueuedMessages).toEqual([
      expect.objectContaining({ id: "queued-image-1", text: "" }),
      expect.objectContaining({ id: "queued-1", text: "Continue from the phone", lifecycle: "promoting" }),
      expect.objectContaining({ id: "queued-steer-1", text: "Guide immediately", lifecycle: "promoting" }),
    ]);
    vi.unstubAllGlobals();
  });

  it("refreshes a selected Desktop thread while live control is available", async () => {
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    const { result } = renderHook(() => useCodex(socket));
    await act(() => result.current.connect("secret", "ws://local/rpc"));
    act(() => {
      fake.serverSend({
        type: "session",
        state: "ready",
        transport: "desktop-live",
        readOnly: false,
      });
    });

    let refresh: Promise<void>;
    act(() => { refresh = result.current.refreshThreads(); });
    const { live: liveList, desktop: desktopList } = taskListRequests(fake);
    fake.serverSend({ type: "rpc", payload: { id: liveList.id, result: { data: [] } } });
    fake.serverSend({
      type: "rpc",
      payload: { id: desktopList.id, result: { data: [{ id: "t1", title: "Live task" }] } },
    });
    await act(() => refresh);

    let selection: Promise<void>;
    act(() => { selection = result.current.selectThread("t1"); });
    const initialRead = JSON.parse(fake.sent.at(-1) as string).payload;
    fake.serverSend({
      type: "rpc",
      payload: {
        id: initialRead.id,
        result: {
          desktopMirror: true,
          thread: {
            id: "t1",
            status: { type: "active" },
            turns: [{ id: "turn-1", status: "inProgress", items: [] }],
          },
        },
      },
    });
    await waitFor(() => expect(fake.sent).toHaveLength(4));
    const resume = JSON.parse(fake.sent.at(-1) as string).payload;
    expect(resume.method).toBe("thread/resume");
    fake.serverSend({ type: "rpc", payload: { id: resume.id, result: {} } });
    await act(() => selection);

    let queueing: Promise<void>;
    act(() => { queueing = result.current.sendInstruction("Visible queued follow-up"); });
    const queue = JSON.parse(fake.sent.at(-1) as string).payload;
    expect(queue.method).toBe("desktop/queue/add");
    fake.serverSend({ type: "rpc", payload: { id: queue.id, result: { message: { id: "queued-1", text: "Visible queued follow-up" } } } });
    await act(() => queueing);

    const beforePoll = fake.sent.length;
    await act(() => new Promise((resolve) => setTimeout(resolve, 2_100)));
    const pollRequests = fake.sent.slice(beforePoll).map((entry) => JSON.parse(entry).payload);
    const poll = pollRequests.find((request) => request.method === "desktopState/readThread");
    expect(poll).toMatchObject({
      method: "desktopState/readThread",
      params: { threadId: "t1", history: { limitTurns: 1 } },
    });
    const queuePoll = pollRequests.find((request) => request.method === "desktop/queue/list");
    expect(queuePoll).toMatchObject({ method: "desktop/queue/list", params: { threadId: "t1" } });
    fake.serverSend({ type: "rpc", payload: { id: queuePoll.id, result: { messages: [] } } });
    fake.serverSend({
      type: "rpc",
      payload: {
        id: poll.id,
        result: {
          desktopMirror: true,
          thread: {
            id: "t1",
            status: { type: "active" },
            todoList: {
              explanation: "Live plan",
              plan: [{ step: "Keep polling", status: "in_progress" }],
            },
            turns: [{
              id: "turn-2",
              status: "inProgress",
              items: [{ id: "steer-1", type: "user_message", text: "  Visible   steer  " }],
            }],
          },
        },
      },
    });

    await waitFor(() => expect(result.current.selectedThread?.todoList).toEqual({
      explanation: "Live plan",
      items: [{ step: "Keep polling", status: "inProgress" }],
    }));
    expect(result.current.selectedThread?.turns["turn-2"].items["steer-1"].text).toContain("Visible");
    expect(Object.values(result.current.selectedThread?.turns ?? {})
      .flatMap((turn) => Object.values(turn.items))
      .filter((item) => item.type.toLocaleLowerCase().includes("user") && item.text.includes("Visible")))
      .toHaveLength(1);
  });

  it("captures the gateway default cwd used for direct conversations", async () => {
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    const { result } = renderHook(() => useCodex(socket));
    await act(() => result.current.connect("secret", "ws://local/rpc"));

    act(() => {
      fake.serverSend({ type: "session", state: "ready", defaultCwd: "/service/default" });
    });

    expect(result.current.defaultCwd).toBe("/service/default");
  });

  it("archives through the shared Codex protocol and refreshes the Desktop-backed list", async () => {
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    const { result } = renderHook(() => useCodex(socket));
    await act(() => result.current.connect("secret", "ws://local/rpc"));

    let archiving: Promise<void>;
    act(() => { archiving = result.current.archiveThread("t1"); });
    const archiveRequest = JSON.parse(fake.sent.at(-1) as string).payload;
    expect(archiveRequest).toMatchObject({ method: "thread/archive", params: { threadId: "t1" } });
    fake.serverSend({ type: "rpc", payload: { id: archiveRequest.id, result: {} } });

    await waitFor(() => expect(fake.sent).toHaveLength(3));
    const refreshRequests = fake.sent.slice(1).map((value) => JSON.parse(value).payload);
    const listRequest = refreshRequests.find((request) => request.method === "thread/list");
    const metadataRequest = refreshRequests.find((request) => request.method === "desktopState/listThreads");
    fake.serverSend({ type: "rpc", payload: { id: listRequest.id, result: { data: [] } } });
    fake.serverSend({ type: "rpc", payload: { id: metadataRequest.id, result: { data: [] } } });
    await act(() => archiving);
  });

  it("loads archived Desktop conversations separately from the active list", async () => {
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    const { result } = renderHook(() => useCodex(socket));
    await act(() => result.current.connect("secret", "ws://local/rpc"));

    let loading: Promise<void>;
    act(() => { loading = result.current.refreshArchivedThreads(); });
    const listRequest = JSON.parse(fake.sent.at(-1) as string).payload;
    expect(listRequest).toMatchObject({ method: "thread/list", params: { archived: true } });
    fake.serverSend({
      type: "rpc",
      payload: { id: listRequest.id, result: { data: [{ id: "a1", name: "Old archived title" }] } },
    });
    await waitFor(() => expect(JSON.parse(fake.sent.at(-1) as string).payload.method)
      .toBe("desktopState/listThreads"));
    const desktopRequest = JSON.parse(fake.sent.at(-1) as string).payload;
    expect(desktopRequest.params).toEqual({ archived: true });
    fake.serverSend({
      type: "rpc",
      payload: { id: desktopRequest.id, result: { data: [{ id: "a1", title: "Desktop archived title" }] } },
    });
    await act(() => loading);

    expect(result.current.archivedThreads).toEqual([
      expect.objectContaining({ id: "a1", title: "Desktop archived title" }),
    ]);
  });

  it("uses the official rename unarchive and delete thread methods", async () => {
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    const { result } = renderHook(() => useCodex(socket));
    await act(() => result.current.connect("secret", "ws://local/rpc"));

    let selection: Promise<void>;
    act(() => { selection = result.current.selectThread("t1"); });
    const resume = JSON.parse(fake.sent.at(-1) as string).payload;
    fake.serverSend({
      type: "rpc",
      payload: { id: resume.id, result: { thread: { id: "t1", name: "Original", turns: [] } } },
    });
    await act(() => selection);

    let renaming: Promise<void>;
    act(() => { renaming = result.current.renameThread("t1", "Renamed"); });
    const rename = JSON.parse(fake.sent.at(-1) as string).payload;
    expect(rename).toMatchObject({ method: "thread/name/set", params: { threadId: "t1", name: "Renamed" } });
    fake.serverSend({ type: "rpc", payload: { id: rename.id, result: {} } });
    await act(() => renaming);
    expect(result.current.state.threads.t1.title).toBe("Renamed");

    let unarchiving: Promise<void>;
    act(() => { unarchiving = result.current.unarchiveThread("archived-1"); });
    const unarchive = JSON.parse(fake.sent.at(-1) as string).payload;
    expect(unarchive).toMatchObject({ method: "thread/unarchive", params: { threadId: "archived-1" } });
    fake.serverSend({ type: "rpc", payload: { id: unarchive.id, result: {} } });
    await act(() => unarchiving);

    let deleting: Promise<void>;
    act(() => { deleting = result.current.deleteThread("t1"); });
    const deletion = JSON.parse(fake.sent.at(-1) as string).payload;
    expect(deletion).toMatchObject({ method: "thread/delete", params: { threadId: "t1" } });
    fake.serverSend({ type: "rpc", payload: { id: deletion.id, result: {} } });
    await act(() => deleting);
    expect(result.current.state.threads.t1).toBeUndefined();
  });

  it("loads the pinned section and moves a thread into it", async () => {
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    const { result } = renderHook(() => useCodex(socket));
    await act(() => result.current.connect("secret", "ws://local/rpc"));

    let sections: Promise<void>;
    act(() => { sections = result.current.refreshThreadSections(); });
    const sectionRequest = JSON.parse(fake.sent.at(-1) as string).payload;
    expect(sectionRequest.method).toBe("threadSection/list");
    fake.serverSend({
      type: "rpc",
      payload: {
        id: sectionRequest.id,
        result: { data: [{ id: "pinned-section", name: "Pinned", appearance: null }] },
      },
    });
    await act(() => sections);

    let pinning: Promise<void>;
    act(() => { pinning = result.current.togglePin("t1"); });
    const moveRequest = JSON.parse(fake.sent.at(-1) as string).payload;
    expect(moveRequest).toMatchObject({
      method: "thread/section/move",
      params: { threadId: "t1", sectionId: "pinned-section" },
    });
    fake.serverSend({ type: "rpc", payload: { id: moveRequest.id, result: {} } });
    await waitFor(() => expect(fake.sent).toHaveLength(4));
    const refreshRequests = fake.sent.slice(2).map((value) => JSON.parse(value).payload);
    const listRequest = refreshRequests.find((request) => request.method === "thread/list");
    const metadataRequest = refreshRequests.find((request) => request.method === "desktopState/listThreads");
    fake.serverSend({
      type: "rpc",
      payload: {
        id: listRequest.id,
        result: {
          data: [{
            id: "t1",
            name: "Pinned task",
            section: { id: "pinned-section", name: "Pinned" },
          }],
        },
      },
    });
    fake.serverSend({
      type: "rpc",
      payload: {
        id: metadataRequest.id,
        result: { data: [{ id: "t1", title: "Pinned task", isPinned: true }] },
      },
    });
    await act(() => pinning);

    expect(result.current.state.threads.t1).toMatchObject({
      sectionId: "desktop-pinned",
      sectionName: "Pinned",
    });
  });

  it("pins through Desktop's authoritative host state when the bridge is live", async () => {
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    const { result } = renderHook(() => useCodex(socket));
    await act(() => result.current.connect("secret", "ws://local/rpc"));
    act(() => {
      fake.serverSend({
        type: "session",
        state: "ready",
        transport: "desktop-live",
        readOnly: false,
      });
    });

    let refresh: Promise<void>;
    act(() => { refresh = result.current.refreshThreads(); });
    const { live: listRequest, desktop: metadataRequest } = taskListRequests(fake);
    fake.serverSend({
      type: "rpc",
      payload: { id: listRequest.id, result: { data: [{ id: "old-pin" }, { id: "new-pin" }] } },
    });
    fake.serverSend({
      type: "rpc",
      payload: {
        id: metadataRequest.id,
        result: {
          data: [
            { id: "old-pin", title: "Old pin", isPinned: true },
            { id: "new-pin", title: "New pin", isPinned: false },
          ],
        },
      },
    });
    await act(() => refresh);

    let pinning: Promise<void>;
    act(() => { pinning = result.current.togglePin("new-pin"); });
    const pinRequest = JSON.parse(fake.sent.at(-1) as string).payload;
    expect(pinRequest).toMatchObject({
      method: "desktop/setThreadPinned",
      params: { threadId: "new-pin", pinned: true, beforeThreadId: "old-pin" },
    });
    fake.serverSend({ type: "rpc", payload: { id: pinRequest.id, result: { pinned: true } } });

    await waitFor(() => expect(fake.sent).toHaveLength(5));
    const refreshRequests = fake.sent.slice(3).map((value) => JSON.parse(value).payload);
    const refreshedList = refreshRequests.find((request) => request.method === "thread/list");
    const refreshedMetadata = refreshRequests.find((request) => request.method === "desktopState/listThreads");
    fake.serverSend({
      type: "rpc",
      payload: { id: refreshedList.id, result: { data: [{ id: "new-pin" }, { id: "old-pin" }] } },
    });
    fake.serverSend({
      type: "rpc",
      payload: {
        id: refreshedMetadata.id,
        result: {
          data: [
            { id: "new-pin", title: "New pin", isPinned: true },
            { id: "old-pin", title: "Old pin", isPinned: true },
          ],
        },
      },
    });
    await act(() => pinning);
    expect(result.current.state.threadOrder).toEqual(["new-pin", "old-pin"]);
  });

  it("creates the pinned section before pinning when it does not exist", async () => {
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    const { result } = renderHook(() => useCodex(socket));
    await act(() => result.current.connect("secret", "ws://local/rpc"));

    let pinning: Promise<void>;
    act(() => { pinning = result.current.togglePin("t1"); });
    const createRequest = JSON.parse(fake.sent.at(-1) as string).payload;
    expect(createRequest).toMatchObject({ method: "threadSection/create", params: { name: "Pinned" } });
    fake.serverSend({
      type: "rpc",
      payload: {
        id: createRequest.id,
        result: { section: { id: "new-pinned", name: "Pinned", appearance: null } },
      },
    });
    await waitFor(() => expect(fake.sent).toHaveLength(2));
    const moveRequest = JSON.parse(fake.sent.at(-1) as string).payload;
    fake.serverSend({ type: "rpc", payload: { id: moveRequest.id, result: {} } });
    await waitFor(() => expect(fake.sent).toHaveLength(4));
    const refreshRequests = fake.sent.slice(2).map((value) => JSON.parse(value).payload);
    const listRequest = refreshRequests.find((request) => request.method === "thread/list");
    const metadataRequest = refreshRequests.find((request) => request.method === "desktopState/listThreads");
    fake.serverSend({ type: "rpc", payload: { id: listRequest.id, result: { data: [] } } });
    fake.serverSend({ type: "rpc", payload: { id: metadataRequest.id, result: { data: [] } } });
    await act(() => pinning);

    expect(moveRequest).toMatchObject({
      method: "thread/section/move",
      params: { threadId: "t1", sectionId: "new-pinned" },
    });
  });

  it("returns to the task list without disconnecting", async () => {
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    const { result } = renderHook(() => useCodex(socket));
    await act(() => result.current.connect("secret", "ws://local/rpc"));

    let selection: Promise<void>;
    act(() => { selection = result.current.selectThread("t1"); });
    const request = JSON.parse(fake.sent.at(-1) as string).payload;
    expect(request.method).toBe("thread/resume");
    fake.serverSend({
      type: "rpc",
      payload: { id: request.id, result: { thread: { id: "t1", name: "Task" } } },
    });
    await act(() => selection);
    expect(result.current.selectedThreadId).toBe("t1");

    act(() => result.current.clearSelection());
    expect(result.current.selectedThreadId).toBeUndefined();
    expect(result.current.connection).toBe("ready");
  });
});

function validPngFile(name: string, width: number, height: number) {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const view = new DataView(bytes.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return new File([bytes], name, { type: "image/png" });
}

describe("optimistic steer reconciliation", () => {
  it.each([
    {
      name: "text",
      optimisticText: "Continue after reload",
      snapshotText: "Continue after reload",
      optimisticImages: [] as string[],
      snapshotImages: undefined,
    },
    {
      name: "image-only",
      optimisticText: "",
      snapshotText: "",
      optimisticImages: ["upload-1"],
      snapshotImages: undefined,
    },
  ])("reconciles a snapshot-only $name confirmation for a staged thread start", ({
    optimisticText,
    snapshotText,
    optimisticImages,
    snapshotImages,
  }) => {
    const reconciler = new ConversationReconciler();
    const state: CodexState = {
      stale: false,
      threadOrder: ["t1"],
      threads: {
        t1: {
          id: "t1",
          title: "Live",
          status: "running",
          activeTurnId: "web-start-turn-web-start-1",
          turnOrder: ["web-start-turn-web-start-1"],
          turns: {
            "web-start-turn-web-start-1": {
              id: "web-start-turn-web-start-1",
              status: "inProgress",
              itemOrder: ["web-start-1"],
              items: {
                "web-start-1": {
                  id: "web-start-1",
                  type: "userMessage",
                  text: optimisticText,
                  imageIds: optimisticImages,
                  clientMessageId: "web-start-1",
                  lifecycle: "pending",
                },
              },
            },
          },
        },
      },
    };

    const next = reconciler.hydrate(state, {
      desktopMirror: true,
      thread: {
        id: "t1",
        status: { type: "idle" },
        turns: [{
          id: "turn-1",
          status: "completed",
          completeFromTurnStart: true,
          items: [{
            id: "user-1",
            type: "user_message",
            text: snapshotText,
            ...(snapshotImages ? { imageIds: snapshotImages } : {}),
          }],
        }],
      },
    });

    expect(next.threads.t1.turnOrder).toEqual(["turn-1"]);
    expect(next.threads.t1.turns["web-start-turn-web-start-1"]).toBeUndefined();
    expect(next.threads.t1.turns["turn-1"].itemOrder).toEqual(["user-1"]);
    expect(next.threads.t1.turns["turn-1"].items["user-1"]).toMatchObject({
      text: snapshotText,
      lifecycle: "confirmed",
      ...(optimisticImages.length ? { imageIds: optimisticImages } : {}),
    });
    expect(next.threads.t1.activeTurnId).toBeUndefined();
    expect(next.threads.t1.status).toBe("idle");
  });

  it("keeps snapshot image metadata when an earlier live item omitted it", () => {
    const reconciler = new ConversationReconciler();
    const state: CodexState = {
      stale: false,
      threadOrder: ["t1"],
      threads: {
        t1: {
          id: "t1",
          title: "Live",
          status: "running",
          activeTurnId: "turn-1",
          turnOrder: ["turn-1"],
          turns: {
            "turn-1": {
              id: "turn-1",
              status: "inProgress",
              itemOrder: ["user-1"],
              items: {
                "user-1": { id: "user-1", type: "userMessage", text: "" },
              },
            },
          },
        },
      },
    };

    const next = reconciler.hydrate(state, {
      desktopMirror: true,
      thread: {
        id: "t1",
        status: { type: "idle" },
        turns: [{
          id: "turn-1",
          status: "completed",
          items: [{ id: "user-1", type: "userMessage", text: "", imageIds: ["upload-1"] }],
        }],
      },
    });

    expect(next.threads.t1.turns["turn-1"].items["user-1"].imageIds).toEqual(["upload-1"]);
  });

  it("reconciles a same-text pending message with a new no-id confirmation in the current turn", () => {
    const reconciler = new ConversationReconciler();
    const state: CodexState = {
      stale: false,
      threadOrder: ["t1"],
      threads: {
        t1: {
          id: "t1",
          title: "Live",
          status: "running",
          activeTurnId: "turn-current",
          turnOrder: ["turn-old", "turn-current"],
          turns: {
            "turn-old": {
              id: "turn-old",
              status: "completed",
              itemOrder: ["old-user"],
              items: { "old-user": { id: "old-user", type: "user_message", text: "继续", lifecycle: "confirmed" } },
            },
            "turn-current": {
              id: "turn-current",
              status: "inProgress",
              itemOrder: ["web-steer-new"],
              items: {
                "web-steer-new": {
                  id: "web-steer-new",
                  type: "userMessage",
                  text: "继续",
                  clientMessageId: "client-new",
                  lifecycle: "pending",
                },
              },
            },
          },
        },
      },
    };

    const confirmed = reconciler.reduceEvent(state, {
      method: "item/started",
      params: {
        threadId: "t1",
        turnId: "turn-current",
        item: { id: "current-user", type: "user_message", text: "继续" },
      },
    });

    expect(confirmed.threads.t1.turns["turn-current"].items["web-steer-new"]).toBeUndefined();
    expect(confirmed.threads.t1.turns["turn-current"].items["current-user"]).toMatchObject({ text: "继续" });
  });

  it("keeps a new same-text pending message when an older confirmed identity is replayed under another item id", () => {
    const reconciler = new ConversationReconciler();
    const state: CodexState = {
      stale: false,
      threadOrder: ["t1"],
      threads: {
        t1: {
          id: "t1",
          title: "Live",
          status: "running",
          activeTurnId: "turn-current",
          turnOrder: ["turn-old", "turn-current"],
          turns: {
            "turn-old": {
              id: "turn-old",
              status: "inProgress",
              itemOrder: ["old-user"],
              items: {
                "old-user": {
                  id: "old-user",
                  type: "user_message",
                  text: "继续",
                  clientMessageId: "client-old",
                  lifecycle: "confirmed",
                },
              },
            },
            "turn-current": {
              id: "turn-current",
              status: "inProgress",
              itemOrder: ["web-steer-new"],
              items: {
                "web-steer-new": {
                  id: "web-steer-new",
                  type: "userMessage",
                  text: "继续",
                  clientMessageId: "client-new",
                  lifecycle: "pending",
                },
              },
            },
          },
        },
      },
    };

    const replayed = reconciler.reduceEvent(state, {
      method: "item/started",
      params: {
        threadId: "t1",
        turnId: "turn-old",
        item: {
          id: "old-user-replayed",
          type: "user_message",
          text: "继续",
          clientMessageId: "client-old",
        },
      },
    });

    expect(replayed.threads.t1.turns["turn-current"].items["web-steer-new"]).toMatchObject({
      text: "继续",
      lifecycle: "pending",
    });
  });

  it("keeps a local optimistic message when Desktop reports another client id", () => {
    const reconciler = new ConversationReconciler();
    const staged = reconciler.stageUserMessage({
      stale: false,
      threadOrder: ["t1"],
      threads: {
        t1: {
          id: "t1",
          title: "Live",
          status: "running",
          activeTurnId: "turn-1",
          turnOrder: ["turn-1"],
          turns: { "turn-1": { id: "turn-1", status: "inProgress", itemOrder: [], items: {} } },
        },
      },
    }, "t1", "turn-1", "web-steer-local", "继续处理这个问题", []);

    const confirmed = reconciler.reduceEvent(staged, {
      method: "item/started",
      params: {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          id: "desktop-user-message",
          type: "user_message",
          text: "继续处理这个问题",
          clientMessageId: "desktop-generated-id",
        },
      },
    });
    const userItems = Object.values(confirmed.threads.t1.turns["turn-1"].items)
      .filter((item) => item.type.toLocaleLowerCase().includes("user"));

    expect(userItems).toHaveLength(2);
    expect(userItems.find((item) => item.id === "web-steer-local")).toMatchObject({
      lifecycle: "pending", clientMessageId: "web-steer-local",
    });
    expect(userItems.find((item) => item.id === "desktop-user-message")?.clientMessageId).toBe("desktop-generated-id");
  });

  it("removes a new optimistic message when Desktop reuses its authoritative item id", () => {
    const reconciler = new ConversationReconciler();
    const staged = reconciler.stageUserMessage({
      stale: false,
      threadOrder: ["t1"],
      threads: {
        t1: {
          id: "t1",
          title: "Live",
          status: "running",
          activeTurnId: "turn-current",
          turnOrder: ["turn-confirmed", "turn-current"],
          turns: {
            "turn-confirmed": {
              id: "turn-confirmed",
              status: "inProgress",
              itemOrder: ["desktop-user-message"],
              items: {
                "desktop-user-message": {
                  id: "desktop-user-message",
                  type: "user_message",
                  text: "上一条引导",
                  lifecycle: "confirmed",
                },
              },
            },
            "turn-current": { id: "turn-current", status: "inProgress", itemOrder: [], items: {} },
          },
        },
      },
    }, "t1", "turn-current", "web-steer-next", "新的引导内容", []);

    const confirmed = reconciler.reduceEvent(staged, {
      method: "item/started",
      params: {
        threadId: "t1",
        turnId: "turn-confirmed",
        item: { id: "desktop-user-message", type: "user_message", text: "新的引导内容" },
      },
    });
    const matchingItems = Object.values(confirmed.threads.t1.turns)
      .flatMap((turn) => Object.values(turn.items))
      .filter((item) => item.type.toLocaleLowerCase().includes("user") && item.text === "新的引导内容");

    expect(matchingItems).toHaveLength(1);
    expect(matchingItems[0].id).toBe("desktop-user-message");
  });

  it("does not append an optimistic duplicate when Desktop confirms first", () => {
    const state: CodexState = {
      stale: false,
      threadOrder: ["t1"],
      threads: {
        t1: {
          id: "t1",
          title: "Live",
          status: "running",
          activeTurnId: "turn-1",
          turnOrder: ["turn-1", "turn-2"],
          turns: {
            "turn-1": { id: "turn-1", status: "inProgress", itemOrder: [], items: {} },
            "turn-2": {
              id: "turn-2",
              status: "inProgress",
              itemOrder: ["desktop-user"],
              items: {
                "desktop-user": { id: "desktop-user", type: "user_message", text: "你调研怎么样？" },
              },
            },
          },
        },
      },
    };

    const next = addOptimisticUserMessage(
      state,
      "t1",
      "turn-1",
      "web-steer-late",
      "你调研怎么样？",
      [],
    );

    expect(next).toBe(state);
    expect(next.threads.t1.turns["turn-1"].itemOrder).toEqual([]);
  });

  it("does not append a duplicate when the Desktop confirmation wraps an image message", () => {
    const state: CodexState = {
      stale: false,
      threadOrder: ["t1"],
      threads: {
        t1: {
          id: "t1",
          title: "Live",
          status: "running",
          activeTurnId: "turn-1",
          turnOrder: ["turn-1", "turn-2"],
          turns: {
            "turn-1": { id: "turn-1", status: "inProgress", itemOrder: [], items: {} },
            "turn-2": {
              id: "turn-2",
              status: "inProgress",
              itemOrder: ["desktop-user"],
              items: {
                "desktop-user": {
                  id: "desktop-user",
                  type: "user_message",
                  text: "# Files mentioned by the user:\n\nimage.jpg\n\n## My request:\n调整移动端标题布局\n<image name=[Image #1] path=\"/private/upload.jpg\">\n</image>",
                },
              },
            },
          },
        },
      },
    };

    const next = addOptimisticUserMessage(
      state,
      "t1",
      "turn-1",
      "web-steer-image-late",
      "调整移动端标题布局",
      ["uploaded-image"],
    );

    expect(next.threads.t1.turns["turn-1"].itemOrder).toEqual([]);
    expect(next.threads.t1.turns["turn-2"].items["desktop-user"].imageIds).toEqual(["uploaded-image"]);
  });
});
