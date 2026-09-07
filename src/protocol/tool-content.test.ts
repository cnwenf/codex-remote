import { describe, expect, it } from "vitest";
import { initialCodexState, reduceCodexState } from "./thread-store";
import { hydrateThread } from "../web/state/conversation-history";

function event(state: typeof initialCodexState, method: string, item: Record<string, unknown>) {
  return reduceCodexState(state, { method, params: { threadId: "t", turnId: "turn", item } });
}

describe("tool details", () => {
  it("restores newly available image metadata on a retained completed result without losing text", () => {
    const item = { id: "c", type: "toolCall", toolInput: "view_image", toolOutput: "Screenshot\n[非文本结果]", status: "completed" };
    let state = hydrateThread(initialCodexState, { thread: { id: "t", turns: [{ id: "turn", status: "completed", items: [item] }] } });
    state = hydrateThread(state, { thread: { id: "t", turns: [{ id: "turn", status: "completed", items: [
      { ...item, toolOutputImageIds: ["00000000-0000-4000-8000-000000000001"] },
    ] }] } });
    expect(state.threads.t.turns.turn.items.c.toolOutputImageIds).toEqual(["00000000-0000-4000-8000-000000000001"]);
  });

  it("keeps pending image results with their unique call and retracts them when a second QA is ambiguous", () => {
    const images = ["00000000-0000-4000-8000-000000000001"];
    let state = hydrateThread(initialCodexState, { thread: { id: "t", turns: [], pendingToolOutputs: [{ id: "c", toolOutput: "Screenshot", toolOutputImageIds: images }] } });
    state = hydrateThread(state, { thread: { id: "t", turns: [{ id: "turn", items: [{ id: "c", type: "toolCall", toolInput: "view_image" }] }] } }, "prepend");
    expect(state.threads.t.turns.turn.items.c.toolOutputImageIds).toEqual(images);
    state = hydrateThread(state, { thread: { id: "t", turns: [{ id: "older", items: [{ id: "c", type: "toolCall", toolInput: "different call" }] }] } }, "prepend");
    expect(state.threads.t.turns.turn.items.c.toolOutputImageIds).toBeUndefined();
    expect(state.threads.t.turns.older.items.c.toolOutputImageIds).toBeUndefined();
    expect(state.threads.t.pendingToolOutputs?.[0].toolOutputImageIds).toEqual(images);
  });

  it("does not promote a guessed picture into a later raw tool stream", () => {
    const images = ["00000000-0000-4000-8000-000000000001"];
    let state = hydrateThread(initialCodexState, { thread: { id: "t", pendingToolOutputs: [{ id: "c", toolOutput: "Screenshot", toolOutputImageIds: images }],
      turns: [{ id: "turn", items: [{ id: "c", type: "toolCall", toolInput: "call" }] }],
    } });
    state = reduceCodexState(state, { method: "item/commandExecution/outputDelta", params: { threadId: "t", turnId: "turn", itemId: "c", delta: "Raw output" } });
    expect(state.threads.t.turns.turn.items.c.toolOutputImageIds).toBeUndefined();
    expect(state.threads.t.pendingToolOutputs?.[0].toolOutputImageIds).toEqual(images);
    state = hydrateThread(state, { thread: { id: "t", turns: [] } });
    expect(state.threads.t.pendingToolOutputs?.[0].toolOutputImageIds).toEqual(images);
  });

  it("recovers pending output only for a unique call in the same thread and retracts ambiguous guesses", () => {
    let state = hydrateThread(initialCodexState, { thread: { id: "t", turns: [], pendingToolOutputs: [{ id: "c", toolOutput: "new result" }] } });
    state = hydrateThread(state, { thread: { id: "other", turns: [{ id: "other-turn", items: [{ id: "c", type: "toolCall", toolInput: "other" }] }] } }, "prepend");
    expect(state.threads.other.turns["other-turn"].items.c.toolOutput).toBeUndefined();
    state = hydrateThread(state, { thread: { id: "t", pendingToolOutputs: [{ id: "c", toolOutput: "older result" }], turns: [{ id: "old", items: [{ id: "c", type: "toolCall", toolInput: "call" }] }] } }, "prepend");
    expect(state.threads.t.turns.old.items.c.toolOutput).toBe("new result");
    expect(state.threads.t.toolOutputWarning).toBeUndefined();
    state = hydrateThread(state, { thread: { id: "t", turns: [{ id: "older", items: [{ id: "c", type: "toolCall", toolInput: "another call" }] }] } }, "prepend");
    expect(state.threads.t.turns.old.items.c.toolOutput).toBeUndefined();
    expect(state.threads.t.turns.older.items.c.toolOutput).toBeUndefined();
    expect(state.threads.t.toolOutputWarning).toContain("工具结果");
  });

  it("bounds pending results without hiding newer final and reports overflow", () => {
    const state = hydrateThread(initialCodexState, { thread: { id: "t", pendingToolOutputs: Array.from({ length: 65 }, (_, i) => ({ id: String(i), toolOutput: "x".repeat(20_000) })), turns: [{ id: "new", items: [{ id: "final", type: "agentMessage", text: "answer", phase: "final_answer" }] }] } });
    expect(state.threads.t.pendingToolOutputs).toHaveLength(64);
    expect(state.threads.t.pendingToolOutputs?.every((output) => output.toolOutput?.length === 16_384)).toBe(true);
    expect(state.threads.t.toolOutputWarning).toContain("上限");
    expect(state.threads.t.turns.new.items.final.text).toBe("answer");
  });

  it.each([false, true])("does not replace authoritative live output with a previously pending result on refresh (delta: %s)", (delta) => {
    let state = hydrateThread(initialCodexState, { thread: { id: "t", pendingToolOutputs: [{ id: "c", toolOutput: "pending result" }], turns: [{ id: "turn", items: [{ id: "c", type: "toolCall", toolInput: "call" }] }] } });
    state = delta ? reduceCodexState(state, { method: "item/commandExecution/outputDelta", params: { threadId: "t", turnId: "turn", itemId: "c", delta: " + live" } })
      : event(state, "item/completed", { id: "c", type: "toolCall", input: "call", output: "live result" });
    state = hydrateThread(state, { thread: { id: "t", turns: [] } });
    expect(state.threads.t.turns.turn.items.c.toolOutput).toBe(delta ? " + live" : "live result");
    if (delta) {
      state = reduceCodexState(state, { method: "item/commandExecution/outputDelta", params: { threadId: "t", turnId: "turn", itemId: "c", delta: " next" } });
      state = hydrateThread(state, { thread: { id: "t", turns: [{ id: "older", items: [{ id: "c", type: "toolCall", toolInput: "older call" }] }] } }, "prepend");
      expect(state.threads.t.turns.turn.items.c.toolOutput).toBe(" + live next");
      expect(state.threads.t.turns.older.items.c.toolOutput).toBeUndefined();
      expect(state.threads.t.pendingToolOutputs).toEqual([expect.objectContaining({ id: "c", toolOutput: "pending result" })]);
      expect(state.threads.t.toolOutputWarning).toContain("工具结果");
    }
  });

  it("keeps command input separate from bounded live output and adopts completed output", () => {
    let state = event(initialCodexState, "item/started", { id: "c", type: "commandExecution", command: "pnpm test" });
    for (const delta of ["a".repeat(16000), "b".repeat(1000)]) {
      state = reduceCodexState(state, { method: "item/commandExecution/outputDelta", params: {
        threadId: "t", turnId: "turn", itemId: "c", delta,
      } });
    }
    expect(state.threads.t.turns.turn.items.c).toMatchObject({
      toolInput: "pnpm test", toolOutput: "a".repeat(16000) + "b".repeat(384),
      toolOutputTruncated: true, toolOutputLength: 17000,
    });
    state = event(state, "item/completed", { id: "c", type: "commandExecution", command: "pnpm test", aggregatedOutput: "All tests passed", exitCode: 0 });
    expect(state.threads.t.turns.turn.items.c).toMatchObject({ toolOutput: "All tests passed", toolOutputTruncated: false });
  });

  it.each([
    { type: "mcpToolCall", tool: "search", arguments: { query: "test" }, result: { content: [{ type: "text", text: "Found match" }, { type: "image", data: "SECRET_BASE64" }] } },
    { type: "dynamicToolCall", tool: "search", arguments: { query: "test" }, content: [{ type: "inputText", text: "Found match" }] },
    { type: "function_call", name: "search", arguments: '{"query":"test"}', output: "Found match" },
  ])("loads $type input/results on live completion and refresh without binary data", (item) => {
    const raw = { id: "tool", ...item };
    const live = event(initialCodexState, "item/completed", raw);
    const restored = hydrateThread(initialCodexState, { thread: { id: "t", turns: [{ id: "turn", status: "completed", items: [raw] }] } });
    for (const state of [live, restored]) {
      const tool = state.threads.t.turns.turn.items.tool;
      expect(tool).toMatchObject({ toolInput: expect.stringContaining("query"), toolOutput: expect.stringContaining("Found match") });
      expect(JSON.stringify(tool)).not.toContain("SECRET_BASE64");
    }
  });

  it("retains structured result and real tool errors; bounds input too", () => {
    const state = event(initialCodexState, "item/completed", {
      id: "m", type: "mcpToolCall", arguments: "x".repeat(20000),
      result: { structuredContent: { count: 3 } }, error: { message: "partial failure" },
    });
    expect(state.threads.t.turns.turn.items.m).toMatchObject({
      toolInput: "x".repeat(16384), toolInputTruncated: true, toolInputLength: 20000,
      toolOutput: expect.stringContaining('"count": 3'),
    });
    expect(state.threads.t.turns.turn.items.m.toolOutput).toContain("partial failure");
  });

  it("preserves upstream truncation metadata and clearly marks a non-text-only result", () => {
    const truncated = event(initialCodexState, "item/completed", {
      id: "c", type: "function_call", input: "test", output: "retained prefix", outputTruncated: true, outputLength: 90000,
    });
    expect(truncated.threads.t.turns.turn.items.c).toMatchObject({ toolOutputTruncated: true, toolOutputLength: 90000 });
    const binary = event(initialCodexState, "item/completed", {
      id: "b", type: "mcpToolCall", result: { content: [{ type: "image", data: "SECRET_BASE64" }] },
    });
    expect(binary.threads.t.turns.turn.items.b.toolOutput).toBe("[非文本结果]");
  });

  it("does not lose streamed output when completion contains no aggregate", () => {
    let state = reduceCodexState(initialCodexState, { method: "item/commandExecution/outputDelta", params: {
      threadId: "t", turnId: "turn", itemId: "c", delta: "result",
    } });
    state = event(state, "item/completed", { id: "c", type: "commandExecution", command: "pwd" });
    expect(state.threads.t.turns.turn.items.c).toMatchObject({ toolInput: "pwd", toolOutput: "result" });
  });

  it("restores completed output over retained progress but does not regress completed output on stale refresh", () => {
    const started = event(initialCodexState, "item/started", { id: "c", type: "commandExecution", command: "pwd", aggregatedOutput: "par" });
    const restored = hydrateThread(started, { thread: { id: "t", turns: [{ id: "turn", status: "completed", items: [
      { id: "c", type: "commandExecution", command: "pwd", aggregatedOutput: "canonical result", status: "completed" },
    ] }] } });
    expect(restored.threads.t.turns.turn.items.c.toolOutput).toBe("canonical result");
    const stale = hydrateThread(restored, { thread: { id: "t", turns: [{ id: "turn", status: "inProgress", items: [
      { id: "c", type: "commandExecution", command: "pwd", aggregatedOutput: "par" },
    ] }] } });
    expect(stale.threads.t.turns.turn.items.c.toolOutput).toBe("canonical result");
  });
});
