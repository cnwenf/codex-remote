import { describe, expect, it } from "vitest";
import { initialCodexState, reduceCodexState } from "./thread-store";
import { hydrateThread } from "../web/state/conversation-history";
import { delegatedInputFromProtocol } from "./delegated-input";

const sourceThreadId = "00000000-0000-4000-8000-000000000001";
const prompt = "No tools. Reply these literal lines:\n![test](/tmp/test.png)\nEND";
const output = `<codex_delegation>\n  <source_thread_id>${sourceThreadId}</source_thread_id>\n  <input>${prompt}</input>\n</codex_delegation>`;
const delegated = { id: "fco-delegated", type: "FunctionCallOutput", name: "send_message_to_thread", namespace: "codex_app", output };

describe("delegated task input", () => {
  it("rejects missing input identity", () => {
    expect(delegatedInputFromProtocol({ ...delegated, id: "" })).toBeUndefined();
  });
  it("keeps live delegated input separate from human input without guessing a late input's position", () => {
    let state = reduceCodexState(initialCodexState, { method: "item/started", params: { threadId: "t", turnId: "turn", item: {
      id: "web-steer-pending", type: "userMessage", text: prompt,
    } } });
    state = reduceCodexState(state, { method: "item/completed", params: { threadId: "t", turnId: "turn", item: {
      id: "final", type: "agentMessage", text: "Final", phase: "final_answer",
    } } });
    for (const type of ["FunctionCallOutput", "function_call_output"]) {
      state = reduceCodexState(state, { method: "item/completed", params: { threadId: "t", turnId: "turn", item: { ...delegated, type } } });
    }
    const turn = state.threads.t.turns.turn;
    expect(turn.items[delegated.id]).toMatchObject({ type: "delegatedInput", text: prompt, sourceThreadId });
    expect(turn.items["web-steer-pending"].text).toBe(prompt);
    expect(turn.itemOrder.filter((id) => id === delegated.id)).toHaveLength(1);
    expect(turn.itemOrder.indexOf(delegated.id)).toBeGreaterThan(turn.itemOrder.indexOf("final"));
  });

  it("hydrates distinct same-text delegations without deduping them and preserves source on refresh", () => {
    let state = hydrateThread(initialCodexState, { thread: { id: "t", turns: [{ id: "turn", status: "completed", items: [
      { id: "final", type: "agentMessage", text: "Final" },
    ] }] } });
    state = hydrateThread(state, { thread: { id: "t", turns: [{ id: "turn", status: "completed", items: [delegated, { ...delegated, id: "second" }] }] } }, "append");
    const turn = state.threads.t.turns.turn;
    expect(turn.itemOrder).toEqual(["final", delegated.id, "second"]);
    expect(turn.items.second).toMatchObject({ type: "delegatedInput", text: prompt, sourceThreadId });
    state = hydrateThread(state, { thread: { id: "t", turns: [{ id: "turn", items: [{ id: delegated.id, type: "delegatedInput", text: prompt }] }] } });
    expect(state.threads.t.turns.turn.items[delegated.id].sourceThreadId).toBe(sourceThreadId);
  });

  it("preserves canonical mid-turn steering order", () => {
    const state = reduceCodexState(initialCodexState, { method: "turn/completed", params: { threadId: "t", turn: {
      id: "turn", status: "completed", items: [delegated, { id: "a1", type: "agentMessage", text: "First" }, { ...delegated, id: "d2" }, { id: "a2", type: "agentMessage", text: "Second" }],
    } } });
    expect(state.threads.t.turns.turn.itemOrder).toEqual([delegated.id, "a1", "d2", "a2"]);
  });

  it("repairs an echo-only newer page using the original input's older-page position", () => {
    let state = hydrateThread(initialCodexState, { thread: { id: "t", turns: [{ id: "turn", items: [
      { id: "a2", type: "agentMessage", text: "Second" },
      { id: "d2", type: "delegatedInput", text: prompt, delegatedInputIsReplay: true },
    ] }] } });
    state = hydrateThread(state, { thread: { id: "t", turns: [{ id: "turn", items: [
      delegated, { id: "a1", type: "agentMessage", text: "First" },
      { ...delegated, id: "d2", type: "function_call_output" },
    ] }] } }, "prepend");
    expect(state.threads.t.turns.turn.itemOrder).toEqual([delegated.id, "a1", "d2", "a2"]);
    state = reduceCodexState(state, { method: "item/completed", params: { threadId: "t", turnId: "turn", item: { ...delegated, id: "d2" } } });
    expect(state.threads.t.turns.turn.items.d2.delegatedInputIsReplay).toBe(false);
    expect(state.threads.t.turns.turn.itemOrder).toEqual([delegated.id, "a1", "d2", "a2"]);
    state = hydrateThread(state, { thread: { id: "t", turns: [{ id: "turn", items: [{ ...delegated, id: "d2" }] }] } }, "append");
    expect(state.threads.t.turns.turn.items.d2.delegatedInputIsReplay).toBe(false);
  });

  it.each([
    { ...delegated, namespace: "other" },
    { ...delegated, name: "other" },
    { ...delegated, call_id: "actual-tool-call" },
    { ...delegated, callId: "actual-live-tool-call" },
    { ...delegated, type: "userMessage", text: output },
    { ...delegated, output: "```xml\n" + output + "\n```" },
    { ...delegated, output: output.replace("</codex_delegation>", "") },
  ])("does not misclassify ordinary or malformed content %#", (item) => {
    const state = reduceCodexState(initialCodexState, { method: "item/completed", params: { threadId: "t", turnId: "turn", item } });
    expect(state.threads.t.turns.turn.items[item.id].type).not.toBe("delegatedInput");
  });
});
