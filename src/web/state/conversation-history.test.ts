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

describe("snapshot turn ordering", () => {
  it.each(["current", "incoming"])("does not reorder the %s side when the other snapshot side is empty", (side) => {
    const source = { thread: { id: "t", turns: [
      { id: "first", startedAt: 2, status: "completed", items: [] },
      { id: "second", startedAt: 1, status: "completed", items: [] },
    ] } };
    const empty = { thread: { id: "t", turns: [] } };
    const state = hydrateThread(initialCodexState, side === "current" ? source : empty);
    const next = hydrateThread(state, side === "current" ? empty : source);
    expect(next.threads.t.turnOrder).toEqual(["first", "second"]);
  });

  it("does not order a mixed-source same-second snapshot by false subsecond precision", () => {
    const older = "00000001-8704-7000-8000-000000000001"; // 100100 ms; native seconds may hide a later subsecond.
    const state = hydrateThread(initialCodexState, { thread: { id: "t", turns: [
      { id: "native", startedAt: 100, status: "completed", items: [] },
    ] } });
    const next = hydrateThread(state, { thread: { id: "t", turns: [{ id: older, status: "completed", items: [] }] } });
    expect(next.threads.t.turnOrder).toEqual([older, "native"]);
  });

  it.each([false, true])("orders UUIDv7 turns without task-start metadata, incoming older: %s", (older) => {
    const first = "018f0000-0000-7000-8000-000000000001";
    const last = "018f0001-0000-7000-8000-000000000002";
    const turn = (id: string) => ({ id, status: "completed", items: [{ id, type: "agentMessage", text: id }] });
    const state = hydrateThread(initialCodexState, { thread: { id: "t", turns: [turn(older ? last : first)] } });
    const next = hydrateThread(state, { thread: { id: "t", turns: [turn(older ? first : last)] } });
    expect(next.threads.t.turnOrder).toEqual([first, last]);
  });

  it.each([
    { currentStart: 1, incomingStart: 2, expected: ["current", "incoming"] },
    { currentStart: 2, incomingStart: 1, expected: ["incoming", "current"] },
    { currentStart: undefined, incomingStart: 2, expected: ["incoming", "current"] },
    { currentStart: 1, incomingStart: undefined, expected: ["incoming", "current"] },
    { currentStart: 1, incomingStart: 1, expected: ["incoming", "current"] },
  ])("places an unanchored snapshot using known turn times: $currentStart -> $incomingStart", ({ currentStart, incomingStart, expected }) => {
    const turn = (id: string, startedAt?: number) => ({ id, startedAt, status: "completed", items: [{ id, type: "agentMessage", text: id }] });
    const state = hydrateThread(initialCodexState, { thread: { id: "t", turns: [turn("current", currentStart)] } });
    const next = hydrateThread(state, { thread: { id: "t", turns: [turn("incoming", incomingStart)] } });
    expect(next.threads.t.turnOrder).toEqual(expected);
    expect(Object.keys(next.threads.t.turns)).toHaveLength(2);
  });
});

