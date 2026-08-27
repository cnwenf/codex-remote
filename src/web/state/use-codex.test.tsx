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

describe("ConversationReconciler", () => {
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

  it("uses an authoritative idle Desktop snapshot to close retained running state", () => {
    const reconciler = new ConversationReconciler();
    const state: CodexState = {
      stale: false,
      threadOrder: ["t1"],
      threads: {
        t1: {
          id: "t1",
          title: "Task",
          status: "running",
          activeTurnId: "turn-1",
          turnOrder: ["turn-1"],
          turns: {
            "turn-1": {
              id: "turn-1",
              status: "inProgress",
              itemOrder: ["tool-1"],
              items: {
                "tool-1": { id: "tool-1", type: "commandExecution", text: "", status: "running" },
              },
            },
          },
        },
      },
    };

    const next = reconciler.hydrate(state, {
      desktopMirror: true,
      thread: { id: "t1", status: { type: "idle" }, turns: [] },
    });

    expect(next.threads.t1.status).toBe("idle");
    expect(next.threads.t1.activeTurnId).toBeUndefined();
    expect(next.threads.t1.turns["turn-1"].status).toBe("completed");
    expect(next.threads.t1.turns["turn-1"].items["tool-1"].status).toBe("completed");
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
});

describe("useCodex", () => {
  it("loads and normalizes the task list", async () => {
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    const { result } = renderHook(() => useCodex(socket));
    await act(() => result.current.connect("secret", "ws://local/rpc"));

    let refresh: Promise<void>;
    act(() => {
      refresh = result.current.refreshThreads();
    });
    const request = JSON.parse(fake.sent.at(-1) as string).payload;
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
    await waitFor(() => expect(fake.sent).toHaveLength(2));
    const metadataRequest = JSON.parse(fake.sent.at(-1) as string).payload;
    expect(metadataRequest.method).toBe("desktopState/listThreads");
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

  it("does not let a stale idle list snapshot overwrite an active turn", async () => {
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    const { result } = renderHook(() => useCodex(socket));
    await act(() => result.current.connect("secret", "ws://local/rpc"));

    async function refreshWithIdleSnapshot() {
      let refresh: Promise<void>;
      act(() => { refresh = result.current.refreshThreads(); });
      const listRequest = JSON.parse(fake.sent.at(-1) as string).payload;
      fake.serverSend({
        type: "rpc",
        payload: { id: listRequest.id, result: { data: [{ id: "t1", name: "Task", status: { type: "idle" } }] } },
      });
      await waitFor(() => expect(JSON.parse(fake.sent.at(-1) as string).payload.method).toBe("desktopState/listThreads"));
      const metadataRequest = JSON.parse(fake.sent.at(-1) as string).payload;
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

  it("keeps the Desktop snapshot visible while the live bridge is read-only", async () => {
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    const { result } = renderHook(() => useCodex(socket));
    await act(() => result.current.connect("secret", "ws://local/rpc"));

    let refresh: Promise<void>;
    act(() => { refresh = result.current.refreshThreads(); });
    const liveRequest = JSON.parse(fake.sent.at(-1) as string).payload;
    fake.serverSend({
      type: "rpc",
      payload: {
        id: liveRequest.id,
        error: { code: -32001, message: "Desktop bridge is read-only" },
      },
    });
    await waitFor(() => expect(fake.sent).toHaveLength(2));
    const snapshotRequest = JSON.parse(fake.sent.at(-1) as string).payload;
    expect(snapshotRequest.method).toBe("desktopState/listThreads");
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

  it("opens a Desktop thread from its latest page and prepends older history on demand", async () => {
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    const { result } = renderHook(() => useCodex(socket));
    await act(() => result.current.connect("secret", "ws://local/rpc"));

    let refresh: Promise<void>;
    act(() => { refresh = result.current.refreshThreads(); });
    const listRequest = JSON.parse(fake.sent.at(-1) as string).payload;
    fake.serverSend({ type: "rpc", payload: { id: listRequest.id, result: { data: [] } } });
    await waitFor(() => expect(fake.sent).toHaveLength(2));
    const desktopListRequest = JSON.parse(fake.sent.at(-1) as string).payload;
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
    const listRequest = JSON.parse(fake.sent.at(-1) as string).payload;
    fake.serverSend({ type: "rpc", payload: { id: listRequest.id, result: { data: [] } } });
    await waitFor(() => expect(fake.sent).toHaveLength(2));
    const desktopListRequest = JSON.parse(fake.sent.at(-1) as string).payload;
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
    const listRequest = JSON.parse(fake.sent.at(-1) as string).payload;
    fake.serverSend({ type: "rpc", payload: { id: listRequest.id, result: { data: [] } } });
    await waitFor(() => expect(fake.sent).toHaveLength(2));
    const desktopListRequest = JSON.parse(fake.sent.at(-1) as string).payload;
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
    await waitFor(() => expect(fake.sent).toHaveLength(2));
    const listRequest = JSON.parse(fake.sent.at(-1) as string).payload;
    fake.serverSend({
      type: "rpc",
      payload: { id: listRequest.id, result: { data: [{ id: "new-thread", cwd: "/code/rdsai" }] } },
    });
    await waitFor(() => expect(fake.sent).toHaveLength(3));
    const metadataRequest = JSON.parse(fake.sent.at(-1) as string).payload;
    expect(metadataRequest.method).toBe("desktopState/listThreads");
    fake.serverSend({
      type: "rpc",
      payload: { id: metadataRequest.id, result: { data: [{ id: "new-thread", cwd: "/code/rdsai" }] } },
    });
    await act(() => creation);

    expect(result.current.selectedThreadId).toBe("new-thread");
    expect(result.current.state.threads["new-thread"]).toMatchObject({
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

    act(() => result.current.updateSelectedThreadSettings({
      model: "gpt-next",
      reasoningEffort: "high",
      permission: "full-access",
    }));
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

    const image = new File(["image"], "screen.png", { type: "image/png" });
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
    const liveList = JSON.parse(fake.sent.at(-1) as string).payload;
    fake.serverSend({ type: "rpc", payload: { id: liveList.id, result: { data: [] } } });
    await waitFor(() => expect(fake.sent).toHaveLength(2));
    const desktopList = JSON.parse(fake.sent.at(-1) as string).payload;
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

    await waitFor(() => expect(fake.sent).toHaveLength(2));
    const listRequest = JSON.parse(fake.sent.at(-1) as string).payload;
    expect(listRequest.method).toBe("thread/list");
    fake.serverSend({ type: "rpc", payload: { id: listRequest.id, result: { data: [] } } });

    await waitFor(() => expect(fake.sent).toHaveLength(3));
    const metadataRequest = JSON.parse(fake.sent.at(-1) as string).payload;
    expect(metadataRequest.method).toBe("desktopState/listThreads");
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
    await waitFor(() => expect(fake.sent).toHaveLength(3));
    const listRequest = JSON.parse(fake.sent.at(-1) as string).payload;
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
    await waitFor(() => expect(fake.sent).toHaveLength(4));
    const metadataRequest = JSON.parse(fake.sent.at(-1) as string).payload;
    expect(metadataRequest.method).toBe("desktopState/listThreads");
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
    const listRequest = JSON.parse(fake.sent.at(-1) as string).payload;
    fake.serverSend({
      type: "rpc",
      payload: { id: listRequest.id, result: { data: [{ id: "old-pin" }, { id: "new-pin" }] } },
    });
    await waitFor(() => expect(fake.sent).toHaveLength(2));
    const metadataRequest = JSON.parse(fake.sent.at(-1) as string).payload;
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

    await waitFor(() => expect(fake.sent).toHaveLength(4));
    const refreshedList = JSON.parse(fake.sent.at(-1) as string).payload;
    fake.serverSend({
      type: "rpc",
      payload: { id: refreshedList.id, result: { data: [{ id: "new-pin" }, { id: "old-pin" }] } },
    });
    await waitFor(() => expect(fake.sent).toHaveLength(5));
    const refreshedMetadata = JSON.parse(fake.sent.at(-1) as string).payload;
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
    await waitFor(() => expect(fake.sent).toHaveLength(3));
    const listRequest = JSON.parse(fake.sent.at(-1) as string).payload;
    fake.serverSend({ type: "rpc", payload: { id: listRequest.id, result: { data: [] } } });
    await waitFor(() => expect(fake.sent).toHaveLength(4));
    const metadataRequest = JSON.parse(fake.sent.at(-1) as string).payload;
    expect(metadataRequest.method).toBe("desktopState/listThreads");
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

describe("optimistic steer reconciliation", () => {
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
