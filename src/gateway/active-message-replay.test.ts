// @vitest-environment node
import { describe, expect, it } from "vitest";
import { ActiveMessageReplay } from "./active-message-replay";

function start(cache: ActiveMessageReplay, itemId = "a", threadId = "t") {
  cache.observe({ method: "item/started", params: {
    threadId, turnId: "turn", item: { id: itemId, type: "agent_message", text: "" },
  } });
}

function delta(cache: ActiveMessageReplay, text: string, itemId = "a", threadId = "t") {
  cache.observe({ method: "item/agentMessage/delta", params: { threadId, turnId: "turn", itemId, delta: text } });
}

describe("active message replay bounds", () => {
  it.each(["turn/completed", "item/completed"])("does not reopen an unseen message after %s arrived first", (method) => {
    const cache = new ActiveMessageReplay();
    cache.observe({ method, params: { threadId: "t", turnId: "turn", turn: { id: "turn" }, item: { id: "a" } } });
    start(cache);
    delta(cache, "late body");
    expect(cache.snapshots()).toEqual([]);
  });

  it("resolves a known item's missing turn ID when closing its stream", () => {
    const cache = new ActiveMessageReplay();
    start(cache);
    delta(cache, "finished");
    cache.observe({ method: "item/completed", params: { threadId: "t", item: { id: "a", text: "finished" } } });
    delta(cache, "late");
    expect(cache.snapshots()).toEqual([]);
  });

  it("preserves identical raw chunks and does not reset them on a late start", () => {
    const cache = new ActiveMessageReplay();
    start(cache);
    delta(cache, "repeated chunk");
    start(cache);
    delta(cache, "repeated chunk");
    expect(cache.snapshots()).toMatchObject([{ params: { text: "repeated chunkrepeated chunk" } }]);
  });

  it("does not replay completed messages or reopen them on late events", () => {
    const cache = new ActiveMessageReplay();
    start(cache);
    delta(cache, "finished");
    cache.observe({ method: "item/completed", params: {
      threadId: "t", turnId: "turn", item: { id: "a", type: "agentMessage", text: "finished" },
    } });
    start(cache);
    delta(cache, "late fragment");
    expect(cache.snapshots()).toEqual([]);
  });

  it("clears only the completed turn and keeps another thread's active body", () => {
    const cache = new ActiveMessageReplay();
    start(cache);
    delta(cache, "finished");
    start(cache, "b", "other");
    delta(cache, "still running", "b", "other");
    cache.observe({ method: "turn/completed", params: { threadId: "t", turn: { id: "turn" } } });
    delta(cache, "late");
    expect(cache.snapshots()).toMatchObject([{ params: { threadId: "other", text: "still running" } }]);
  });

  it("does not present fragments from unseen or evicted starts as full messages", () => {
    const cache = new ActiveMessageReplay();
    delta(cache, "unseen");
    expect(cache.snapshots()).toEqual([]);
    for (let index = 0; index < 65; index += 1) {
      start(cache, String(index));
      delta(cache, "body", String(index));
    }
    delta(cache, "late fragment", "0");
    expect(cache.snapshots()).toHaveLength(64);
    expect(cache.snapshots()).not.toContainEqual(expect.objectContaining({
      params: expect.objectContaining({ itemId: "0" }),
    }));
  });

  it("bounds total replay text without retaining a truncated suffix of an oversized item", () => {
    const cache = new ActiveMessageReplay();
    start(cache);
    delta(cache, "a".repeat(200_000));
    start(cache, "b");
    delta(cache, "b".repeat(200_000), "b");
    expect(cache.snapshots()).toHaveLength(1);
    expect(cache.snapshots()).toMatchObject([{ params: { itemId: "b", text: "b".repeat(200_000) } }]);
    delta(cache, "b".repeat(100_000), "b");
    delta(cache, "suffix", "b");
    expect(cache.snapshots()).toEqual([]);
  });
});
