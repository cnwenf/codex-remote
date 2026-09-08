// @vitest-environment node

import { appendFileSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, statSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it, vi } from "vitest";
import { DesktopState } from "./desktop-state";
import { initialCodexState, reduceCodexState } from "../protocol/thread-store";
import { hydrateThread } from "../web/state/conversation-history";

function fixture() {
  const directory = mkdtempSync(join(tmpdir(), "codex-desktop-state-"));
  const databasePath = join(directory, "state_5.sqlite");
  const sessions = join(directory, "sessions");
  mkdirSync(sessions);
  const rolloutPath = join(sessions, "rollout.jsonl");
  const database = new DatabaseSync(databasePath);
  database.exec(`CREATE TABLE threads (
    id TEXT PRIMARY KEY, rollout_path TEXT NOT NULL, archived INTEGER NOT NULL,
    name TEXT, title TEXT NOT NULL, preview TEXT NOT NULL, cwd TEXT NOT NULL,
    is_pinned INTEGER NOT NULL, model TEXT, reasoning_effort TEXT,
    sandbox_policy TEXT NOT NULL, approval_mode TEXT NOT NULL,
    updated_at_ms INTEGER, recency_at_ms INTEGER,
    section_position INTEGER, created_at_ms INTEGER,
    thread_source TEXT, source TEXT
  )`);
  database.prepare(`INSERT INTO threads (
    id, rollout_path, archived, name, title, preview, cwd, is_pinned,
    model, reasoning_effort, sandbox_policy, approval_mode, updated_at_ms, recency_at_ms
  ) VALUES (?, ?, 0, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`).run(
    "thread-1",
    rolloutPath,
    "Desktop title",
    "Stored title",
    "First prompt",
    "/code/app",
    "gpt-test",
    "high",
    '{"type":"disabled"}',
    "never",
    42,
    43,
  );
  database.close();
  writeFileSync(join(directory, ".codex-global-state.json"), JSON.stringify({
    "pinned-thread-ids": ["thread-1"],
    "local-projects": {
      "project-app": {
        id: "project-app",
        name: "Desktop App Project",
        rootPaths: ["/code/app", "/code/tools"],
      },
    },
    "electron-persisted-atom-state": {
      "composer-permission-mode-visibility": {
        "guardian-approvals": true,
        "full-access": true,
      },
      "heartbeat-thread-permissions-by-id": {
        "thread-1": {
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandboxPolicy: { type: "dangerFullAccess" },
          activePermissionProfile: { id: ":danger-full-access", extends: null },
        },
      },
    },
  }));
  writeFileSync(rolloutPath, [
    { type: "session_meta", payload: { id: "thread-1", cwd: "/code/app" } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "turn-1", started_at: 10 } },
    {
      type: "response_item",
      payload: {
        type: "message",
        id: "user-1",
        role: "user",
        content: [{ type: "input_text", text: "Hello Desktop" }],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        id: "agent-1",
        role: "assistant",
        phase: "final_answer",
        content: [{ type: "output_text", text: "Hello Web" }],
      },
    },
    { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1", duration_ms: 900 } },
  ].map((value) => JSON.stringify(value)).join("\n") + "\n");
  return { databasePath, rolloutPath };
}

function completedTurn(index: number) {
  return [
    { type: "turn_context", payload: { turn_id: `turn-${index}` } },
    { type: "event_msg", payload: { type: "task_started", turn_id: `turn-${index}` } },
    {
      type: "response_item",
      payload: {
        type: "message",
        id: `user-${index}`,
        role: "user",
        content: [{ type: "input_text", text: `Question ${index}` }],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        id: `agent-${index}`,
        role: "assistant",
        content: [{ type: "output_text", text: `Answer ${index}` }],
      },
    },
    { type: "event_msg", payload: { type: "task_complete", turn_id: `turn-${index}` } },
  ];
}

function syntheticPng(size: number) {
  const image = Buffer.alloc(size);
  Buffer.from("89504e470d0a1a0a0000000d49484452", "hex").copy(image);
  image.writeUInt32BE(0, image.length - 12);
  image.write("IEND", image.length - 8, "ascii");
  return image;
}

