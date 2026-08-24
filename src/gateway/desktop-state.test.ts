// @vitest-environment node

import { appendFileSync, mkdirSync, mkdtempSync, truncateSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { DesktopState } from "./desktop-state";

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
    thread_source TEXT
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

describe("DesktopState", () => {
  it("keeps archived and subagent threads out of the Desktop top-level task projection", () => {
    const { databasePath, rolloutPath } = fixture();
    const database = new DatabaseSync(databasePath);
    const insert = database.prepare(`INSERT INTO threads (
      id, rollout_path, archived, name, title, preview, cwd, is_pinned,
      sandbox_policy, approval_mode, updated_at_ms, recency_at_ms, thread_source
    ) VALUES (?, ?, ?, ?, ?, ?, ?, 0, ?, ?, ?, ?, ?)`);
    insert.run(
      "subagent-1", rolloutPath, 0, null, "", "", "/code/app",
      '{"type":"disabled"}', "never", 44, 45, "subagent",
    );
    insert.run(
      "archived-1", rolloutPath, 1, "Archived task", "", "", "/code/app",
      '{"type":"disabled"}', "never", 46, 47, "user",
    );
    insert.run(
      "user-1", rolloutPath, 0, "Visible user task", "", "", "/code/app",
      '{"type":"disabled"}', "never", 48, 49, "user",
    );
    database.close();
    const state = new DesktopState(databasePath);

    expect(state.request("desktopState/listThreads", {})).toEqual({
      data: [
        expect.objectContaining({ id: "thread-1", title: "Desktop title" }),
        expect.objectContaining({ id: "user-1", title: "Visible user task" }),
      ],
    });
    expect(state.request("desktopState/listThreadMetadata", {
      threadIds: ["thread-1", "user-1", "subagent-1", "archived-1"],
    })).toEqual({ data: [
      expect.objectContaining({ id: "thread-1" }),
      expect.objectContaining({ id: "user-1" }),
    ] });
    expect((state.request("desktopState/readThread", { threadId: "user-1" }) as any).thread.id)
      .toBe("user-1");
    expect(() => state.request("desktopState/readThread", { threadId: "subagent-1" }))
      .toThrow("Desktop thread not found");
    expect(() => state.request("desktopState/readThread", { threadId: "archived-1" }))
      .toThrow("Desktop thread not found");
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
        { id: "agent-1", type: "agentMessage", text: "Hello Web" },
      ],
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
    expect(latest.history).toMatchObject({ hasMoreBefore: true });
    expect(latest.history.beforeCursor).toEqual(expect.any(String));

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
});
