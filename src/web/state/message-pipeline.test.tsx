import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { initialCodexState, reduceCodexState, type CodexState } from "../../protocol/thread-store";
import { Timeline } from "../components/timeline";
import { ConversationReconciler } from "./use-codex";

function item(state: CodexState, id: string, text: string, type = "agentMessage", method = "item/completed") {
  return reduceCodexState(state, { method, params: { threadId: "t", turnId: "turn", item: { id, type, text } } });
}

function snapshot(items: Array<{ id: string; text: string; type: string }>, status = "inProgress") {
  return { desktopMirror: true, thread: { id: "t", status: status === "completed" ? "idle" : "running", turns: [{ id: "turn", status, items }] } };
}

describe("message pipeline invariants", () => {
  it("keeps raw text newer than the snapshot even when the DOM is further ahead", () => {
    const streamed = reduceCodexState(initialCodexState, { method: "item/agentMessage/delta", params: {
      threadId: "t", turnId: "turn", itemId: "answer", delta: "Hello world",
    } });
    const visible = reduceCodexState(streamed, { method: "desktop/visibleAgentMessage", params: {
      threadId: "t", turnId: "turn", itemId: "answer", text: "Hello world from Desktop",
    } });
    const refreshed = new ConversationReconciler().hydrate(visible, snapshot([
      { id: "answer", type: "agentMessage", text: "Hello" },
    ]));
    expect(refreshed.threads.t.turns.turn.items.answer).toMatchObject({ text: "Hello world", textSource: "stream" });
  });

  it("does not roll back newer raw Markdown when a shorter snapshot follows the DOM fallback", () => {
    const started = reduceCodexState(initialCodexState, { method: "turn/started", params: { threadId: "t", turn: { id: "turn" } } });
    const visible = reduceCodexState(started, { method: "desktop/visibleAgentMessage", params: {
      threadId: "t", turnId: "turn", itemId: "answer", text: "Changed repos:\nrepo state",
    } });
    const markdown = "Changed repos:\n\n| repo | state |\n| --- | --- |\n| xa | done |";
    const streamed = reduceCodexState(visible, { method: "item/agentMessage/delta", params: {
      threadId: "t", turnId: "turn", itemId: "answer", delta: markdown,
    } });
    const refreshed = new ConversationReconciler().hydrate(streamed, snapshot([
      { id: "answer", type: "agentMessage", text: "Changed repos:" },
    ]));
    expect(refreshed.threads.t.turns.turn.items.answer).toMatchObject({ text: markdown, textSource: "stream" });
  });

  it.each(["no delta", "delta after DOM", "delta before DOM"])("replaces a visible fallback with canonical Markdown before the turn finishes (%s)", (order) => {
    let started = reduceCodexState(initialCodexState, { method: "turn/started", params: { threadId: "t", turn: { id: "turn" } } });
    if (order === "delta before DOM") started = reduceCodexState(started, { method: "item/agentMessage/delta", params: {
      threadId: "t", turnId: "turn", itemId: "answer", delta: "Changed repos:",
    } });
    let visible = reduceCodexState(started, { method: "desktop/visibleAgentMessage", params: {
      threadId: "t", turnId: "turn", itemId: "answer", text: "Changed repos:\nrepo state\nxa done",
    } });
    if (order === "delta after DOM") visible = reduceCodexState(visible, { method: "item/agentMessage/delta", params: {
      threadId: "t", turnId: "turn", itemId: "answer", delta: "Changed repos:\n\n",
    } });
    const markdown = "Changed repos:\n\n| repo | state |\n| --- | --- |\n| xa | done |";
    const canonical = new ConversationReconciler().hydrate(visible, snapshot([
      { id: "answer", type: "agentMessage", text: markdown },
    ]));
    expect(canonical.threads.t.turns.turn.items.answer).toMatchObject({ text: markdown, textSource: "snapshot" });
    render(<Timeline thread={canonical.threads.t} />);
    expect(screen.getByRole("table")).toBeVisible();
  });

  it("loads older canonical history at its page position after ignoring an unknown DOM final", () => {
    const reconciler = new ConversationReconciler();
    const current = reconciler.hydrate(initialCodexState, { desktopMirror: true, thread: {
      id: "t", status: "running", turns: [{ id: "current", status: "inProgress", items: [
        { id: "current-answer", type: "agentMessage", text: "Current answer" },
      ] }],
    } });
    const observed = reduceCodexState(current, { method: "desktop/visibleAgentMessage", params: {
      threadId: "t", turnId: "older", itemId: "old-final", text: "Changed repos:\nrepo state\nxa done",
    } });
    expect(observed.threads.t.turnOrder).toEqual(["current"]);
    const loaded = reconciler.hydrate(observed, { desktopMirror: true, thread: {
      id: "t", status: "idle", turns: [{ id: "older", status: "completed", items: [
        { id: "old-question", type: "userMessage", text: "Which repos changed?" },
        { id: "old-final", type: "agentMessage", text: "| repo | state |\n| --- | --- |\n| xa | done |" },
      ] }],
    } }, "prepend");
    expect(loaded.threads.t.turnOrder).toEqual(["older", "current"]);
    expect(loaded.threads.t.turns.older.itemOrder).toEqual(["old-question", "old-final"]);
    expect(loaded.threads.t.activeTurnId).toBe("current");
    render(<Timeline thread={loaded.threads.t} />);
    expect(screen.getByRole("table")).toBeVisible();
    expect(screen.getByText("Current answer")).toBeVisible();
  });

  it("repairs a missed prefix from a completed item while its turn still runs tools", () => {
    const live = reduceCodexState(initialCodexState, { method: "item/agentMessage/delta", params: {
      threadId: "t", turnId: "turn", itemId: "a", delta: "world",
    } });
    const next = new ConversationReconciler().hydrate(live, { desktopMirror: true, thread: {
      id: "t", status: "running", turns: [{ id: "turn", status: "inProgress", items: [
        { id: "a", type: "agentMessage", text: "Hello world", status: "completed" },
        { id: "tool", type: "commandExecution", command: "pwd", status: "running" },
      ] }],
    } });
    expect(next.threads.t.turns.turn.items.a.text).toBe("Hello world");
    expect(next.threads.t.status).toBe("running");
  });
  it("does not reactivate an older turn when its tool event arrives during the next turn", () => {
    let state = reduceCodexState(initialCodexState, { method: "turn/started", params: { threadId: "t", turn: { id: "old" } } });
    state = reduceCodexState(state, { method: "turn/started", params: { threadId: "t", turn: { id: "new" } } });
    state = reduceCodexState(state, { method: "item/started", params: { threadId: "t", turnId: "old", item: {
      id: "late-tool", type: "commandExecution", command: "pwd",
    } } });
    expect(state.threads.t.activeTurnId).toBe("new");
    expect(state.threads.t.turns.old.items["late-tool"]).toBeDefined();
  });
  it.each([["**Hello**"], ["**He", "llo**"], ["**", "H", "e", "l", "l", "o", "**"]])(
    "switches fragmented Desktop plain text to Markdown without concatenating sources: %j", (...chunks) => {
    const started = reduceCodexState(initialCodexState, { method: "turn/started", params: { threadId: "t", turn: { id: "turn" } } });
    let state = reduceCodexState(started, { method: "desktop/visibleAgentMessage", params: {
      threadId: "t", turnId: "turn", itemId: "a", text: "Hello",
    } });
    for (const delta of chunks) state = reduceCodexState(state, { method: "item/agentMessage/delta", params: {
      threadId: "t", turnId: "turn", itemId: "a", delta,
    } });
    expect(state.threads.t.turns.turn.items.a.text).toBe("**Hello**");
    state = reduceCodexState(state, { method: "desktop/visibleAgentMessage", params: {
      threadId: "t", turnId: "turn", itemId: "a", text: "Hello world",
    } });
    state = reduceCodexState(state, { method: "item/agentMessage/delta", params: {
      threadId: "t", turnId: "turn", itemId: "a", delta: " world",
    } });
    expect(state.threads.t.turns.turn.items.a.text).toBe("**Hello** world");
  });
  it("places a recovered complete prefix before live output even without a shared item", () => {
    const live = item(initialCodexState, "a", "实时回复");
    const next = new ConversationReconciler().hydrate(live, { desktopMirror: true, thread: {
      id: "t", status: "running", turns: [{ id: "turn", status: "inProgress", completeFromTurnStart: true,
        items: [{ id: "user", type: "userMessage", text: "用户问题" }],
      }],
    } }, "append");
    expect(next.threads.t.turns.turn.itemOrder).toEqual(["user", "a"]);
  });
  it("does not append replayed chunks to a completed snapshot after reconnect", () => {
    const reconciler = new ConversationReconciler();
    const recovered = reconciler.hydrate(initialCodexState, snapshot([
      { id: "a", type: "agentMessage", text: "hello world" },
    ], "completed"));
    const next = reduceCodexState(recovered, { method: "item/agentMessage/delta", params: {
      threadId: "t", turnId: "turn", itemId: "a", delta: " world",
    } });
    expect(next.threads.t.turns.turn.items.a.text).toBe("hello world");
  });
  it("consumes fragmented deltas already covered by the Desktop observation", () => {
    const started = reduceCodexState(initialCodexState, { method: "turn/started", params: { threadId: "t", turn: { id: "turn" } } });
    let state = reduceCodexState(started, { method: "desktop/visibleAgentMessage", params: {
      threadId: "t", turnId: "turn", itemId: "a", text: "hello world",
    } });
    for (const delta of [" wor", "ld"]) state = reduceCodexState(state, {
      method: "item/agentMessage/delta", params: { threadId: "t", turnId: "turn", itemId: "a", delta },
    });
    expect(state.threads.t.turns.turn.items.a.text).toBe("hello world");
    state = reduceCodexState(state, { method: "desktop/visibleAgentMessage", params: {
      threadId: "t", turnId: "turn", itemId: "a", text: "hello world!",
    } });
    expect(state.threads.t.turns.turn.items.a.text).toBe("hello world!");
  });
  it("restores chronological order when the final event arrived before the middle event", () => {
    const live = item(item(initialCodexState, "last", "最终回复"), "middle", "中间说明");
    const reconciler = new ConversationReconciler();
    const recovered = reconciler.hydrate(live, snapshot([
      { id: "middle", type: "agentMessage", text: "中间说明" },
      { id: "last", type: "agentMessage", text: "最终回复" },
    ], "completed"));
    expect(recovered.threads.t.turns.turn.itemOrder).toEqual(["middle", "last"]);
  });

  it("inserts missing terminal payload items before an already received final item", () => {
    const live = item(initialCodexState, "last", "最终回复");
    const next = reduceCodexState(live, { method: "turn/completed", params: {
      threadId: "t", turn: { id: "turn", status: "completed", items: [
        { id: "middle", type: "agentMessage", text: "中间说明" },
        { id: "last", type: "agentMessage", text: "最终回复" },
      ] },
    } });
    expect(next.threads.t.turns.turn.itemOrder).toEqual(["middle", "last"]);
  });
  it("recovers missed item events from the terminal turn payload", () => {
    const next = reduceCodexState(initialCodexState, { method: "turn/completed", params: {
      threadId: "t", turn: { id: "turn", status: "completed", items: [
        { id: "middle", type: "agentMessage", text: "中间说明" },
        { id: "last", type: "agentMessage", text: "最终回复", phase: "final_answer" },
      ] },
    } });
    expect(next.threads.t.turns.turn.itemOrder).toEqual(["middle", "last"]);
    expect(next.threads.t.turns.turn.items.last.text).toBe("最终回复");
  });
  it("keeps every message and the opened tool group mounted when a multi-tool turn finishes", async () => {
    let state = item(initialCodexState, "user", "用户问题", "userMessage");
    state = item(state, "first", "第一段正文");
    state = item(state, "tool", "执行工具", "commandExecution");
    state = item(state, "steer", "中途追加", "userMessage");
    state = item(state, "middle", "中间正文");
    state = item(state, "last", "最终正文");
    state = reduceCodexState(state, { method: "turn/started", params: { threadId: "t", turn: { id: "turn" } } });
    const { rerender } = render(<Timeline thread={state.threads.t} />);
    const firstNode = screen.getByText("第一段正文");
    await userEvent.click(screen.getByText("执行过程（1 项）"));
    state = reduceCodexState(state, { method: "turn/completed", params: { threadId: "t", turn: { id: "turn" } } });
    rerender(<Timeline thread={state.threads.t} />);
    for (const text of ["用户问题", "第一段正文", "中途追加", "中间正文", "最终正文", "执行工具"]) {
      expect(screen.getByText(text)).toBeVisible();
    }
    expect(screen.getByText("第一段正文")).toBe(firstNode);
  });

  it.each(["AgentMessage", "agent_message", "assistant_message"])("renders %s as text, not a hidden tool", (type) => {
    render(<Timeline thread={item(initialCodexState, "a", "正文必须可见", type).threads.t} />);
    expect(screen.getByText("正文必须可见")).toBeVisible();
    expect(screen.getByText("正文必须可见").closest("details")).toBeNull();
  });

  it.each(["item/started", "desktop/visibleAgentMessage", "item/agentMessage/delta"])("does not let late %s erase or append to completed Markdown", (method) => {
    const done = item(initialCodexState, "a", "# 完整回复\n\n[查看结果](https://example.com/result)");
    const next = reduceCodexState(done, { method, params: {
      threadId: "t", turnId: "turn", itemId: "a", text: "查看结果", delta: "查看结果",
      item: { id: "a", type: "agentMessage", text: "# 完整" },
    } });
    expect(next.threads.t.turns.turn.items.a.text).toBe("# 完整回复\n\n[查看结果](https://example.com/result)");
    expect(next.threads.t.turns.turn.items.a.status).toBe("completed");
  });

  it("merges a partial tail without moving previously loaded messages after the final answer", () => {
    const reconciler = new ConversationReconciler();
    const all = ["user", "first", "tool", "last"].map((id) => ({ id, type: "agentMessage", text: id }));
    const full = reconciler.hydrate(initialCodexState, snapshot(all));
    const tail = reconciler.hydrate(full, snapshot(all.slice(2), "completed"), "append");
    expect(tail.threads.t.turns.turn.itemOrder).toEqual(["user", "first", "tool", "last"]);
    const earlier = reconciler.hydrate(tail, snapshot(all.slice(0, 3)), "prepend");
    expect(earlier.threads.t.turns.turn.itemOrder).toEqual(["user", "first", "tool", "last"]);
  });

  it("fills missed earlier messages at their snapshot anchors", () => {
    const reconciler = new ConversationReconciler();
    const live = item(item(initialCodexState, "tool", "tool", "commandExecution"), "last", "last");
    const result = reconciler.hydrate(live, snapshot(["user", "first", "tool", "last"].map((id) => ({ id, type: "agentMessage", text: id }))));
    expect(result.threads.t.turns.turn.itemOrder).toEqual(["user", "first", "tool", "last"]);
  });

  it("keeps a recovered text prefix when live deltas resume", () => {
    const reconciler = new ConversationReconciler();
    const delta = (state: CodexState, text: string) => reduceCodexState(state, {
      method: "item/agentMessage/delta", params: { threadId: "t", turnId: "turn", itemId: "a", delta: text },
    });
    const live = delta(initialCodexState, "hello");
    const recovered = reconciler.hydrate(live, snapshot([{ id: "a", type: "agentMessage", text: "hello world" }]));
    const next = delta(recovered, "!");
    expect(next.threads.t.turns.turn.items.a.text).toBe("hello world!");
  });

  it("routes a late item without turnId to its known turn, not the new active turn", () => {
    const done = item(initialCodexState, "a", "上一轮最终回复");
    const started = reduceCodexState(done, { method: "turn/started", params: { threadId: "t", turn: { id: "new" } } });
    const next = reduceCodexState(started, { method: "item/started", params: { threadId: "t", item: { id: "a", type: "agentMessage", text: "上一轮" } } });
    expect(next.threads.t.turns.turn.items.a.text).toBe("上一轮最终回复");
    expect(next.threads.t.turns.new.itemOrder).toEqual([]);
    expect(next.threads.t.activeTurnId).toBe("new");
  });
});