describe("user identity during history reconciliation", () => {
  it.each(["snapshot", "prepend", "append"] as const)("keeps canonical history identity after old live IDs replay through %s", (placement) => {
    // Real R32 start and steer IDs are unrelated to their response_item IDs.
    const liveIds = ["01a0811a-d125-7b80-827d-c2e3ace32034", "01a0811b-8dc9-7bb0-9f81-096e7a692f47"];
    const diskIds = ["msg_01a0811a-d123-7622-8539-ae36da0d8f2b", "msg_01a0811b-8dc5-7a30-8840-c93d7490cb75"];
    const event = (id: string, method = "item/completed", turnId = "turn") => ({ method, params: {
      threadId: "t", turnId, item: { id, type: "userMessage", text: "继续", imageIds: ["image"] },
    } });
    let state = reduceCodexState(initialCodexState, event(liveIds[0]));
    state = reduceCodexState(state, { method: "item/completed", params: { threadId: "t", turnId: "turn",
      item: { id: "tool", type: "commandExecution", text: "pwd" } } });
    state = reduceCodexState(state, event(liveIds[1]));
    const history = { thread: { id: "t", status: "idle", turns: [{ id: "turn", status: "completed",
      completeFromTurnStart: true, items: [
        user(diskIds[0], ["image"]), { id: "tool", type: "commandExecution", text: "pwd" },
        user(diskIds[1], ["image"]), { id: "final", type: "agentMessage", text: "DONE", phase: "final_answer" },
      ],
    }] } };
    state = hydrateThread(state, history, placement);
    for (const id of [...liveIds].reverse()) {
      state = reduceCodexState(state, event(id, "item/started"));
      state = reduceCodexState(state, event(id));
    }
    state = hydrateThread(state, history, placement);
    expect(state.threads.t.turns.turn.itemOrder).toEqual([diskIds[0], "tool", diskIds[1], "final"]);
    state = reduceCodexState(state, { method: "turn/completed", params: { threadId: "t", turn: {
      id: "turn", status: "completed", items: liveIds.map(id => event(id).params.item),
    } } });
    expect(state.threads.t.turns.turn.itemOrder).toEqual([diskIds[0], "tool", diskIds[1], "final"]);
    expect(state.threads.t.turns.turn.items[diskIds[0]].imageIds).toEqual(["image"]);
    expect(state.threads.t.turns.turn.items.final.text).toBe("DONE");
    expect(state.threads.t.status).toBe("idle");
    // A reused live ID in another turn is a separate submission.
    state = reduceCodexState(state, event(liveIds[0], "item/completed", "second-turn"));
    expect(state.threads.t.turns["second-turn"].itemOrder).toEqual([liveIds[0]]);
    expect(state.threads.t.turns.turn.itemOrder).toHaveLength(4);
  });

  it.each(["snapshot", "prepend", "append"] as const)("retains a learned live alias across an older %s projection", (placement) => {
    const live = { ...user("live"), lifecycle: "confirmed" as const };
    const canonical = { ...user("disk"), lifecycle: "confirmed" as const };
    let state = hydrateThread(stateWith([live]), { thread: { id: "t", turns: [{ id: "turn",
      completeFromTurnStart: true, items: [canonical] }] } });
    state = hydrateThread(state, snapshot(live), placement);
    state = reduceCodexState(state, { method: "item/completed", params: {
      threadId: "t", turnId: "turn", item: live,
    } });
    expect(state.threads.t.turns.turn.itemOrder).toEqual(["disk"]);
  });

  it("repairs a previously duplicated live/history projection when an exact alias arrives", () => {
    const live = { ...user("live", ["image"]), lifecycle: "confirmed" as const };
    const disk = { ...user("disk"), lifecycle: "confirmed" as const };
    const next = hydrateThread(stateWith([disk, live]), snapshot({ ...disk, itemIdAliases: ["live"] }));
    expect(next.threads.t.turns.turn.itemOrder).toEqual(["disk"]);
    expect(next.threads.t.turns.turn.items.disk.imageIds).toEqual(["image"]);
  });

  it("does not consume another same-text pending steer when a learned live alias replays", () => {
    const canonical = { ...user("disk", [], "first"), itemIdAliases: ["live"], lifecycle: "confirmed" as const };
    const next = reduceCodexState(stateWith([canonical, user("web-steer-second", [], "second")]), {
      method: "item/completed", params: { threadId: "t", turnId: "turn", item: {
        id: "live", type: "userMessage", text: "继续",
      } },
    });
    expect(next.threads.t.turns.turn.itemOrder).toEqual(["disk", "web-steer-second"]);
    expect(next.threads.t.turns.turn.items["web-steer-second"].lifecycle).toBe("pending");
  });

  it("does not duplicate a canonical item when one snapshot contains both known representations", () => {
    const canonical = { ...user("disk"), itemIdAliases: ["live"], lifecycle: "confirmed" as const };
    const next = hydrateThread(stateWith([canonical]), { thread: { id: "t", turns: [{ id: "turn", items: [
      canonical, { ...user("live", ["image"]), lifecycle: "confirmed" },
    ] }] } });
    expect(next.threads.t.turns.turn.itemOrder).toEqual(["disk"]);
    expect(next.threads.t.turns.turn.items.disk.imageIds).toEqual(["image"]);
  });

  it("bounds confirmed aliases per item while retaining recent identities", () => {
    let state = stateWith([{ ...user("first", [], "client"), lifecycle: "confirmed" }]);
    for (let i = 0; i < 12; i++) state = hydrateThread(state, snapshot({
      ...user(`representation-${i}`, [], "client"), lifecycle: "confirmed",
    }));
    const item = state.threads.t.turns.turn.items["representation-11"];
    expect(item.itemIdAliases?.length).toBeLessThanOrEqual(8);
    expect(item.itemIdAliases).toContain("representation-10");
    state = reduceCodexState(state, { method: "item/completed", params: { threadId: "t", turnId: "turn",
      item: { id: "representation-10", type: "userMessage", text: "继续" } } });
    expect(state.threads.t.turns.turn.itemOrder).toEqual(["representation-11"]);
  });

  it.each(["snapshot", "prepend", "append"] as const)("keeps a renamed image question before retained reasoning during %s", (placement) => {
    const state = stateWith([
      { ...user("native-user", ["image"]), lifecycle: "confirmed" },
      { id: "reasoning", type: "reasoning", text: "" },
      { id: "final", type: "agentMessage", text: "IMAGE-OK", phase: "final_answer" },
    ]);
    const history = { desktopMirror: true, thread: { id: "t", status: "idle", turns: [
      { id: "turn", status: "completed", completeFromTurnStart: true, items: [
        { ...user("rollout-user", ["image"]), lifecycle: "confirmed" },
        { id: "final", type: "agentMessage", text: "IMAGE-OK", phase: "final_answer" },
      ] },
    ] } };
    const next = hydrateThread(state, history, placement);
    expect(next.threads.t.turns.turn.itemOrder).toEqual(["rollout-user", "reasoning", "final"]);
    expect(next.threads.t.turns.turn.items["native-user"]).toBeUndefined();
    expect(next.threads.t.turns.turn.items["rollout-user"].imageIds).toEqual(["image"]);
    expect(hydrateThread(next, history, placement).threads.t.turns.turn.itemOrder)
      .toEqual(["rollout-user", "reasoning", "final"]);
  });

  it.each(["snapshot", "prepend", "append"] as const)("renames repeated live questions in place around tools and commentary during %s", (placement) => {
    const state = stateWith([
      { id: "earlier", type: "agentMessage", text: "Earlier response" },
      { ...user("native-one", [], "one"), lifecycle: "confirmed" },
      { id: "reasoning-one", type: "reasoning", text: "" },
      { id: "begin", type: "agentMessage", text: "TOOLS-BEGIN", phase: "commentary" },
      { id: "pwd", type: "commandExecution", text: "pwd" },
      { id: "middle", type: "agentMessage", text: "TOOLS-MIDDLE", phase: "commentary" },
      { ...user("native-two", [], "two"), lifecycle: "confirmed" },
      { id: "reasoning-two", type: "reasoning", text: "" },
      { id: "sleep", type: "commandExecution", text: "sleep 1" },
      { id: "final", type: "agentMessage", text: "TOOLS-END", phase: "final_answer" },
    ]);
    const history = { desktopMirror: true, thread: { id: "t", status: "idle", turns: [
      { id: "turn", status: "completed", completeFromTurnStart: true, items: [
        { ...user("rollout-one", [], "one"), lifecycle: "confirmed" },
        { id: "begin", type: "agentMessage", text: "TOOLS-BEGIN", phase: "commentary" },
        { id: "middle", type: "agentMessage", text: "TOOLS-MIDDLE", phase: "commentary" },
        { ...user("rollout-two", [], "two"), lifecycle: "confirmed" },
        { id: "final", type: "agentMessage", text: "TOOLS-END", phase: "final_answer" },
      ] },
    ] } };
    const next = hydrateThread(state, history, placement);
    expect(next.threads.t.turns.turn.itemOrder).toEqual([
      "earlier", "rollout-one", "reasoning-one", "begin", "pwd", "middle", "rollout-two", "reasoning-two", "sleep", "final",
    ]);
    expect(Object.keys(next.threads.t.turns.turn.items)).toHaveLength(10);
    expect(next.threads.t.turns.turn.items.begin.text).toBe("TOOLS-BEGIN");
    expect(next.threads.t.turns.turn.items.middle.text).toBe("TOOLS-MIDDLE");
    expect(next.threads.t.turns.turn.items.final.text).toBe("TOOLS-END");
    expect(hydrateThread(next, history, placement).threads.t.turns.turn.itemOrder).toEqual(next.threads.t.turns.turn.itemOrder);
  });

  it("does not rename an unconfirmed same-text live question from an incomplete snapshot", () => {
    const state = stateWith([{ ...user("native-user"), lifecycle: "confirmed" }]);
    const next = hydrateThread(state, snapshot({ ...user("rollout-user"), lifecycle: "confirmed" }));
    expect(next.threads.t.turns.turn.itemOrder).toEqual(["native-user", "rollout-user"]);
  });

  it("keeps identical questions in other turns when renaming a live question", () => {
    const state = hydrateThread(initialCodexState, { thread: { id: "t", turns: [
      { id: "older", status: "completed", items: [{ id: "older-user", type: "userMessage", text: "继续" }] },
      { id: "turn", status: "completed", items: [
        { id: "native-user", type: "userMessage", text: "继续" },
        { id: "reasoning", type: "reasoning", text: "" },
        { id: "final", type: "agentMessage", text: "Done" },
      ] },
    ] } });
    const next = hydrateThread(state, { desktopMirror: true, thread: { id: "t", turns: [
      { id: "turn", status: "completed", completeFromTurnStart: true, items: [
        { id: "rollout-user", type: "userMessage", text: "继续" },
        { id: "final", type: "agentMessage", text: "Done" },
      ] },
    ] } });
    expect(next.threads.t.turns.older.itemOrder).toEqual(["older-user"]);
    expect(next.threads.t.turns.turn.itemOrder).toEqual(["rollout-user", "reasoning", "final"]);
  });

  it.each(["snapshot", "prepend", "append"] as const)("restores native interrupted over raw completed during %s without losing final text", (placement) => {
    const state = hydrateThread(initialCodexState, { thread: { id: "t", status: "idle", turns: [
      { id: "old", status: "completed", items: [{ id: "final", type: "agentMessage", text: "Retained final" }] },
      { id: "new", status: "completed", items: [{ id: "new-final", type: "agentMessage", text: "Latest final" }] },
    ] } });
    const restored = hydrateThread(state, { thread: { id: "t", status: "idle", turns: [
      { id: "old", status: "interrupted", items: [] },
    ] } }, placement);
    expect(restored.threads.t.turns.old.status).toBe("interrupted");
    expect(restored.threads.t.turns.old.items.final.text).toBe("Retained final");
    expect(restored.threads.t.turns.new.items["new-final"].text).toBe("Latest final");
    expect(restored.threads.t.status).toBe("idle");
  });

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

describe("running turn history", () => {
  it("keeps a local active turn that is newer than an idle Desktop snapshot", () => {
    let state = reduceCodexState(initialCodexState, { method: "turn/completed", params: {
      threadId: "t", turn: { id: "old", status: "completed", items: [] },
    } });
    state = reduceCodexState(state, { method: "turn/started", params: {
      threadId: "t", turn: { id: "new" },
    } });

    const hydrated = hydrateThread(state, { desktopMirror: true, thread: {
      id: "t", status: "idle", turns: [{ id: "old", status: "completed", items: [] }],
    } });

    expect(hydrated.threads.t).toMatchObject({ status: "running", activeTurnId: "new" });
    expect(hydrated.threads.t.turns.new.status).toBe("inProgress");
  });

  it("closes an older local active turn when the idle snapshot has a newer terminal turn", () => {
    let state = reduceCodexState(initialCodexState, { method: "turn/started", params: {
      threadId: "t", turn: { id: "old" },
    } });
    state = reduceCodexState(state, { method: "turn/completed", params: {
      threadId: "t", turn: { id: "new", status: "completed", items: [] },
    } });

    const hydrated = hydrateThread(state, { desktopMirror: true, thread: {
      id: "t", status: "idle", turns: [{ id: "new", status: "completed", items: [] }],
    } });

    expect(hydrated.threads.t).toMatchObject({ status: "idle", activeTurnId: undefined });
    expect(hydrated.threads.t.turns.old.status).toBe("completed");
  });
});
