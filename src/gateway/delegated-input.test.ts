// @vitest-environment node
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { DesktopState } from "./desktop-state";
import { initialCodexState } from "../protocol/thread-store";
import { hydrateThread } from "../web/state/conversation-history";

describe("Desktop delegated input history", () => {
  it.each(["response_item", "item_completed"])("preserves ordinary latest partial running recovery from %s", (kind) => {
    const desktop = historyFixture([kind === "response_item"
      ? { type: "response_item", payload: { type: "message", id: "a", role: "assistant", content: [{ type: "output_text", text: "Working" }], internal_chat_message_metadata_passthrough: { turn_id: "latest" } } }
      : { type: "event_msg", payload: { type: "item_completed", turn_id: "latest", item: { id: "a", type: "AgentMessage", text: "Working" } } },
    ]);
    try {
      const state = hydrateThread(initialCodexState, desktop.request("desktopState/readThread", { threadId: "t" }));
      expect(state.threads.t.turnOrder).toEqual(["latest"]);
      expect(state.threads.t.turns.latest.status).toBe("inProgress");
      expect(state.threads.t.activeTurnId).toBe("latest");
    } finally { desktop.close(); }
  });

  it.each(["delegated", "AgentMessage", "UserMessage", "raw-delegated", "raw-agent", "raw-user"])("keeps unknown old %s fragments non-active without blocking the readable latest page", (kind) => {
    const input = { id: "d", type: "function_call_output", name: "send_message_to_thread", namespace: "codex_app", output: '<codex_delegation><source_thread_id>00000000-0000-4000-8000-000000000001</source_thread_id><input>Old input</input></codex_delegation>' };
    const oldItem = kind === "raw-delegated" ? input : { type: "message", id: "old-item", role: kind === "raw-user" ? "user" : "assistant", content: [{ type: "input_text", text: "Old content" }] };
    const desktop = historyFixture([
      // This unreadable older message must not prevent returning the newer QA.
      { type: "response_item", payload: { type: "message", role: "assistant", content: [{ type: "output_text", text: "x".repeat(3 * 1024 * 1024) }] } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "new" } },
      { type: "response_item", payload: { type: "message", id: "user", role: "user", content: [{ type: "input_text", text: "New input" }] } },
      kind.startsWith("raw-")
        ? { type: "response_item", payload: { ...oldItem, internal_chat_message_metadata_passthrough: { turn_id: "old" } } }
        : { type: "event_msg", payload: { type: "item_completed", turn_id: "old", item: kind === "delegated" ? { ...input, type: "FunctionCallOutput" } : { id: "old-item", type: kind, text: "Old content" } } },
      { type: "response_item", payload: { type: "message", id: "new-final", role: "assistant", content: [{ type: "output_text", text: "New final" }] } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "new" } },
    ]);
    try {
      const page = desktop.request("desktopState/readThread", { threadId: "t", history: { limitTurns: 1, maxBytes: 64 * 1024 } }) as any;
      expect(page.history.hasMoreBefore).toBe(true);
      const state = hydrateThread(initialCodexState, page);
      const thread = state.threads.t;
      expect(thread.turns.new.items["new-final"]?.text).toBe("New final");
      expect(thread.status).toBe("idle");
      expect(thread.activeTurnId).toBeUndefined();
      expect(thread.turnOrder.at(-1)).toBe("new");
      // UserMessage event fallback remains unsupported; it must not invent a turn.
      if (kind !== "UserMessage") {
        expect(thread.turnOrder).toEqual(["old", "new"]);
        expect(thread.turns.old.status).toBe("unknown");
        expect(page.thread.turns.find((turn: any) => turn.id === "old").completeFromTurnStart).toBe(false);
      }
    } finally { desktop.close(); }
  });

  it.each(["delegated", "AgentMessage", "UserMessage", "response_item"])("does not let late old %s completion capture the new anonymous final", (kind) => {
    const input = { id: "d", type: "function_call_output", name: "send_message_to_thread", namespace: "codex_app", output: '<codex_delegation><source_thread_id>00000000-0000-4000-8000-000000000001</source_thread_id><input>Old input</input></codex_delegation>' };
    const desktop = historyFixture([
      { type: "event_msg", payload: { type: "task_started", turn_id: "old" } },
      { type: "response_item", payload: input },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "old" } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "new" } },
      { type: "response_item", payload: { type: "message", id: "user", role: "user", content: [{ type: "input_text", text: "New input" }] } },
      kind === "response_item"
        ? { type: "response_item", payload: { ...input, internal_chat_message_metadata_passthrough: { turn_id: "old" } } }
        : { type: "event_msg", payload: { type: "item_completed", turn_id: "old", item: kind === "delegated" ? { ...input, type: "FunctionCallOutput" } : { id: "old-item", type: kind, text: "Old content" } } },
      { type: "response_item", payload: { type: "message", id: "new-final", role: "assistant", content: [{ type: "output_text", text: "New final" }] } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "new" } },
    ]);
    try {
      const state = hydrateThread(initialCodexState, desktop.request("desktopState/readThread", { threadId: "t", history: { limitTurns: 8 } }));
      expect(state.threads.t.turns.new.items["new-final"]?.text).toBe("New final");
      expect(state.threads.t.turns.old.items["new-final"]).toBeUndefined();
    } finally { desktop.close(); }
  });

  it("repairs the actual echo-only latest page when older cursor pages contain canonical steering", () => {
    const input = { id: "d2", type: "function_call_output", name: "send_message_to_thread", namespace: "codex_app", output: '<codex_delegation><source_thread_id>00000000-0000-4000-8000-000000000001</source_thread_id><input>Steer</input></codex_delegation>' };
    const desktop = historyFixture([
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn" } },
      { type: "response_item", payload: { ...input, id: "d1" } },
      { type: "response_item", payload: { type: "message", id: "a1", role: "assistant", content: [{ type: "output_text", text: "First" }] } },
      { type: "response_item", payload: input },
      { type: "event_msg", payload: { type: "agent_reasoning", text: "padding".repeat(4000) } },
      { type: "response_item", payload: { type: "message", id: "a2", role: "assistant", content: [{ type: "output_text", text: "Second".repeat(10000) }] } },
      { type: "event_msg", payload: { type: "item_completed", turn_id: "turn", item: { ...input, type: "FunctionCallOutput" } } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "turn" } },
    ]);
    try {
      let page = desktop.request("desktopState/readThread", { threadId: "t", history: { maxBytes: 64 * 1024 } }) as any;
      let state = hydrateThread(initialCodexState, page);
      expect(state.threads.t.turns.turn.itemOrder).toEqual(["a2", "d2"]);
      expect(page.history.hasMoreBefore).toBe(true);
      for (let count = 0; page.history.hasMoreBefore && count < 4; count++) {
        page = desktop.request("desktopState/readThread", { threadId: "t", history: { maxBytes: 64 * 1024, beforeCursor: page.history.beforeCursor } });
        state = hydrateThread(state, page, "prepend");
      }
      expect(page.history.hasMoreBefore).toBe(false);
      expect(state.threads.t.turns.turn.itemOrder).toEqual(["d1", "a1", "d2", "a2"]);
      expect(state.threads.t.turns.turn.items.d2.delegatedInputIsReplay).toBe(false);
    } finally { desktop.close(); }
  });

  it("rejects oversized delegated XML explicitly instead of silently truncating away the input", () => {
    const desktop = historyFixture([
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn" } },
      { type: "response_item", payload: { id: "d", type: "function_call_output", name: "send_message_to_thread", namespace: "codex_app", output: '<codex_delegation><source_thread_id>00000000-0000-4000-8000-000000000001</source_thread_id><input>' + "x".repeat(3 * 1024 * 1024) + '</input></codex_delegation>' } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "turn" } },
    ]);
    try {
      expect(() => desktop.request("desktopState/readThread", { threadId: "t", history: { limitTurns: 1 } })).toThrow(/cursor was not advanced/);
    } finally { desktop.close(); }
  });

  it.each(["response_item", "item_completed", "both"])("recovers %s without a call_id as one attributed input before its final", (mode) => {
    const dir = mkdtempSync(join(tmpdir(), "delegated-history-"));
    mkdirSync(join(dir, "sessions"));
    const rollout = join(dir, "sessions", "rollout.jsonl");
    const sourceThreadId = "00000000-0000-4000-8000-000000000001";
    const prompt = "不要调用工具。请回复原始 Markdown：\n![本机测试图标](/tmp/app-icon.png)";
    const delegated = { id: "fco-input", name: "send_message_to_thread", namespace: "codex_app",
      output: `<codex_delegation>\n  <source_thread_id>${sourceThreadId}</source_thread_id>\n  <input>${prompt}</input>\n</codex_delegation>`,
    };
    writeFileSync(rollout, [
      { type: "turn_context", payload: { turn_id: "turn" } },
      ...(mode !== "item_completed" ? [{ type: "response_item", payload: { ...delegated, type: "function_call_output", internal_chat_message_metadata_passthrough: { turn_id: "turn" } } }] : []),
      ...(mode === "item_completed" ? [{ type: "event_msg", payload: { type: "item_completed", turn_id: "turn", item: { ...delegated, type: "FunctionCallOutput" } } }] : []),
      { type: "response_item", payload: { type: "message", id: "final", role: "assistant", content: [{ type: "output_text", text: "Final" }] } },
      ...(mode === "both" ? [{ type: "event_msg", payload: { type: "item_completed", turn_id: "turn", item: { ...delegated, type: "FunctionCallOutput" } } }] : []),
      { type: "event_msg", payload: { type: "task_complete", turn_id: "turn" } },
    ].map((value) => JSON.stringify(value)).join("\n") + "\n");
    const databasePath = join(dir, "state.sqlite");
    const db = new DatabaseSync(databasePath);
    db.exec(`CREATE TABLE threads (id TEXT, rollout_path TEXT, name TEXT, title TEXT, preview TEXT, cwd TEXT,
      is_pinned INTEGER, model TEXT, reasoning_effort TEXT, sandbox_policy TEXT, approval_mode TEXT,
      updated_at_ms INTEGER, recency_at_ms INTEGER, archived INTEGER, thread_source TEXT)`);
    db.prepare("INSERT INTO threads VALUES ('t', ?, 'test', 'test', '', '/', 0, NULL, NULL, '{}', 'never', 1, 1, 0, NULL)").run(rollout);
    db.close();
    const desktop = new DesktopState(databasePath);
    try {
      const page = desktop.request("desktopState/readThread", { threadId: "t", history: { limitTurns: 1 } });
      const state = hydrateThread(initialCodexState, page);
      const turn = state.threads.t.turns.turn;
      expect(turn.itemOrder).toEqual(["fco-input", "final"]);
      expect(turn.items["fco-input"]).toMatchObject({ type: "delegatedInput", text: prompt, sourceThreadId });
      expect(state.threads.t.pendingToolOutputs).toEqual([]);
      expect(turn.items.final.text).toBe("Final");
    } finally { desktop.close(); }
  });
});

function historyFixture(records: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), "delegated-history-edge-"));
  mkdirSync(join(dir, "sessions"));
  const rollout = join(dir, "sessions", "rollout.jsonl");
  writeFileSync(rollout, records.map((value) => JSON.stringify(value)).join("\n") + "\n");
  const databasePath = join(dir, "state.sqlite");
  const db = new DatabaseSync(databasePath);
  db.exec(`CREATE TABLE threads (id TEXT, rollout_path TEXT, name TEXT, title TEXT, preview TEXT, cwd TEXT,
    is_pinned INTEGER, model TEXT, reasoning_effort TEXT, sandbox_policy TEXT, approval_mode TEXT,
    updated_at_ms INTEGER, recency_at_ms INTEGER, archived INTEGER, thread_source TEXT)`);
  db.prepare("INSERT INTO threads VALUES ('t', ?, 'test', 'test', '', '/', 0, NULL, NULL, '{}', 'never', 1, 1, 0, NULL)").run(rollout);
  db.close();
  return new DesktopState(databasePath);
}