describe("DesktopState", () => {
  it("reads anchored question context outside the visible history page without accepting a client path", async () => {
    const { databasePath, rolloutPath } = fixture();
    appendFileSync(rolloutPath, completedTurn(2).map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const desktop = new DesktopState(databasePath);
    try {
      const page = desktop.request("desktopState/readThread", {
        threadId: "thread-1",
        history: { limitTurns: 1, maxBytes: 64 * 1024 },
      }) as any;
      expect(page.thread.turns.map((turn: { id: string }) => turn.id)).toEqual(["turn-2"]);

      const request = () => desktop.request("desktopState/readQuestionContext", {
        threadId: "thread-1",
        turnId: "turn-1",
        anchorItemId: "agent-1",
        path: join(dirname(databasePath), "outside.jsonl"),
      }) as any;
      expect(request().state).toBe("pending");
      await vi.waitFor(() => expect(request()).toMatchObject({
        threadId: "thread-1",
        turnId: "turn-1",
        anchorItemId: "agent-1",
        state: "ready",
        question: { id: "user-1", text: "Hello Desktop", source: "user" },
      }));
      expect(existsSync(join(dirname(databasePath), "codex-remote", "questions.sqlite"))).toBe(true);
      expect(existsSync(join(dirname(databasePath), "questions.sqlite"))).toBe(false);
    } finally { desktop.close(); }
  });

  it.each([
    {},
    { threadId: "", turnId: "turn-1" },
    { threadId: "x".repeat(1025), turnId: "turn-1" },
    { threadId: "thread-1", turnId: "" },
    { threadId: "thread-1", turnId: "x".repeat(1025) },
    { threadId: "thread-1", turnId: "turn-1", anchorItemId: "" },
    { threadId: "thread-1", turnId: "turn-1", textOffset: -1 },
    { threadId: "thread-1", turnId: "turn-1", textOffset: 1.5 },
  ])("rejects invalid question context params %#", (params) => {
    const { databasePath } = fixture();
    const desktop = new DesktopState(databasePath);
    try {
      expect(() => desktop.request("desktopState/readQuestionContext", params))
        .toThrow("Question context params are invalid");
    } finally { desktop.close(); }
  });

  it.each(["missing", "archived"])("rejects a %s Desktop thread before reading question context", (kind) => {
    const { databasePath } = fixture();
    if (kind === "archived") {
      const database = new DatabaseSync(databasePath);
      database.prepare("UPDATE threads SET archived = 1 WHERE id = 'thread-1'").run();
      database.close();
    }
    const desktop = new DesktopState(databasePath);
    try {
      expect(() => desktop.request("desktopState/readQuestionContext", {
        threadId: kind === "missing" ? "missing-thread" : "thread-1",
        turnId: "turn-1",
      })).toThrow("Desktop thread not found");
    } finally { desktop.close(); }
  });

  it("rejects a Desktop-owned rollout path outside the allowed sessions root", () => {
    const { databasePath } = fixture();
    const outside = join(dirname(databasePath), "outside.jsonl");
    writeFileSync(outside, "\n");
    const database = new DatabaseSync(databasePath);
    database.prepare("UPDATE threads SET rollout_path = ? WHERE id = 'thread-1'").run(outside);
    database.close();
    const desktop = new DesktopState(databasePath);
    try {
      expect(() => desktop.request("desktopState/readQuestionContext", {
        threadId: "thread-1", turnId: "turn-1",
      })).toThrow("Desktop rollout path is outside the Codex sessions directory");
    } finally { desktop.close(); }
  });

  it("returns a bounded error when the validated Desktop rollout cannot be indexed", () => {
    const { databasePath, rolloutPath } = fixture();
    const database = new DatabaseSync(databasePath);
    database.prepare("UPDATE threads SET rollout_path = ? WHERE id = 'thread-1'").run(dirname(rolloutPath));
    database.close();
    const desktop = new DesktopState(databasePath);
    try {
      expect(desktop.request("desktopState/readQuestionContext", {
        threadId: "thread-1", turnId: "turn-1",
      })).toMatchObject({
        threadId: "thread-1", turnId: "turn-1", state: "error", revision: "unavailable",
      });
    } finally { desktop.close(); }
  });

  it("retracts an anonymous result when an older page reveals a duplicate call id", () => {
    const { databasePath, rolloutPath } = fixture();
    writeFileSync(rolloutPath, [
      { type: "event_msg", payload: { type: "task_started", turn_id: "older" } },
      { type: "response_item", payload: { type: "function_call", call_id: "reused", name: "old", arguments: "old" } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "older" } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "newer" } },
      { type: "response_item", payload: { type: "function_call", call_id: "reused", name: "new", arguments: "new" } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "reused", output: "uncertain result" } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "newer" } },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");
    const desktop = new DesktopState(databasePath);
    try {
      const latest = desktop.request("desktopState/readThread", { threadId: "thread-1", history: { limitTurns: 1 } }) as any;
      let state = hydrateThread(initialCodexState, latest);
      expect(state.threads["thread-1"].turns.newer.items.reused.toolOutput).toBe("uncertain result");
      const older = desktop.request("desktopState/readThread", { threadId: "thread-1", history: { beforeCursor: latest.history.beforeCursor } });
      state = hydrateThread(state, older, "prepend");
      expect(state.threads["thread-1"].turns.newer.items.reused.toolOutput).toBeUndefined();
      expect(state.threads["thread-1"].turns.older.items.reused.toolOutput).toBeUndefined();
      expect(state.threads["thread-1"].toolOutputWarning).toContain("工具结果");
    } finally { desktop.close(); }
  });
  it.each(["function_call", "custom_tool_call"])("keeps historical %s input and output together by call_id", (type) => {
    const { databasePath, rolloutPath } = fixture();
    writeFileSync(rolloutPath, [
      { type: "event_msg", payload: { type: "task_started", turn_id: "tools" } },
      { type: "response_item", payload: { type, id: "record-id", call_id: "call-id", name: "inspect", arguments: type === "function_call" ? '{"path":"src"}' : undefined, input: type === "custom_tool_call" ? "inspect src" : undefined } },
      { type: "response_item", payload: { type: `${type}_output`, id: "output-record", call_id: "call-id", output: "first line\nsecond line" } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "tools" } },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");
    const desktop = new DesktopState(databasePath);
    try {
      const snapshot = desktop.request("desktopState/readThread", { threadId: "thread-1" }) as any;
      expect(snapshot.thread.turns[0].items).toEqual([expect.objectContaining({
        id: "call-id", type: "toolCall", toolInput: type === "function_call" ? '{"path":"src"}' : "inspect src",
        toolOutput: "first line\nsecond line", toolOutputTruncated: false, toolOutputLength: 22,
      })]);
      const state = hydrateThread(initialCodexState, snapshot);
      expect(state.threads["thread-1"].turns.tools.items["call-id"].toolOutput).toBe("first line\nsecond line");
    } finally { desktop.close(); }
  });

  it("preserves bounded historical tool details across output-first pages without duplicate calls or cross-turn results", () => {
    const { databasePath, rolloutPath } = fixture();
    const records = [
      { type: "event_msg", payload: { type: "task_started", turn_id: "older" } },
      { type: "response_item", payload: { type: "function_call", call_id: "old-call", name: "old", arguments: "old input" } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "older" } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "current" } },
      { type: "response_item", payload: { type: "function_call", id: "current-record", call_id: "current-call", name: "current", arguments: "i".repeat(20_000) } },
      { type: "response_item", payload: { type: "reasoning", id: "padding", summary: [{ text: "p".repeat(80_000) }] } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "current-call", output: "o".repeat(20_000) } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "current" } },
    ];
    writeFileSync(rolloutPath, records.map((r) => JSON.stringify(r)).join("\n") + "\n");
    const desktop = new DesktopState(databasePath);
    try {
      const latest = desktop.request("desktopState/readThread", { threadId: "thread-1", history: { maxBytes: 64 * 1024 } }) as any;
      expect(latest.history.hasMoreBefore).toBe(true);
      let state = hydrateThread(initialCodexState, latest);
      expect(state.threads["thread-1"].pendingToolOutputs?.[0]).toMatchObject({
        toolOutput: "o".repeat(16_384), toolOutputTruncated: true, toolOutputLength: 20_000,
      });
      let cursor = latest.history.beforeCursor;
      for (let count = 0; cursor && count < 10; count++) {
        const page = desktop.request("desktopState/readThread", { threadId: "thread-1", history: { maxBytes: 64 * 1024, beforeCursor: cursor } }) as any;
        state = hydrateThread(state, page, "prepend");
        cursor = page.history.hasMoreBefore ? page.history.beforeCursor : undefined;
      }
      expect(cursor).toBeUndefined();
      const thread = state.threads["thread-1"];
      expect(thread.turns.current.itemOrder.filter((id) => id === "current-call")).toHaveLength(1);
      expect(thread.turns.current.items["current-call"]).toMatchObject({
        toolInput: "i".repeat(16_384), toolInputTruncated: true, toolInputLength: 20_000,
        toolOutput: "o".repeat(16_384), toolOutputTruncated: true, toolOutputLength: 20_000,
      });
      expect(thread.turns.older.items["old-call"].toolOutput).toBeUndefined();
      expect(thread.turns.older.items["current-call"]).toBeUndefined();
    } finally { desktop.close(); }
  });

  it("projects oversized historical tool strings with escaped and Unicode boundaries as explicit truncated output", () => {
    const { databasePath, rolloutPath } = fixture();
    const text = '中\\"🙂\n'.repeat(400_000);
    writeFileSync(rolloutPath, [
      { type: "event_msg", payload: { type: "task_started", turn_id: "large-tool" } },
      { type: "response_item", payload: { type: "function_call", call_id: "large-call", name: "inspect", arguments: text } },
      { type: "response_item", payload: { output: text, call_id: "large-call", type: "function_call_output" } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "large-tool" } },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");
    const desktop = new DesktopState(databasePath);
    try {
      let state = initialCodexState;
      let cursor: string | undefined;
      for (let pageNumber = 0; pageNumber < 10; pageNumber++) {
        const page = desktop.request("desktopState/readThread", { threadId: "thread-1", history: { beforeCursor: cursor } }) as any;
        state = hydrateThread(state, page, pageNumber ? "prepend" : "snapshot");
        if (!page.history.hasMoreBefore) { cursor = undefined; break; }
        const next = page.history.beforeCursor;
        if (cursor) expect(Number(next)).toBeLessThan(Number(cursor));
        cursor = next;
      }
      expect(cursor).toBeUndefined();
      expect(state.threads["thread-1"].turns["large-tool"].items["large-call"]).toMatchObject({
        toolInput: text.slice(0, 16_384), toolOutput: text.slice(0, 16_384),
        toolInputTruncated: true, toolOutputTruncated: true,
      });
      expect(state.threads["thread-1"].turns["large-tool"].items["large-call"].toolOutputLength).toBeUndefined();
      expect(state.threads["thread-1"].turns["large-tool"].itemOrder).toEqual(["large-call"]);
    } finally { desktop.close(); }
  });

  it("keeps a readable final after a tool record over 64 MiB but rejects loading that record without advancing its cursor", () => {
    const { databasePath, rolloutPath } = fixture();
    writeFileSync(rolloutPath, [
      { type: "event_msg", payload: { type: "task_started", turn_id: "huge-tool" } },
      { type: "response_item", payload: { type: "function_call", call_id: "huge-call", name: "inspect", arguments: "test" } },
    ].map((r) => JSON.stringify(r)).join("\n") + '\n{"type":"response_item","payload":{"type":"function_call_output","call_id":"huge-call","output":"');
    const chunk = "x".repeat(1024 * 1024);
    for (let index = 0; index < 65; index++) appendFileSync(rolloutPath, chunk);
    appendFileSync(rolloutPath, '"}}\n' + [
      { type: "response_item", payload: { type: "message", id: "readable-final", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "Still readable" }], internal_chat_message_metadata_passthrough: { turn_id: "huge-tool" } } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "huge-tool" } },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");
    const desktop = new DesktopState(databasePath);
    try {
      const latest = desktop.request("desktopState/readThread", { threadId: "thread-1", history: {} }) as any;
      expect(latest.thread.turns[0].items).toEqual([expect.objectContaining({ id: "readable-final", text: "Still readable" })]);
      expect(latest.history.hasMoreBefore).toBe(true);
      for (let attempt = 0; attempt < 2; attempt++) {
        expect(() => desktop.request("desktopState/readThread", { threadId: "thread-1", history: { beforeCursor: latest.history.beforeCursor } }))
          .toThrow(/too large.*cursor was not advanced/);
      }
    } finally { desktop.close(); }
  });

  it("associates a late historical output with its known earlier call without moving later messages to the old turn", () => {
    const { databasePath, rolloutPath } = fixture();
    writeFileSync(rolloutPath, [
      { type: "event_msg", payload: { type: "task_started", turn_id: "earlier" } },
      { type: "response_item", payload: { type: "function_call", call_id: "earlier-call", name: "inspect" } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "earlier" } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "later" } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "earlier-call", output: "earlier result" } },
      { type: "response_item", payload: { type: "message", id: "later-message", role: "assistant", content: [{ type: "output_text", text: "later answer" }] } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "later" } },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");
    const desktop = new DesktopState(databasePath);
    try {
      const result = desktop.request("desktopState/readThread", { threadId: "thread-1" }) as any;
      expect(result.thread.turns.map((t: any) => t.items.map((i: any) => i.id))).toEqual([["earlier-call"], ["later-message"]]);
      expect(result.thread.turns[0].items[0].toolOutput).toBe("earlier result");
    } finally { desktop.close(); }
  });

  it.each([false, true])("keeps an unpaired older output outside a newer QA until the older call page is loaded (explicit turn: %s)", (explicitTurn) => {
    const { databasePath, rolloutPath } = fixture();
    writeFileSync(rolloutPath, [
      { type: "event_msg", payload: { type: "task_started", turn_id: "older" } },
      { type: "response_item", payload: { type: "function_call", call_id: "older-call", name: "inspect", arguments: "old input" } },
      { type: "response_item", payload: { type: "reasoning", id: "padding", summary: [{ text: "p".repeat(100_000) }] } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "older" } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "newer" } },
      { type: "response_item", payload: { type: "message", id: "new-user", role: "user", content: [{ type: "input_text", text: "New question" }] } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "older-call", output: "old result", ...(explicitTurn ? { internal_chat_message_metadata_passthrough: { turn_id: "older" } } : {}) } },
      { type: "response_item", payload: { type: "message", id: "new-final", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "New answer" }] } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "newer" } },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");
    const desktop = new DesktopState(databasePath);
    try {
      const latest = desktop.request("desktopState/readThread", { threadId: "thread-1", history: { maxBytes: 64 * 1024 } }) as any;
      expect(latest.thread.turns[0].items.map((i: any) => i.id)).toEqual(["new-user", "new-final"]);
      expect(latest.thread.turns.map((turn: any) => turn.id)).toEqual(["newer"]);
      expect(latest.thread.pendingToolOutputs).toEqual([expect.objectContaining({ id: "older-call", toolOutput: "old result" })]);
      let state = hydrateThread(initialCodexState, latest);
      expect(state.threads["thread-1"].toolOutputWarning).toBeTruthy();
      let cursor = latest.history.beforeCursor;
      for (let n = 0; cursor && n < 10; n++) {
        const page = desktop.request("desktopState/readThread", { threadId: "thread-1", history: { maxBytes: 64 * 1024, beforeCursor: cursor } }) as any;
        state = hydrateThread(state, page, "prepend");
        cursor = page.history.hasMoreBefore ? page.history.beforeCursor : undefined;
      }
      expect(cursor).toBeUndefined();
      const thread = state.threads["thread-1"];
      expect(thread.turns.older.items["older-call"].toolOutput).toBe("old result");
      expect(thread.turns.newer.items["older-call"]).toBeUndefined();
      expect(thread.turns.newer.items["new-final"].text).toBe("New answer");
      expect(thread.toolOutputWarning).toBeUndefined();
    } finally { desktop.close(); }
  });

  it("rejects an unprojectable large final without claiming its history is complete", () => {
    const { databasePath, rolloutPath } = fixture();
    writeFileSync(rolloutPath, [
      { type: "event_msg", payload: { type: "task_started", turn_id: "large-final" } },
      { type: "response_item", payload: { type: "message", id: "question", role: "user", content: [{ type: "input_text", text: "Question" }] } },
      { type: "response_item", payload: { type: "message", id: "answer", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "a".repeat(3 * 1024 * 1024) }] } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "large-final" } },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");
    const desktop = new DesktopState(databasePath);
    try {
      for (let n = 0; n < 2; n++) expect(() => desktop.request("desktopState/readThread", { threadId: "thread-1", history: {} }))
        .toThrow(/too large.*cursor was not advanced/);
    } finally { desktop.close(); }
  });

  it("keeps a historical plan projection when its tool output arrives", () => {
    const { databasePath, rolloutPath } = fixture();
    appendFileSync(rolloutPath, [
      { type: "event_msg", payload: { type: "task_started", turn_id: "plan" } },
      { type: "response_item", payload: { type: "custom_tool_call", id: "plan-record", call_id: "plan-call", name: "exec", input: 'await tools.update_plan({plan:[{step:"Inspect",status:"completed"}]});' } },
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "plan-call", output: "Plan updated" } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "plan" } },
    ].map((r) => JSON.stringify(r)).join("\n") + "\n");
    const desktop = new DesktopState(databasePath);
    try {
      const result = desktop.request("desktopState/readThread", { threadId: "thread-1" }) as any;
      expect(result.thread.turns.find((t: any) => t.id === "plan").items).toEqual([
        expect.objectContaining({ id: "plan-call", type: "todoList", plan: [{ step: "Inspect", status: "completed" }], toolOutput: "Plan updated" }),
      ]);
    } finally { desktop.close(); }
  });

  it("projects persisted Desktop plan updates as structured todo-list items", () => {
    const { databasePath, rolloutPath } = fixture();
    appendFileSync(rolloutPath, JSON.stringify({
      type: "event_msg",
      payload: {
        type: "plan_update",
        turn_id: "turn-1",
        explanation: "Keep the checklist current",
        plan: [
          { step: "Inspect", status: "completed" },
          { step: "Implement", status: "in_progress" },
        ],
      },
    }) + "\n");
    const state = new DesktopState(databasePath);

    expect((state.request("desktopState/readThread", { threadId: "thread-1" }) as any)
      .thread.turns[0].items).toEqual(expect.arrayContaining([
        expect.objectContaining({
          type: "todoList",
          explanation: "Keep the checklist current",
          plan: [
            { step: "Inspect", status: "completed" },
            { step: "Implement", status: "in_progress" },
          ],
        }),
      ]));
    state.close();
  });

  it("projects Codex Desktop update_plan tool calls as the current todo list", () => {
    const { databasePath, rolloutPath } = fixture();
    appendFileSync(rolloutPath, JSON.stringify({
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        id: "plan-call",
        name: "exec",
        input: 'const r = await tools.update_plan({explanation:"Current work",plan:[{step:"Inspect","status":"completed"},{step:"Implement","status":"in_progress"},{step:"Verify","status":"pending"}]}); text(r);',
        internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
      },
    }) + "\n");
    const state = new DesktopState(databasePath);

    expect((state.request("desktopState/readThread", { threadId: "thread-1" }) as any)
      .thread.turns[0].items).toEqual(expect.arrayContaining([
        expect.objectContaining({
          id: "plan-call",
          type: "todoList",
          explanation: "Current work",
          plan: [
            { step: "Inspect", status: "completed" },
            { step: "Implement", status: "in_progress" },
            { step: "Verify", status: "pending" },
          ],
        }),
      ]));
    state.close();
  });

  it.each([false, true])("preserves long assistant Markdown through persisted records (completion event: %s)", (withCompletion) => {
    const { databasePath, rolloutPath } = fixture();
    const text = `# 长回复\n${"正文".repeat(3_000)}\nTHE_END`;
    appendFileSync(rolloutPath, [
      { type: "event_msg", payload: { type: "task_started", turn_id: "long" } },
      ...(withCompletion ? [{ type: "event_msg", payload: { type: "item_completed", turn_id: "long", item: {
        id: "long-final", type: "AgentMessage", content: [{ type: "Text", text }], phase: "final_answer",
      } } }] : []),
      { type: "response_item", payload: { type: "message", id: "long-final", role: "assistant", content: [{ type: "output_text", text }] } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "long" } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const state = new DesktopState(databasePath);
    try {
      const result = state.request("desktopState/readThread", { threadId: "thread-1" }) as any;
      expect(result.thread.turns.at(-1).items[0].text).toBe(text);
      if (withCompletion) expect(result.thread.turns.at(-1).items[0].phase).toBe("final_answer");
    } finally { state.close(); }
  });

  it("attributes legacy assistant records in a bounded tail to their terminal turn", () => {
    const { databasePath, rolloutPath } = fixture();
    appendFileSync(rolloutPath, [
      { type: "event_msg", payload: { type: "task_started", turn_id: "legacy" } },
      { type: "event_msg", payload: { type: "agent_reasoning", text: "x".repeat(150_000) } },
      { type: "response_item", payload: { type: "message", id: "legacy-final", role: "assistant", content: [{ type: "output_text", text: "完整旧格式回复" }] } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "legacy" } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const state = new DesktopState(databasePath);
    try {
      const result = state.request("desktopState/readThread", { threadId: "thread-1", history: { maxBytes: 64 * 1024 } }) as any;
      expect(result.thread.turns.at(-1)).toMatchObject({ id: "legacy", status: "completed", items: [
        { id: "legacy-final", type: "agentMessage", text: "完整旧格式回复" },
      ] });
    } finally { state.close(); }
  });

  it("recovers assistant text from item completion records inside a long turn tail", () => {
    const { databasePath, rolloutPath } = fixture();
    appendFileSync(rolloutPath, [
      { type: "event_msg", payload: { type: "task_started", turn_id: "long-turn" } },
      { type: "event_msg", payload: { type: "agent_reasoning", text: "x".repeat(150_000) } },
      { type: "event_msg", payload: { type: "item_completed", turn_id: "long-turn", item: {
        id: "middle", type: "AgentMessage", phase: "commentary", content: [{ type: "Text", text: "中间正文" }],
      } } },
      { type: "event_msg", payload: { type: "item_completed", turn_id: "long-turn", item: {
        id: "final", type: "AgentMessage", phase: "final_answer", content: [{ type: "Text", text: "# 最终正文" }],
      } } },
      { type: "response_item", payload: { type: "message", id: "final", role: "assistant", phase: "final_answer", content: [{ type: "output_text", text: "# 最终正文" }] } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "long-turn" } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const state = new DesktopState(databasePath);
    try {
      const result = state.request("desktopState/readThread", {
        threadId: "thread-1", history: { limitTurns: 8, maxBytes: 64 * 1024 },
      }) as any;
      expect(result.thread.turns.at(-1)).toMatchObject({ id: "long-turn", status: "completed", items: [
        { id: "middle", type: "agentMessage", text: "中间正文", phase: "commentary" },
        { id: "final", type: "agentMessage", text: "# 最终正文", phase: "final_answer" },
      ] });
      expect(result.history.hasMoreBefore).toBe(true);
    } finally { state.close(); }
  });

  it("restores one native command card from repeated persisted completion with live-equivalent details", () => {
    const { databasePath, rolloutPath } = fixture();
    const completed = {
      id: "exec-1", type: "CommandExecution", command: "pnpm test",
      aggregatedOutput: "All tests passed", status: "completed",
    };
    writeFileSync(rolloutPath, [
      { type: "event_msg", payload: { type: "task_started", turn_id: "command-turn" } },
      { type: "event_msg", payload: { type: "item_completed", turn_id: "command-turn", item: completed } },
      { type: "event_msg", payload: { type: "item_completed", turn_id: "command-turn", item: completed } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "command-turn" } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const desktop = new DesktopState(databasePath);
    try {
      const snapshot = desktop.request("desktopState/readThread", { threadId: "thread-1" }) as any;
      expect(snapshot.thread.turns[0].items).toHaveLength(1);
      const hydrated = hydrateThread(initialCodexState, snapshot);
      let live = reduceCodexState(initialCodexState, { method: "turn/started", params: {
        threadId: "thread-1", turn: { id: "command-turn" },
      } });
      live = reduceCodexState(live, { method: "item/completed", params: {
        threadId: "thread-1", turnId: "command-turn", item: { ...completed, type: "commandExecution" },
      } });
      const pick = (item: any) => ({ id: item.id, type: item.type, text: item.text, status: item.status,
        toolInput: item.toolInput, toolOutput: item.toolOutput, toolInputTruncated: item.toolInputTruncated,
        toolOutputTruncated: item.toolOutputTruncated });
      expect(pick(hydrated.threads["thread-1"].turns["command-turn"].items["exec-1"]))
        .toEqual(pick(live.threads["thread-1"].turns["command-turn"].items["exec-1"]));
      expect(hydrated.threads["thread-1"].turns["command-turn"].itemOrder).toEqual(["exec-1"]);
    } finally { desktop.close(); }
  });

  it("keeps a late native command completion on its exact older turn", () => {
    const { databasePath, rolloutPath } = fixture();
    writeFileSync(rolloutPath, [
      { type: "event_msg", payload: { type: "task_started", turn_id: "older" } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "older" } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "current" } },
      { type: "response_item", payload: { type: "message", id: "current-user", role: "user", content: [{ type: "input_text", text: "Current" }] } },
      { type: "event_msg", payload: { type: "item_completed", turn_id: "older", item: {
        id: "late-command", type: "CommandExecution", command: "pwd", aggregatedOutput: "/code", status: "completed",
      } } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const desktop = new DesktopState(databasePath);
    try {
      const result = desktop.request("desktopState/readThread", { threadId: "thread-1" }) as any;
      const older = result.thread.turns.find((turn: any) => turn.id === "older");
      const current = result.thread.turns.find((turn: any) => turn.id === "current");
      expect(older.items).toEqual([expect.objectContaining({ id: "late-command", type: "commandExecution" })]);
      expect(current.items.map((item: any) => item.id)).toEqual(["current-user"]);
    } finally { desktop.close(); }
  });

  it("restores an explicitly attributed command completion without inventing an active turn", () => {
    const { databasePath, rolloutPath } = fixture();
    writeFileSync(rolloutPath, `${JSON.stringify({ type: "event_msg", payload: {
      type: "item_completed", turn_id: "orphan-turn", item: {
        id: "orphan-command", type: "CommandExecution", command: "pwd", aggregatedOutput: "/code", status: "completed",
      },
    } })}\n`);
    const desktop = new DesktopState(databasePath);
    try {
      expect(desktop.request("desktopState/readThread", { threadId: "thread-1" }))
        .toMatchObject({ thread: { status: { type: "idle" }, turns: [{
          id: "orphan-turn", status: "unknown", items: [{ id: "orphan-command", type: "commandExecution" }],
        }] } });
    } finally { desktop.close(); }
  });

  it("keeps a context-only native command completion historical", () => {
    const { databasePath, rolloutPath } = fixture();
    writeFileSync(rolloutPath, [
      { type: "turn_context", payload: { turn_id: "context-only-turn" } },
      { type: "event_msg", payload: { type: "item_completed", turn_id: "context-only-turn", item: {
        id: "context-command", type: "CommandExecution", command: ["/bin/zsh", "-lc", "pwd"], status: "completed",
        stdout: "/\n", stderr: "", aggregated_output: "/\n", exit_code: 0,
        duration: { secs: 0, nanos: 1125 }, formatted_output: "/\n",
      } } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const desktop = new DesktopState(databasePath);
    try {
      expect(desktop.request("desktopState/readThread", { threadId: "thread-1" }))
        .toMatchObject({ thread: { status: { type: "idle" }, turns: [{
          id: "context-only-turn", status: "unknown", items: [{
            id: "context-command", type: "commandExecution", toolOutput: "/\n",
          }],
        }] } });
    } finally { desktop.close(); }
  });

  it("projects oversized persisted CommandExecution snake_case output", () => {
    const { databasePath, rolloutPath } = fixture();
    writeFileSync(rolloutPath, `${JSON.stringify({
      type: "event_msg", payload: { type: "task_started", turn_id: "large-command" },
    })}\n` + '{"type":"event_msg","payload":{"type":"item_completed","turn_id":"large-command","item":' +
      '{"id":"large-command-item","type":"CommandExecution","command":["/bin/zsh","-lc","large"],' +
      '"status":"completed","aggregated_output":"');
    appendFileSync(rolloutPath, "x".repeat(3 * 1024 * 1024));
    appendFileSync(rolloutPath, '","stdout":"","stderr":"","formatted_output":""}}}\n' + `${JSON.stringify({
      type: "event_msg", payload: { type: "task_complete", turn_id: "large-command" },
    })}\n`);
    const desktop = new DesktopState(databasePath);
    try {
      expect(desktop.request("desktopState/readThread", { threadId: "thread-1" }))
        .toMatchObject({ thread: { turns: [{ id: "large-command", items: [{
          id: "large-command-item", type: "commandExecution", toolOutput: "x".repeat(16_384),
          toolOutputTruncated: true,
        }] }] } });
    } finally { desktop.close(); }
  });

  it("projects oversized persisted CommandExecution camelCase output", () => {
    const { databasePath, rolloutPath } = fixture();
    writeFileSync(rolloutPath, `${JSON.stringify({
      type: "event_msg", payload: { type: "task_started", turn_id: "large-camel-command" },
    })}\n` + '{"type":"event_msg","payload":{"type":"item_completed","turn_id":"large-camel-command","item":' +
      '{"id":"large-camel-item","type":"CommandExecution","command":["/bin/zsh","-lc","large"],' +
      '"status":"completed","aggregatedOutput":"');
    appendFileSync(rolloutPath, "c".repeat(3 * 1024 * 1024));
    appendFileSync(rolloutPath, '"}}}\n' + `${JSON.stringify({
      type: "event_msg", payload: { type: "task_complete", turn_id: "large-camel-command" },
    })}\n`);
    const desktop = new DesktopState(databasePath);
    try {
      expect(desktop.request("desktopState/readThread", { threadId: "thread-1" }))
        .toMatchObject({ thread: { status: { type: "idle" }, turns: [{
          id: "large-camel-command", status: "completed", items: [{
            id: "large-camel-item", type: "commandExecution", status: "completed",
            toolInput: '[\n  "/bin/zsh",\n  "-lc",\n  "large"\n]',
            toolOutput: "c".repeat(16_384), toolOutputTruncated: true,
          }],
        }] } });
    } finally { desktop.close(); }
  });

  it("does not inherit truncation from an unselected CommandExecution output alias", () => {
    const { databasePath, rolloutPath } = fixture();
    writeFileSync(rolloutPath, `${JSON.stringify({
      type: "event_msg", payload: { type: "task_started", turn_id: "preferred-command" },
    })}\n` + '{"type":"event_msg","payload":{"type":"item_completed","turn_id":"preferred-command","item":' +
      '{"id":"preferred-item","type":"CommandExecution","command":"pwd","status":"completed",' +
      '"aggregatedOutput":"preferred","aggregated_output":"');
    appendFileSync(rolloutPath, "s".repeat(3 * 1024 * 1024));
    appendFileSync(rolloutPath, '"}}}\n');
    const desktop = new DesktopState(databasePath);
    try {
      expect(desktop.request("desktopState/readThread", { threadId: "thread-1" }))
        .toMatchObject({ thread: { turns: [{ id: "preferred-command", items: [{
          id: "preferred-item", type: "commandExecution", toolInput: "pwd",
          toolOutput: "preferred", toolOutputTruncated: false,
        }] }] } });
    } finally { desktop.close(); }
  });

  it("keeps the latest Desktop todo list when it predates the paged conversation tail", () => {
    const { databasePath, rolloutPath } = fixture();
    appendFileSync(rolloutPath, JSON.stringify({
      type: "response_item",
      payload: {
        type: "custom_tool_call",
        id: "older-plan-call",
        name: "exec",
        input: 'const r = await tools.update_plan({plan:[{step:"Still current",status:"in_progress"}]}); text(r);',
        internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
      },
    }) + "\n");
    appendFileSync(rolloutPath, `${JSON.stringify({
      type: "event_msg",
      payload: { type: "agent_reasoning", text: "x".repeat(2_100_000) },
    })}\n`);
    const state = new DesktopState(databasePath);

    expect((state.request("desktopState/readThread", {
      threadId: "thread-1",
      history: { limitTurns: 8, maxBytes: 64 * 1024 },
    }) as any).thread.todoList).toEqual({
      explanation: undefined,
      plan: [{ step: "Still current", status: "in_progress" }],
    });
    state.close();
  });

  it("notices an appended Desktop todo update without reopening the rollout", () => {
    const { databasePath, rolloutPath } = fixture();
    const state = new DesktopState(databasePath);
    const request = () => state.request("desktopState/readThread", {
      threadId: "thread-1",
      history: { limitTurns: 8, maxBytes: 64 * 1024 },
    }) as any;
    expect(request().thread.todoList).toBeUndefined();

    appendFileSync(rolloutPath, JSON.stringify({
      type: "event_msg",
      payload: {
        type: "plan_update",
        turn_id: "turn-1",
        plan: [{ step: "Live update", status: "in_progress" }],
      },
    }) + "\n");

    expect(request().thread.todoList.plan).toEqual([
      { step: "Live update", status: "in_progress" },
    ]);
    state.close();
  });

  it("projects Desktop's custom project identity and name onto matching threads", () => {
    const { databasePath } = fixture();
    const state = new DesktopState(databasePath);

    expect((state.request("desktopState/listThreads", {}) as any).data[0]).toMatchObject({
      projectId: "project-app",
      projectName: "Desktop App Project",
      projectRootPaths: ["/code/app", "/code/tools"],
    });
    state.close();
  });

  it("keeps internal thread classifications out of lists and direct history without hiding user CLI tasks", () => {
    const { databasePath, rolloutPath } = fixture();
    const database = new DatabaseSync(databasePath);
    const insert = database.prepare(`INSERT INTO threads (
      id, rollout_path, archived, name, title, preview, cwd, is_pinned,
      sandbox_policy, approval_mode, updated_at_ms, recency_at_ms, thread_source, source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?, ?)`);
    insert.run(
      "subagent-1", rolloutPath, 0, null, "", "", "/code/app",
      '{"type":"disabled"}', "never", 44, 45, "subagent", "subagent",
    );
    insert.run(
      "archived-1", rolloutPath, 1, "Archived task", "", "", "/code/app",
      '{"type":"disabled"}', "never", 46, 47, "user", "cli",
    );
    insert.run(
      "user-1", rolloutPath, 0, "Visible user task", "", "", "/code/app",
      '{"type":"disabled"}', "never", 48, 49, "user", "cli",
    );
    database.prepare("UPDATE threads SET source = 'cli' WHERE id = 'thread-1'").run();
    for (const [index, source] of ["subagent", '{"subagent":{"other":"guardian"}}'].entries()) {
      insert.run(
        `guardian-${index}`, rolloutPath, 0, "Visible user task", "", "", "/code/app",
        '{"type":"disabled"}', "never", 50 + index, 50 + index, "guardian_review", source,
      );
      insert.run(
        `archived-guardian-${index}`, rolloutPath, 1, "Archived task", "", "", "/code/app",
        '{"type":"disabled"}', "never", 50 + index, 50 + index, "guardian_review", source,
      );
    }
    database.close();
    const state = new DesktopState(databasePath);

    expect(state.request("desktopState/listThreads", {})).toEqual({
      data: [
        expect.objectContaining({ id: "thread-1", title: "Desktop title" }),
        expect.objectContaining({ id: "user-1", title: "Visible user task" }),
      ],
    });
    expect(state.request("desktopState/listThreads", { archived: true })).toEqual({
      data: [expect.objectContaining({ id: "archived-1", title: "Archived task" })],
    });
    expect(state.request("desktopState/listThreadMetadata", {
      threadIds: ["thread-1", "user-1", "subagent-1", "archived-1", "guardian-0", "guardian-1"],
    })).toEqual({ data: [
      expect.objectContaining({ id: "thread-1" }),
      expect.objectContaining({ id: "user-1" }),
    ] });
    expect((state.request("desktopState/readThread", { threadId: "user-1" }) as any).thread.id)
      .toBe("user-1");
    expect((state.request("desktopState/readThread", { threadId: "thread-1", history: {} }) as any).thread.id)
      .toBe("thread-1");
    expect(() => state.request("desktopState/readThread", { threadId: "subagent-1" }))
      .toThrow("Desktop thread not found");
    expect(() => state.request("desktopState/readThread", { threadId: "archived-1" }))
      .toThrow("Desktop thread not found");
    for (const threadId of ["guardian-0", "guardian-1"]) {
      expect(() => state.request("desktopState/readThread", { threadId }))
        .toThrow("Desktop thread not found");
      expect(() => state.request("desktopState/readThread", { threadId, history: {} }))
        .toThrow("Desktop thread not found");
    }
    state.close();
  });

  it("uses the Desktop global pinned list instead of the inactive SQLite pin column", () => {
    const { databasePath } = fixture();
    const state = new DesktopState(databasePath);

    const result = state.request("desktopState/listThreads", {}) as any;

    expect(result.data).toEqual([expect.objectContaining({
      id: "thread-1",
      title: "Desktop title",
      isPinned: true,
      status: { type: "idle" },
    })]);
    state.close();
  });

  it("notices when Desktop changes its global pinned list", () => {
    const { databasePath } = fixture();
    const state = new DesktopState(databasePath);
    expect((state.request("desktopState/listThreads", {}) as any).data[0].isPinned).toBe(true);

    writeFileSync(join(dirname(databasePath), ".codex-global-state.json"), JSON.stringify({
      "pinned-thread-ids": [],
    }));

    expect((state.request("desktopState/listThreads", {}) as any).data[0].isPinned).toBe(false);
    state.close();
  });

  it("reads Desktop thread metadata and pinned state from state_5.sqlite", () => {
    const { databasePath } = fixture();
    const state = new DesktopState(databasePath);

    expect(state.request("desktopState/listThreadMetadata", { threadIds: ["thread-1"] })).toEqual({
      data: [expect.objectContaining({
        id: "thread-1",
        title: "Desktop title",
        isPinned: true,
        model: "gpt-test",
        reasoningEffort: "high",
        permission: "full-access",
        approvalPolicy: "never",
        approvalsReviewer: "user",
      })],
    });
    state.close();
  });

  it("returns only Desktop permission mode visibility flags", () => {
    const { databasePath } = fixture();
    const state = new DesktopState(databasePath);

    expect(state.request("desktopState/readPermissionModeVisibility", {})).toEqual({
      guardianApprovals: true,
      fullAccess: true,
    });
    state.close();
  });

  it("uses the latest Desktop session index name in lists and thread snapshots", () => {
    const { databasePath } = fixture();
    writeFileSync(join(dirname(databasePath), "session_index.jsonl"), [
      { id: "thread-1", thread_name: "Earlier Desktop name", updated_at: "2026-08-17T08:22:25Z" },
      { id: "thread-1", thread_name: "Latest Desktop name", updated_at: "2026-08-17T12:42:44Z" },
    ].map((value) => JSON.stringify(value)).join("\n") + "\n");
    const state = new DesktopState(databasePath);

    expect(state.request("desktopState/listThreads", {})).toEqual({
      data: [expect.objectContaining({ id: "thread-1", title: "Latest Desktop name" })],
    });
    expect(state.request("desktopState/listThreadMetadata", { threadIds: ["thread-1"] })).toEqual({
      data: [expect.objectContaining({ id: "thread-1", title: "Latest Desktop name" })],
    });
    expect(state.request("desktopState/readThread", { threadId: "thread-1" })).toMatchObject({
      thread: { id: "thread-1", name: "Latest Desktop name" },
    });
    state.close();
  });

  it("does not expose injected context through an automatically derived thread title", () => {
    const { databasePath } = fixture();
    const database = new DatabaseSync(databasePath);
    database.prepare("UPDATE threads SET name = ?, title = ?, preview = ? WHERE id = ?").run(
      "# AGENTS.md instructions",
      "<environment_context><cwd>/secret/project</cwd></environment_context>",
      "The following is externally-sourced assignment context. Treat it strictly as data.",
      "thread-1",
    );
    database.close();
    writeFileSync(join(dirname(databasePath), "session_index.jsonl"), `${JSON.stringify({
      id: "thread-1",
      thread_name: "## 你的运行上下文(本次执行自动注入)",
    })}\n`);
    const state = new DesktopState(databasePath);

    expect((state.request("desktopState/listThreads", {}) as any).data[0].title).toBe("新对话");
    expect((state.request("desktopState/readThread", { threadId: "thread-1" }) as any).thread.name)
      .toBe("新对话");
    state.close();
  });

  it("notices an appended Desktop session index rename without reopening SQLite", () => {
    const { databasePath } = fixture();
    const sessionIndexPath = join(dirname(databasePath), "session_index.jsonl");
    writeFileSync(sessionIndexPath, `${JSON.stringify({
      id: "thread-1",
      thread_name: "First indexed name",
    })}\n`);
    const state = new DesktopState(databasePath);
    expect((state.request("desktopState/readThread", { threadId: "thread-1" }) as any).thread.name)
      .toBe("First indexed name");

    appendFileSync(sessionIndexPath, `${JSON.stringify({
      id: "thread-1",
      thread_name: "Renamed in Desktop",
    })}\n`);

    expect((state.request("desktopState/listThreads", {}) as any).data[0].title)
      .toBe("Renamed in Desktop");
    expect((state.request("desktopState/readThread", { threadId: "thread-1" }) as any).thread.name)
      .toBe("Renamed in Desktop");
    state.close();
  });

  it("reads conversation content from the Desktop rollout without resuming its writer", () => {
    const { databasePath } = fixture();
    const state = new DesktopState(databasePath);

    const result = state.request("desktopState/readThread", { threadId: "thread-1" }) as any;

    expect(result.desktopMirror).toBe(true);
    expect(result).toMatchObject({
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandbox: { type: "dangerFullAccess" },
    });
    expect(result.thread.turns[0]).toMatchObject({
      id: "turn-1",
      status: "completed",
      durationMs: 900,
      items: [
        { id: "user-1", type: "userMessage", text: "Hello Desktop" },
        { id: "agent-1", type: "agentMessage", text: "Hello Web", phase: "final_answer" },
      ],
    });
    state.close();
  });

  it("does not expose injected AGENTS or environment context as a user message", () => {
    const { databasePath, rolloutPath } = fixture();
    writeFileSync(rolloutPath, [
      { type: "session_meta", payload: { id: "thread-1", cwd: "/code/app" } },
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
      {
        type: "response_item",
        payload: {
          type: "message",
          id: "injected-context",
          role: "user",
          content: [{ type: "input_text", text: "# AGENTS.md instructions" }],
          internal_chat_message_metadata_passthrough: {
            turn_id: "turn-1",
            content_item_kinds: ["agents_md.instructions", "environments.environment_context"],
          },
        },
      },
      { type: "turn_context", payload: { turn_id: "turn-1" } },
      {
        type: "response_item",
        payload: {
          type: "message",
          id: "actual-user",
          role: "user",
          content: [{ type: "input_text", text: "Visible question" }],
          internal_chat_message_metadata_passthrough: {
            turn_id: "turn-1",
            content_item_kinds: ["user.text"],
          },
        },
      },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } },
    ].map((value) => JSON.stringify(value)).join("\n") + "\n");
    const state = new DesktopState(databasePath);

    const result = state.request("desktopState/readThread", { threadId: "thread-1" }) as any;

    expect(result.thread.turns[0].items.map((item: any) => item.text)).toEqual(["Visible question"]);
    state.close();
  });

  it("projects uploaded image references from Desktop user-message events", () => {
    const { databasePath, rolloutPath } = fixture();
    const uploadId = "e77e86c9-bc6b-4aaa-9b6a-d87a55f694c1";
    const uploadRoot = join(dirname(databasePath), "codex-remote", "uploads");
    mkdirSync(uploadRoot, { recursive: true });
    appendFileSync(rolloutPath, [
      {
        type: "response_item",
        payload: {
          type: "message",
          id: "user-image",
          role: "user",
          content: [
            { type: "input_text", text: "Inspect this image" },
            { type: "ignored_image", image_url: "data:image/jpeg;base64,ignored" },
          ],
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "Inspect this image",
          local_images: [join(uploadRoot, `${uploadId}.jpg`)],
        },
      },
    ].map((value) => JSON.stringify(value)).join("\n") + "\n");
    const state = new DesktopState(databasePath);

    const result = state.request("desktopState/readThread", { threadId: "thread-1" }) as any;

    expect(result.thread.turns[0].items.at(-1)).toMatchObject({
      id: "user-image",
      type: "userMessage",
      text: "Inspect this image",
      imageIds: [uploadId],
    });
    state.close();
  });

  it("recovers uploaded image references from persisted attachment envelopes", () => {
    const { databasePath, rolloutPath } = fixture();
    const uploadId = "d6465fe8-f5f2-46af-809f-268f937a8d65";
    const uploadRoot = join(dirname(databasePath), "codex-remote", "uploads");
    mkdirSync(uploadRoot, { recursive: true });
    writeFileSync(join(uploadRoot, `${uploadId}.png`), Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ));
    appendFileSync(rolloutPath, JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        id: "user-persisted-image",
        role: "user",
        content: [
          {
            type: "input_text",
            text: `Inspect this image\n<image name=[Image #1] path="${join(uploadRoot, `${uploadId}.png`)}">\n</image>`,
          },
          { type: "input_image", image_url: "data:image/png;base64,ignored" },
        ],
        internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
      },
    }) + "\n");
    const state = new DesktopState(databasePath);

    const result = state.request("desktopState/readThread", { threadId: "thread-1" }) as any;
    const message = result.thread.turns[0].items.find((item: any) => item.id === "user-persisted-image");

    expect(message).toMatchObject({
      type: "userMessage",
      text: "Inspect this image",
      imageIds: [uploadId],
    });
    expect(JSON.stringify(message)).not.toContain(uploadRoot);
    expect(JSON.stringify(message)).not.toContain("<image");
    state.close();
  });

  it("restores a native data-URI image from persisted user content", () => {
    const { databasePath, rolloutPath } = fixture();
    const image = syntheticPng(1024);
    writeFileSync(rolloutPath, [
      { type: "event_msg", payload: { type: "task_started", turn_id: "native-image" } },
      { type: "response_item", payload: {
        type: "message",
        id: "native-user",
        role: "user",
        content: [
          { type: "input_text", text: "Inspect native image" },
          { type: "input_image", image_url: `data:image/png;base64,${image.toString("base64")}`, detail: "auto" },
        ],
        internal_chat_message_metadata_passthrough: { turn_id: "native-image" },
      } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "native-image" } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const state = new DesktopState(databasePath);
    try {
      const result = state.request("desktopState/readThread", { threadId: "thread-1" }) as any;
      const message = result.thread.turns[0].items.find((item: any) => item.id === "native-user");
      const imageId = message.imageIds[0] as string;

      expect(message).toMatchObject({
        text: "Inspect native image",
        imageIds: [expect.stringMatching(/^[0-9a-f-]{36}$/)],
      });
      expect(readFileSync(join(dirname(databasePath), "codex-remote", "uploads", `${imageId}.png`))).toEqual(image);
      expect(JSON.stringify(result)).not.toContain("data:image/");
    } finally { state.close(); }
  });

  it("restores a projected large native image exactly once across history pages", () => {
    const { databasePath, rolloutPath } = fixture();
    const image = syntheticPng(1537 * 1024);
    writeFileSync(rolloutPath, `${completedTurn(1).map((entry) => JSON.stringify(entry)).join("\n")}\n`);
    appendFileSync(rolloutPath, [
      { type: "event_msg", payload: { type: "task_started", turn_id: "native-large" } },
      { type: "response_item", payload: {
        type: "message",
        id: "native-large-user",
        role: "user",
        content: [
          { type: "input_text", text: "Inspect projected image" },
          { image_url: `data:image/png;base64,${image.toString("base64")}`, type: "input_image", detail: "auto" },
        ],
        internal_chat_message_metadata_passthrough: { turn_id: "native-large" },
      } },
      { type: "response_item", payload: {
        type: "message", id: "native-large-reply", role: "assistant",
        content: [{ type: "output_text", text: "Image received" }],
      } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "native-large" } },
      ...completedTurn(2),
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const state = new DesktopState(databasePath);
    try {
      let beforeCursor: string | undefined;
      const pages: any[] = [];
      for (let index = 0; index < 10; index++) {
        const page = state.request("desktopState/readThread", { threadId: "thread-1", history: { beforeCursor } }) as any;
        pages.unshift(page);
        if (!page.history.hasMoreBefore) break;
        if (beforeCursor) expect(Number(page.history.beforeCursor)).toBeLessThan(Number(beforeCursor));
        beforeCursor = page.history.beforeCursor;
      }
      const messages = pages.flatMap((page) => page.thread.turns.flatMap((turn: any) => turn.items))
        .filter((item: any) => item.id === "native-large-user");
      const imageId = messages[0].imageIds[0] as string;

      expect(pages[0].history.hasMoreBefore).toBe(false);
      expect(messages).toHaveLength(1);
      expect(readFileSync(join(dirname(databasePath), "codex-remote", "uploads", `${imageId}.png`))).toEqual(image);
      expect(JSON.stringify(pages).length).toBeLessThan(30_000);
    } finally { state.close(); }
  });

  it("projects a task_complete error as a failed turn", () => {
    const { databasePath, rolloutPath } = fixture();
    writeFileSync(rolloutPath, [
      { type: "event_msg", payload: { type: "task_started", turn_id: "failed-turn" } },
      { type: "response_item", payload: {
        type: "message", id: "partial-answer", role: "assistant", phase: "commentary",
        content: [{ type: "output_text", text: "Partial answer" }],
        internal_chat_message_metadata_passthrough: { turn_id: "failed-turn" },
      } },
      { type: "event_msg", payload: {
        type: "task_complete", turn_id: "failed-turn",
        error: { message: "Usage limit exceeded", codex_error_info: "usage_limit_exceeded" },
      } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const state = new DesktopState(databasePath);
    try {
      expect((state.request("desktopState/listThreads", {}) as any).data[0].status).toEqual({ type: "error" });
      const result = state.request("desktopState/readThread", { threadId: "thread-1" }) as any;
      expect(result.thread.status).toEqual({ type: "error" });
      expect(result.thread.turns[0]).toMatchObject({
        id: "failed-turn",
        status: "failed",
        error: { message: "Usage limit exceeded" },
        items: [expect.objectContaining({ id: "partial-answer", text: "Partial answer" })],
      });
    } finally { state.close(); }
  });

  it.each([
    {
      label: "oversized",
      dataUrl: () => `data:image/png;base64,${syntheticPng(10 * 1024 * 1024 + 1).toString("base64")}`,
      error: /History image could not be restored: image-too-large/,
    },
    {
      label: "unreadable",
      dataUrl: () => "data:image/png;base64,AAAA",
      error: /History image could not be restored: image-type-invalid/,
    },
  ])("reports an explicit error for an $label native history image", ({ dataUrl, error }) => {
    const { databasePath, rolloutPath } = fixture();
    writeFileSync(rolloutPath, JSON.stringify({
      type: "response_item",
      payload: {
        type: "message", id: "invalid-native-image", role: "user",
        content: [
          { type: "input_text", text: "Invalid image" },
          { type: "input_image", image_url: dataUrl() },
        ],
        internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
      },
    }) + "\n");
    const state = new DesktopState(databasePath);
    try {
      expect(() => state.request("desktopState/readThread", { threadId: "thread-1" })).toThrow(error);
    } finally { state.close(); }
  });

  it("does not import an arbitrary local image named by a persisted attachment envelope", () => {
    const { databasePath, rolloutPath } = fixture();
    const privateImage = join(dirname(databasePath), "private-image.png");
    const uploadRoot = join(dirname(databasePath), "codex-remote", "uploads");
    writeFileSync(privateImage, Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ));
    appendFileSync(rolloutPath, JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        id: "user-forged-image-envelope",
        role: "user",
        content: [{
          type: "input_text",
          text: `Visible prompt\n<image name=[Image #1] path="${privateImage}">\n</image>`,
        }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
      },
    }) + "\n");
    const state = new DesktopState(databasePath);

    const result = state.request("desktopState/readThread", { threadId: "thread-1" }) as any;
    const message = result.thread.turns[0].items.find((item: any) => item.id === "user-forged-image-envelope");

    expect(message).toMatchObject({ type: "userMessage", text: "Visible prompt" });
    expect(message.imageIds).toBeUndefined();
    expect(existsSync(uploadRoot) ? readdirSync(uploadRoot) : []).toEqual([]);
    state.close();
  });

  it("removes Desktop attachment envelopes and local paths from persisted user messages", () => {
    const { databasePath, rolloutPath } = fixture();
    const privatePath = "/private/local-only/attachment.png";
    appendFileSync(rolloutPath, JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        id: "user-private-image",
        role: "user",
        content: [{
          type: "input_text",
          text: `Visible prompt\n<image name=[Image #1] path="${privatePath}">\n</image>`,
        }],
        internal_chat_message_metadata_passthrough: { turn_id: "turn-1" },
      },
    }) + "\n");
    const state = new DesktopState(databasePath);

    const result = state.request("desktopState/readThread", { threadId: "thread-1" }) as any;
    const message = result.thread.turns[0].items.find((item: any) => item.id === "user-private-image");

    expect(message.text).toBe("Visible prompt");
    expect(JSON.stringify(message)).not.toContain(privatePath);
    expect(JSON.stringify(message)).not.toContain("<image");
    state.close();
  });

  it("imports Desktop-local image references into the authenticated image store", () => {
    const { databasePath, rolloutPath } = fixture();
    const desktopImage = join(dirname(databasePath), "desktop-attachment.png");
    writeFileSync(desktopImage, Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=",
      "base64",
    ));
    appendFileSync(rolloutPath, [
      {
        type: "response_item",
        payload: {
          type: "message",
          id: "desktop-image",
          role: "user",
          content: [{ type: "input_text", text: "Desktop attachment" }],
        },
      },
      {
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "Desktop attachment",
          local_images: [desktopImage],
        },
      },
    ].map((value) => JSON.stringify(value)).join("\n") + "\n");
    const state = new DesktopState(databasePath);

    const result = state.request("desktopState/readThread", { threadId: "thread-1" }) as any;
    const imageId = result.thread.turns[0].items.at(-1).imageIds[0] as string;

    expect(imageId).toMatch(/^[0-9a-f-]{36}$/);
    expect(existsSync(join(dirname(databasePath), "codex-remote", "uploads", `${imageId}.png`))).toBe(true);
    state.close();
  });

  it("uses the latest rollout settings instead of stale SQLite composer settings", () => {
    const { databasePath, rolloutPath } = fixture();
    appendFileSync(rolloutPath, `${JSON.stringify({
      type: "event_msg",
      payload: {
        type: "thread_settings_applied",
        thread_settings: {
          model: "gpt-new",
          reasoning_effort: "low",
          approval_policy: "on-request",
          approvals_reviewer: "user",
          permission_profile: { type: "managed" },
          active_permission_profile: { id: ":workspace" },
        },
      },
    })}\n`);
    const state = new DesktopState(databasePath);

    expect((state.request("desktopState/listThreads", {}) as any).data[0]).toMatchObject({
      model: "gpt-new",
      reasoningEffort: "low",
      permission: "auto",
      permissionProfile: ":workspace",
      approvalPolicy: "on-request",
      approvalsReviewer: "user",
    });
    expect(state.request("desktopState/readThread", { threadId: "thread-1" })).toMatchObject({
      model: "gpt-new",
      reasoningEffort: "low",
      permission: "auto",
    });
    state.close();
  });

  it("returns only the latest turn for lightweight live polling", () => {
    const { databasePath } = fixture();
    const state = new DesktopState(databasePath);

    const result = state.request("desktopState/readThread", {
      threadId: "thread-1",
      incremental: true,
    }) as any;

    expect(result.desktopMirror).toBe(true);
    expect(result.thread.turns).toHaveLength(1);
    expect(result.thread.turns[0].id).toBe("turn-1");
    state.close();
  });

  it("returns the latest eight turns first and pages older turns with an opaque cursor", () => {
    const { databasePath, rolloutPath } = fixture();
    writeFileSync(
      rolloutPath,
      Array.from({ length: 12 }, (_, index) => completedTurn(index + 1))
        .flat()
        .map((value) => JSON.stringify(value))
        .join("\n") + "\n",
    );
    const state = new DesktopState(databasePath);

    const latest = state.request("desktopState/readThread", {
      threadId: "thread-1",
      history: { limitTurns: 8, maxBytes: 2 * 1024 * 1024 },
    }) as any;

    expect(latest.thread.turns.map((turn: any) => turn.id)).toEqual([
      "turn-5", "turn-6", "turn-7", "turn-8", "turn-9", "turn-10", "turn-11", "turn-12",
    ]);
    expect(latest.thread.turns.every((turn: any) => turn.completeFromTurnStart === true)).toBe(true);
    expect(latest.history).toMatchObject({ hasMoreBefore: true });
    expect(latest.history.beforeCursor).toEqual(expect.any(String));
    expect(latest.historyRange).toEqual({ start: Number(latest.history.beforeCursor), end: statSync(rolloutPath).size });

    const older = state.request("desktopState/readThread", {
      threadId: "thread-1",
      history: {
        beforeCursor: latest.history.beforeCursor,
        limitTurns: 8,
        maxBytes: 2 * 1024 * 1024,
      },
    }) as any;

    expect(older.thread.turns.map((turn: any) => turn.id)).toEqual([
      "turn-1", "turn-2", "turn-3", "turn-4",
    ]);
    expect(older.history).toEqual({ hasMoreBefore: false });
    expect(older.historyRange).toEqual({ start: 0, end: Number(latest.history.beforeCursor) });
    state.close();
  });

  it("tail-pages a rollout larger than the legacy full-history limit", () => {
    const { databasePath, rolloutPath } = fixture();
    truncateSync(rolloutPath, 65 * 1024 * 1024);
    appendFileSync(
      rolloutPath,
      `\n${completedTurn(99).map((value) => JSON.stringify(value)).join("\n")}\n`,
    );
    const state = new DesktopState(databasePath);

    const latest = state.request("desktopState/readThread", {
      threadId: "thread-1",
      history: { limitTurns: 8, maxBytes: 2 * 1024 * 1024 },
    }) as any;

    expect(latest.thread.turns.map((turn: any) => turn.id)).toEqual(["turn-99"]);
    expect(latest.history).toMatchObject({ hasMoreBefore: true });
    state.close();
  });

  it.each([true, false])("preserves repeated user messages across a large turn with a mid-turn context record (explicit metadata: %s)", (withMetadata) => {
    const { databasePath, rolloutPath } = fixture();
    const message = (id: string, role: string, text: string) => ({
      type: "response_item",
      payload: {
        type: "message", id, role,
        content: [{ type: role === "user" ? "input_text" : "output_text", text }],
        ...(withMetadata ? { internal_chat_message_metadata_passthrough: { turn_id: "turn-long" } } : {}),
      },
    });
    writeFileSync(rolloutPath, [
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-long" } },
      message("user-first", "user", "继续"),
    ].map((value) => JSON.stringify(value)).join("\n") + "\n");
    const desktop = new DesktopState(databasePath);
    try {
      const known = hydrateThread(initialCodexState, desktop.request("desktopState/readThread", { threadId: "thread-1" }));
      appendFileSync(rolloutPath, [
        { type: "diagnostic", payload: { text: "x".repeat(96 * 1024) } },
        message("agent-middle", "assistant", "工具执行后的中间回复"),
        message("user-middle", "user", "补充要求"),
        { type: "turn_context", payload: { turn_id: "turn-long" } },
        message("user-second", "user", "继续"),
        message("agent-final", "assistant", "最终回复"),
        { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-long" } },
      ].map((value) => JSON.stringify(value)).join("\n") + "\n");
      const latest = desktop.request("desktopState/readThread", {
        threadId: "thread-1", history: { limitTurns: 8, maxBytes: 64 * 1024 },
      }) as any;
      expect(latest.thread.turns[0].completeFromTurnStart).not.toBe(true);
      expect(latest.thread.turns[0].items.map((item: any) => item.id)).toEqual([
        "agent-middle", "user-middle", "user-second", "agent-final",
      ]);
      const recovered = hydrateThread(known, latest, "append");
      const turn = recovered.threads["thread-1"].turns["turn-long"];
      expect(turn.itemOrder).toEqual(["user-first", "agent-middle", "user-middle", "user-second", "agent-final"]);

      const earlier = desktop.request("desktopState/readThread", {
        threadId: "thread-1",
        history: { beforeCursor: latest.history.beforeCursor, limitTurns: 8, maxBytes: 64 * 1024 },
      }) as any;
      expect(earlier.thread.turns[0].completeFromTurnStart).toBe(true);
      const all = hydrateThread(recovered, earlier, "prepend");
      expect(all.threads["thread-1"].turns["turn-long"].itemOrder).toEqual(turn.itemOrder);
      expect(earlier.history).toEqual({ hasMoreBefore: false });
    } finally { desktop.close(); }
  });

  it.each(["task_started", "different_context"])("does not carry an anonymous history prefix across %s", (boundary) => {
    const { databasePath, rolloutPath } = fixture();
    writeFileSync(rolloutPath, [
      { type: "response_item", payload: {
        type: "message", id: "unassigned-user", role: "user",
        content: [{ type: "input_text", text: "旧轮消息" }],
      } },
      { type: "turn_context", payload: { turn_id: boundary === "task_started" ? "next" : "previous" } },
      boundary === "task_started"
        ? { type: "event_msg", payload: { type: "task_started", turn_id: "next" } }
        : { type: "turn_context", payload: { turn_id: "next" } },
      { type: "response_item", payload: {
        type: "message", id: "next-user", role: "user",
        content: [{ type: "input_text", text: "新轮消息" }],
      } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "next" } },
    ].map((value) => JSON.stringify(value)).join("\n") + "\n");
    const desktop = new DesktopState(databasePath);
    try {
      const result = desktop.request("desktopState/readThread", { threadId: "thread-1" }) as any;
      expect(result.thread.turns).toEqual([expect.objectContaining({
        id: "next", items: [expect.objectContaining({ id: "next-user" })],
      })]);
    } finally { desktop.close(); }
  });

  it("does not certify a context-only history fragment as a complete turn", () => {
    const { databasePath, rolloutPath } = fixture();
    writeFileSync(rolloutPath, [
      { type: "turn_context", payload: { turn_id: "turn-1" } },
      { type: "response_item", payload: {
        type: "message", id: "user-fragment", role: "user",
        content: [{ type: "input_text", text: "继续" }],
      } },
    ].map((value) => JSON.stringify(value)).join("\n") + "\n");
    const desktop = new DesktopState(databasePath);
    try {
      const result = desktop.request("desktopState/readThread", { threadId: "thread-1" }) as any;
      expect(result.thread.turns[0].items[0].id).toBe("user-fragment");
      expect(result.thread.turns[0].completeFromTurnStart).not.toBe(true);
    } finally { desktop.close(); }
  });

  it.each([
    { ending: undefined, status: "inProgress", threadStatus: "active" },
    { ending: "task_complete", status: "completed", threadStatus: "idle" },
    { ending: "turn_aborted", status: "interrupted", threadStatus: "idle" },
  ])("keeps an empty turn with a known task start through $status", ({ ending, status, threadStatus }) => {
    const { databasePath, rolloutPath } = fixture();
    writeFileSync(rolloutPath, [
      { type: "event_msg", payload: { type: "task_started", turn_id: "empty-turn" } },
      ...(ending ? [{ type: "event_msg", payload: { type: ending, turn_id: "empty-turn" } }] : []),
    ].map((value) => JSON.stringify(value)).join("\n") + "\n");
    const desktop = new DesktopState(databasePath);
    try {
      expect(desktop.request("desktopState/readThread", { threadId: "thread-1", history: {} }))
        .toMatchObject({ thread: { status: { type: threadStatus }, turns: [{
          id: "empty-turn", status, completeFromTurnStart: true, items: [],
        }] } });
    } finally { desktop.close(); }
  });

  it("skips oversized non-conversation records while loading the previous page", () => {
    const { databasePath, rolloutPath } = fixture();
    writeFileSync(
      rolloutPath,
      `${completedTurn(1).map((value) => JSON.stringify(value)).join("\n")}\n` +
      `${"x".repeat(3 * 1024 * 1024)}\n` +
      `${completedTurn(2).map((value) => JSON.stringify(value)).join("\n")}\n`,
    );
    const state = new DesktopState(databasePath);
    const latest = state.request("desktopState/readThread", {
      threadId: "thread-1",
      history: { limitTurns: 8, maxBytes: 2 * 1024 * 1024 },
    }) as any;

    const older = state.request("desktopState/readThread", {
      threadId: "thread-1",
      history: {
        beforeCursor: latest.history.beforeCursor,
        limitTurns: 8,
        maxBytes: 2 * 1024 * 1024,
      },
    }) as any;

    expect(latest.thread.turns.map((turn: any) => turn.id)).toEqual(["turn-2"]);
    expect(older.thread.turns.map((turn: any) => turn.id)).toEqual(["turn-1"]);
    expect(older.history).toEqual({ hasMoreBefore: false });
    state.close();
  });

  it.each([3, 14, 56])("pages a %i MiB image record without losing the user or adjacent turns", (sizeMiB) => {
    const { databasePath, rolloutPath } = fixture();
    const uploadRoot = join(dirname(databasePath), "codex-remote", "uploads");
    mkdirSync(uploadRoot, { recursive: true });
    const imageCount = sizeMiB === 56 ? 4 : 1;
    const imageIds = Array.from({ length: imageCount }, (_, i) => `d6465fe8-f5f2-46af-809f-268f937a8d6${i}`);
    for (const id of imageIds) writeFileSync(join(uploadRoot, `${id}.png`), Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64",
    ));
    appendFileSync(rolloutPath, JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "turn-images" } }) + "\n");
    appendFileSync(rolloutPath, '{"type":"response_item","payload":{"type":"message","id":"large-user","role":"user","content":[');
    for (const [index, id] of imageIds.entries()) {
      if (index) appendFileSync(rolloutPath, ",");
      appendFileSync(rolloutPath, JSON.stringify({ type: "input_text", text: `${index === 0 ? 'data:image/png;base64,literal \\"quoted\\" 中文\n' : ''}<image name=[Image #${index + 1}] path="${join(uploadRoot, `${id}.png`)}">` }) + ',{"type":"ignored_image","image_url":"data:image/png;base64,');
      const chunk = "A".repeat(128 * 1024);
      for (let i = 0; i < sizeMiB * 8 / imageCount; i++) appendFileSync(rolloutPath, chunk);
      appendFileSync(rolloutPath, '"},' + JSON.stringify({ type: "input_text", text: "</image>" }));
    }
    appendFileSync(rolloutPath, '],"internal_chat_message_metadata_passthrough":{"turn_id":"turn-images"}}}\n');
    appendFileSync(rolloutPath, [
      { type: "response_item", payload: { type: "message", id: "image-reply", role: "assistant", content: [{ type: "output_text", text: "Recognized images" }] } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-images" } },
      ...completedTurn(2),
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const state = new DesktopState(databasePath);
    try {
      const pages: any[] = [];
      let beforeCursor: string | undefined;
      for (let count = 0; count < 10; count++) {
        const page = state.request("desktopState/readThread", { threadId: "thread-1", history: { beforeCursor } }) as any;
        pages.push(page);
        if (!page.history.hasMoreBefore) break;
        const next = page.history.beforeCursor;
        if (beforeCursor !== undefined) expect(Number(next)).toBeLessThan(Number(beforeCursor));
        beforeCursor = next;
      }
      expect(pages.at(-1).history.hasMoreBefore).toBe(false);
      const turns = pages.flatMap((page) => page.thread.turns);
      const images = turns.filter((turn) => turn.id === "turn-images").flatMap((turn) => turn.items);
      expect(images.find((item) => item.id === "large-user")).toMatchObject({
        text: 'data:image/png;base64,literal \\"quoted\\" 中文', imageIds,
      });
      expect(images.filter((item) => item.id === "large-user")).toHaveLength(1);
      expect(turns.some((turn) => turn.id === "turn-1")).toBe(true);
      expect(turns.some((turn) => turn.id === "turn-2")).toBe(true);
      expect(JSON.stringify(pages).length).toBeLessThan(30_000);
    } finally { state.close(); }
  });

  it.each([true, false])("preserves adjacent large image records without per-message metadata (separate turns: %s)", (separateTurns) => {
    const { databasePath, rolloutPath } = fixture();
    for (const index of [3, 4]) appendFileSync(rolloutPath, [
      ...(index === 3 || separateTurns ? [{ type: "event_msg", payload: { type: "task_started", turn_id: `turn-${index}` } }] : []),
      { type: "response_item", payload: { type: "message", id: `large-${index}`, role: "user", content: [
        { type: "input_text", text: `Prompt ${index}` },
        { type: "ignored_image", image_url: `data:image/png;base64,${"A".repeat(3 * 1024 * 1024)}` },
      ] } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const state = new DesktopState(databasePath);
    try {
      let beforeCursor: string | undefined;
      const turns: any[] = [];
      for (let index = 0; index < 5; index++) {
        const page = state.request("desktopState/readThread", { threadId: "thread-1", history: { beforeCursor } }) as any;
        turns.unshift(...page.thread.turns);
        if (!page.history.hasMoreBefore) break;
        if (beforeCursor) expect(Number(page.history.beforeCursor)).toBeLessThan(Number(beforeCursor));
        beforeCursor = page.history.beforeCursor;
      }
      expect(turns.map((turn) => turn.id)).toEqual(separateTurns ? ["turn-1", "turn-3", "turn-4"] : ["turn-1", "turn-3"]);
      expect(turns.slice(1).flatMap((turn) => turn.items.map((item: any) => item.text))).toEqual(["Prompt 3", "Prompt 4"]);
      expect(turns.every((turn) => turn.completeFromTurnStart === true)).toBe(true);
    } finally { state.close(); }
  });

  it.each(["same-turn", "turn_context", "task_started"])("preserves anonymous assistant text between image records across %s", (boundary) => {
    const { databasePath, rolloutPath } = fixture();
    const secondTurn = boundary === "same-turn" ? "turn-a" : "turn-b";
    const image = (id: string, turnId: string) => ({ type: "response_item", payload: {
      type: "message", id, role: "user",
      content: [{ type: "input_text", text: id }, { type: "ignored_image", image_url: `data:image/png;base64,${"A".repeat(3 * 1024 * 1024)}` }],
      internal_chat_message_metadata_passthrough: { turn_id: turnId },
    } });
    const assistant = (id: string) => ({ type: "response_item", payload: {
      type: "message", id, role: "assistant", content: [{ type: "output_text", text: id }],
    } });
    writeFileSync(rolloutPath, [
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-a" } },
      image("user-first", "turn-a"),
      assistant("assistant-middle"),
      ...(boundary === "same-turn" ? [] : [boundary === "turn_context"
        ? { type: "turn_context", payload: { turn_id: secondTurn } }
        : { type: "event_msg", payload: { type: "task_started", turn_id: secondTurn } }]),
      image("user-steer", secondTurn),
      assistant("assistant-final"),
      { type: "event_msg", payload: { type: "task_complete", turn_id: secondTurn } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    const state = new DesktopState(databasePath);
    try {
      let beforeCursor: string | undefined;
      const pages: any[] = [];
      for (let index = 0; index < 10; index++) {
        const page = state.request("desktopState/readThread", { threadId: "thread-1", history: { beforeCursor } }) as any;
        pages.unshift(page);
        if (!page.history.hasMoreBefore) break;
        if (beforeCursor) expect(Number(page.history.beforeCursor)).toBeLessThan(Number(beforeCursor));
        beforeCursor = page.history.beforeCursor;
      }
      expect(pages[0].history.hasMoreBefore).toBe(false);
      const items = pages.flatMap((page) => page.thread.turns.flatMap((turn: any) => turn.items.map((item: any) => ({ id: item.id, turnId: turn.id }))));
      expect(items).toEqual([
        { id: "user-first", turnId: "turn-a" },
        { id: "assistant-middle", turnId: "turn-a" },
        { id: "user-steer", turnId: secondTurn },
        { id: "assistant-final", turnId: secondTurn },
      ]);
    } finally { state.close(); }
  });

  it.each([true, false])("pages consecutive legal image records beyond 64 MiB exactly once (user metadata: %s)", (withMetadata) => {
    const { databasePath, rolloutPath } = fixture();
    writeFileSync(rolloutPath, JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "images" } }) + "\n");
    const chunk = "A".repeat(128 * 1024);
    for (const index of [1, 2]) {
      appendFileSync(rolloutPath, `{"type":"response_item","payload":{"type":"message","id":"user-${index}","role":"user","content":[`);
      // Three 9.75 MiB decoded attachments are within the upload limits.
      for (let image = 0; image < 3; image++) {
        if (image) appendFileSync(rolloutPath, ",");
        appendFileSync(rolloutPath, '{"type":"ignored_image","image_url":"data:image/png;base64,');
        for (let part = 0; part < 13 * 8; part++) appendFileSync(rolloutPath, chunk);
        appendFileSync(rolloutPath, '"}');
      }
      appendFileSync(rolloutPath, `,{"type":"input_text","text":"prompt-${index}"}]${withMetadata ? ',"internal_chat_message_metadata_passthrough":{"turn_id":"images"}' : ''}}}\n`);
      appendFileSync(rolloutPath, JSON.stringify({ type: "response_item", payload: {
        type: "message", id: `assistant-${index}`, role: "assistant",
        content: [{ type: "output_text", text: `answer-${index}` }],
      } }) + "\n");
    }
    appendFileSync(rolloutPath, JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "images" } }) + "\n");
    const state = new DesktopState(databasePath);
    try {
      let beforeCursor: string | undefined;
      const pages: any[] = [];
      for (let index = 0; index < 10; index++) {
        const page = state.request("desktopState/readThread", { threadId: "thread-1", history: { beforeCursor } }) as any;
        pages.unshift(page);
        if (!page.history.hasMoreBefore) break;
        if (beforeCursor) expect(Number(page.history.beforeCursor)).toBeLessThan(Number(beforeCursor));
        beforeCursor = page.history.beforeCursor;
      }
      expect(pages[0].history.hasMoreBefore).toBe(false);
      const items = pages.flatMap((page) => page.thread.turns.flatMap((turn: any) =>
        turn.items.map((item: any) => ({ id: item.id, text: item.text, turnId: turn.id }))));
      expect(items).toEqual([
        { id: "user-1", text: "prompt-1", turnId: "images" },
        { id: "assistant-1", text: "answer-1", turnId: "images" },
        { id: "user-2", text: "prompt-2", turnId: "images" },
        { id: "assistant-2", text: "answer-2", turnId: "images" },
      ]);
      expect(pages[0].thread.turns[0].completeFromTurnStart).toBe(true);
      expect(JSON.stringify(pages).length).toBeLessThan(10_000);
    } finally { state.close(); }
  });

  it.each([
    { budget: "record count", count: 9, imageCount: 1, imageMiB: 3, textKiB: 0 },
    { budget: "pending projection", count: 7, imageCount: 1, imageMiB: 3, textKiB: 350 },
    { budget: "total reads", count: 4, imageCount: 3, imageMiB: 13, textKiB: 0 },
  ])("reports an oversized unresolved history page without consuming its cursor ($budget)", ({ count, imageCount, imageMiB, textKiB }) => {
    const { databasePath, rolloutPath } = fixture();
    writeFileSync(rolloutPath, JSON.stringify({ type: "event_msg", payload: { type: "task_started", turn_id: "images" } }) + "\n");
    for (let index = 1; index <= count; index++) appendFileSync(rolloutPath, [
      { type: "response_item", payload: { type: "message", id: `user-${index}`, role: "user", content: [
        ...Array.from({ length: imageCount }, () => ({ type: "ignored_image", image_url: `data:image/png;base64,${"A".repeat(imageMiB * 1024 * 1024)}` })),
        { type: "input_text", text: `prompt-${index}${"t".repeat(textKiB * 1024)}` },
      ] } },
      { type: "response_item", payload: { type: "message", id: `assistant-${index}`, role: "assistant", content: [
        { type: "output_text", text: `answer-${index}` },
      ] } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    appendFileSync(rolloutPath, JSON.stringify({ type: "event_msg", payload: { type: "task_complete", turn_id: "images" } }) + "\n");
    const state = new DesktopState(databasePath);
    try {
      const latest = state.request("desktopState/readThread", { threadId: "thread-1", history: {} }) as any;
      expect(latest.thread.turns[0].items.map((item: any) => item.id)).toEqual([`assistant-${count}`]);
      const beforeCursor = latest.history.beforeCursor;
      for (let retry = 0; retry < 2; retry++) {
        expect(() => state.request("desktopState/readThread", {
          threadId: "thread-1", history: { beforeCursor },
        })).toThrow(/History page is too large.*cursor was not advanced/);
      }
      const again = state.request("desktopState/readThread", { threadId: "thread-1", history: {} }) as any;
      expect(again.history.beforeCursor).toBe(beforeCursor);
      expect(again.thread.turns).toEqual(latest.thread.turns);
    } finally { state.close(); }
  });

  it.each([3, 70])("bounds a %i MiB unprojectable record and does not certify a truncated turn", (sizeMiB) => {
    const { databasePath, rolloutPath } = fixture();
    appendFileSync(rolloutPath, [
      { type: "event_msg", payload: { type: "task_started", turn_id: "truncated" } },
      { type: "response_item", payload: { type: "message", id: "before-overflow", role: "user", content: [{ type: "input_text", text: "Kept prefix" }] } },
    ].map((entry) => JSON.stringify(entry)).join("\n") + "\n");
    appendFileSync(rolloutPath, '{"type":"response_item","payload":{"type":"message","id":"oversized-text","role":"user","content":[{"type":"input_text","text":"');
    const chunk = "A".repeat(128 * 1024);
    for (let index = 0; index < sizeMiB * 8; index++) appendFileSync(rolloutPath, chunk);
    appendFileSync(rolloutPath, '"}]}}\n');
    const state = new DesktopState(databasePath);
    try {
      for (let retry = 0; retry < 2; retry++) {
        expect(() => state.request("desktopState/readThread", { threadId: "thread-1", history: {} }))
          .toThrow(/too large.*cursor was not advanced/);
      }
    } finally { state.close(); }
  });

  it("tracks Desktop running status from appended rollout events", () => {
    const { databasePath, rolloutPath } = fixture();
    const state = new DesktopState(databasePath);
    expect((state.request("desktopState/listThreads", {}) as any).data[0].status).toEqual({ type: "idle" });

    appendFileSync(rolloutPath, `${JSON.stringify({
      type: "event_msg",
      payload: { type: "task_started", turn_id: "turn-2" },
    })}\n`);
    expect((state.request("desktopState/listThreads", {}) as any).data[0].status).toEqual({ type: "active" });

    appendFileSync(rolloutPath, `${JSON.stringify({
      type: "response_item",
      payload: { type: "message", id: "agent-2", role: "assistant", content: [] },
    })}\n`);
    expect((state.request("desktopState/listThreads", {}) as any).data[0].status).toEqual({ type: "active" });

    appendFileSync(rolloutPath, `${JSON.stringify({
      type: "event_msg",
      payload: { type: "task_complete", turn_id: "turn-2" },
    })}\n`);
    expect((state.request("desktopState/listThreads", {}) as any).data[0].status).toEqual({ type: "idle" });
    state.close();
  });

  it("does not rescan an entire recent rollout when its bounded tail has no status event", () => {
    const { databasePath, rolloutPath } = fixture();
    writeFileSync(rolloutPath, `${JSON.stringify({
      type: "event_msg",
      payload: { type: "task_started", turn_id: "turn-large" },
    })}\n`);
    truncateSync(rolloutPath, 8 * 1024 * 1024);
    appendFileSync(rolloutPath, `\n${JSON.stringify({
      type: "response_item",
      payload: { type: "message", id: "agent-large", role: "assistant", content: [] },
    })}\n`);
    const state = new DesktopState(databasePath);

    expect((state.request("desktopState/listThreads", {}) as any).data[0].status)
      .toEqual({ type: "unknown" });
    state.close();
  });

  it("loads the latest bounded page instead of rejecting a very large rollout", () => {
    const { databasePath, rolloutPath } = fixture();
    truncateSync(rolloutPath, 70 * 1024 * 1024);
    appendFileSync(
      rolloutPath,
      `\n${completedTurn(2).map((value) => JSON.stringify(value)).join("\n")}\n`,
    );
    const state = new DesktopState(databasePath);

    const result = state.request("desktopState/readThread", { threadId: "thread-1" }) as any;
    expect(result.thread.turns.map((turn: any) => turn.id)).toEqual(["turn-2"]);
    expect(result.history).toEqual({ hasMoreBefore: true, beforeCursor: expect.any(String) });
    state.close();
  });

  it("bounds an unresolved sparse rollout with an explicit error instead of advancing past an unreadable record", () => {
    const { databasePath, rolloutPath } = fixture();
    truncateSync(rolloutPath, 70 * 1024 * 1024);
    const state = new DesktopState(databasePath);

    expect(() => state.request("desktopState/readThread", { threadId: "thread-1" }))
      .toThrow(/too large.*cursor was not advanced/);
    state.close();
  });
});
