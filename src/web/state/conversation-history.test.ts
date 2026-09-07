import { describe, expect, it } from "vitest";
import { initialCodexState, reduceCodexState, type CodexItem, type CodexState } from "../../protocol/thread-store";
import { hydrateThread } from "./conversation-history";

function user(id: string, imageIds: string[] = [], clientMessageId?: string): CodexItem {
  return { id, type: "userMessage", text: "继续", imageIds, clientMessageId, lifecycle: "pending" };
}

function stateWith(items: CodexItem[]): CodexState {
  return { stale: false, threadOrder: ["t"], threads: {
    t: { id: "t", title: "Task", status: "running", turnOrder: ["turn"], turns: {
      turn: { id: "turn", status: "inProgress", itemOrder: items.map((item) => item.id),
        items: Object.fromEntries(items.map((item) => [item.id, item])) },
    } },
  } };
}

function snapshot(item: CodexItem) {
  return { desktopMirror: true, thread: { id: "t", status: "active", turns: [
    { id: "turn", status: "inProgress", items: [item] },
  ] } };
}

describe("user identity during history reconciliation", () => {
  it("does not confirm a pending send with another client's same-text message", () => {
    const pending = user("pending", [], "client-local");
    const next = hydrateThread(stateWith([pending]), snapshot(user("server", [], "client-other")));
    expect(next.threads.t.turns.turn.items.pending).toMatchObject({ lifecycle: "pending", clientMessageId: "client-local" });
    expect(next.threads.t.turns.turn.items.server.clientMessageId).toBe("client-other");
  });

  it("does not guess which identical pending send an anonymous snapshot confirms", () => {
    const next = hydrateThread(stateWith([user("pending-a"), user("pending-b")]), snapshot(user("server")));
    expect(next.threads.t.turns.turn.itemOrder).toEqual(["pending-a", "pending-b", "server"]);
    expect(next.threads.t.turns.turn.items["pending-a"].lifecycle).toBe("pending");
    expect(next.threads.t.turns.turn.items["pending-b"].lifecycle).toBe("pending");
  });

  it("confirms only the matching client when repeated sends have stable identities", () => {
    const next = hydrateThread(stateWith([user("pending-a", [], "a"), user("pending-b", [], "b")]), snapshot(user("server", [], "b")));
    expect(next.threads.t.turns.turn.items["pending-a"].lifecycle).toBe("pending");
    expect(next.threads.t.turns.turn.items["pending-b"]).toBeUndefined();
    expect(next.threads.t.turns.turn.items.server.clientMessageId).toBe("b");
  });

  it("uses known image identity to confirm the second pending picture first", () => {
    const next = hydrateThread(stateWith([user("pending-a", ["image-a"]), user("pending-b", ["image-b"])]), snapshot(user("server", ["image-b"])));
    expect(next.threads.t.turns.turn.items["pending-a"].imageIds).toEqual(["image-a"]);
    expect(next.threads.t.turns.turn.items["pending-b"]).toBeUndefined();
    expect(next.threads.t.turns.turn.items.server.imageIds).toEqual(["image-b"]);
  });
});

describe("failed turn history", () => {
  it.each([true, false])("keeps a newer successful turn idle when an older failure snapshot arrives (close retained: %s)", (closeRetainedTurns) => {
    let state = initialCodexState;
    for (const id of ["older", "newer"]) state = reduceCodexState(state, { method: "turn/completed", params: {
      threadId: "t", turn: { id, status: "completed", items: [] },
    } });
    const hydrated = hydrateThread(state, { desktopMirror: true, thread: { id: "t", status: "error", turns: [
      { id: "older", status: "failed", error: { message: "Old failure" }, items: [] },
    ] } }, "append", closeRetainedTurns);
    expect(hydrated.threads.t.status).toBe("idle");
    expect(hydrated.threads.t.turns.older).toMatchObject({ status: "failed", error: { message: "Old failure" } });
  });

  const failedSnapshot = { desktopMirror: true, thread: { id: "t", status: { type: "systemError" }, turns: [
    { id: "turn", status: "failed", error: { message: '{"detail":"Bad Request"}', additionalDetails: null }, items: [
      { id: "question", type: "userMessage", text: "Reply CHECK-OK. No tools." },
    ] },
  ] } };

  it("restores a real Desktop failure and its error into a fresh client", () => {
    const hydrated = hydrateThread(initialCodexState, failedSnapshot);
    expect(hydrated.threads.t).toMatchObject({ status: "error", activeTurnId: undefined });
    expect(hydrated.threads.t.turns.turn).toMatchObject({
      status: "failed", error: { message: '{"detail":"Bad Request"}', additionalDetails: null },
    });
  });

  it("corrects a completed mirror with a failure and keeps the error through stale refreshes", () => {
    const completed = reduceCodexState(initialCodexState, { method: "turn/completed", params: {
      threadId: "t", turn: { id: "turn", status: "completed", items: [{ id: "answer", type: "agentMessage", text: "Partial answer" }] },
    } });
    const hydrated = hydrateThread(completed, failedSnapshot);
    const stale = hydrateThread(hydrated, { desktopMirror: true, thread: { id: "t", status: "idle", turns: [
      { id: "turn", status: "completed", items: [] },
    ] } });
    expect(stale.threads.t.status).toBe("error");
    expect(stale.threads.t.turns.turn).toMatchObject({ status: "failed", error: { message: '{"detail":"Bad Request"}' } });
    expect(stale.threads.t.turns.turn.items.answer.text).toBe("Partial answer");
  });
});
