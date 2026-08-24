import { describe, expect, it } from "vitest";
import { initialCodexState, reduceCodexState } from "./thread-store";

describe("reduceCodexState", () => {
  it("appends streamed agent text without mutating the previous state", () => {
    const state = {
      ...initialCodexState,
      threads: {
        t1: {
          id: "t1",
          title: "Task one",
          status: "running" as const,
          turnOrder: ["turn-1"],
          turns: {
            "turn-1": {
              id: "turn-1",
              status: "inProgress" as const,
              itemOrder: ["i1"],
              items: {
                i1: { id: "i1", type: "agentMessage", text: "hello" },
              },
            },
          },
        },
      },
      threadOrder: ["t1"],
    };

    const next = reduceCodexState(state, {
      method: "item/agentMessage/delta",
      params: { threadId: "t1", turnId: "turn-1", itemId: "i1", delta: " world" },
    });

    expect(next.threads.t1.turns["turn-1"].items.i1.text).toBe("hello world");
    expect(state.threads.t1.turns["turn-1"].items.i1.text).toBe("hello");
  });

  it("creates a streamed item inside its server turn when the start notification was missed", () => {
    const next = reduceCodexState(initialCodexState, {
      method: "item/agentMessage/delta",
      params: { threadId: "t1", turnId: "turn-1", itemId: "i1", delta: "hello" },
    });

    expect(next.threadOrder).toEqual(["t1"]);
    expect(next.threads.t1.turnOrder).toEqual(["turn-1"]);
    expect(next.threads.t1.turns["turn-1"].itemOrder).toEqual(["i1"]);
    expect(next.threads.t1.turns["turn-1"].items.i1.text).toBe("hello");
  });

  it("keeps live items from separate turns separated", () => {
    const first = reduceCodexState(initialCodexState, {
      method: "item/started",
      params: {
        threadId: "t1",
        turnId: "turn-1",
        item: { id: "user-1", type: "userMessage", content: [{ type: "text", text: "First" }] },
      },
    });
    const second = reduceCodexState(first, {
      method: "item/started",
      params: {
        threadId: "t1",
        turnId: "turn-2",
        item: { id: "user-2", type: "userMessage", content: [{ type: "text", text: "Second" }] },
      },
    });

    expect(second.threads.t1.turnOrder).toEqual(["turn-1", "turn-2"]);
    expect(second.threads.t1.turns["turn-1"].items["user-1"].text).toBe("First");
    expect(second.threads.t1.turns["turn-2"].items["user-2"].text).toBe("Second");
  });

  it("replaces one optimistic steer with the authoritative live user message", () => {
    const state = {
      ...initialCodexState,
      threadOrder: ["t1"],
      threads: {
        t1: {
          id: "t1",
          title: "Live task",
          status: "running" as const,
          activeTurnId: "turn-1",
          turnOrder: ["turn-1"],
          turns: {
            "turn-1": {
              id: "turn-1",
              status: "inProgress" as const,
              itemOrder: ["agent-before", "web-steer-1"],
              items: {
                "agent-before": {
                  id: "agent-before",
                  type: "agentMessage",
                  text: "Still working",
                },
                "web-steer-1": {
                  id: "web-steer-1",
                  type: "userMessage",
                  text: "Check this image",
                  imageIds: ["uploaded-image"],
                  status: "completed",
                },
              },
            },
          },
        },
      },
    };

    const next = reduceCodexState(state, {
      method: "item/started",
      params: {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          id: "desktop-user-1",
          type: "userMessage",
          content: [{ type: "text", text: "Check this image" }],
        },
      },
    });
    const turn = next.threads.t1.turns["turn-1"];

    expect(turn.itemOrder).toEqual(["agent-before", "desktop-user-1"]);
    expect(turn.items["web-steer-1"]).toBeUndefined();
    expect(turn.items["desktop-user-1"]).toMatchObject({
      id: "desktop-user-1",
      type: "userMessage",
      text: "Check this image",
      imageIds: ["uploaded-image"],
    });
  });

  it("updates thread status from notifications", () => {
    const next = reduceCodexState(initialCodexState, {
      method: "thread/status/changed",
      params: { threadId: "t1", status: "idle" },
    });

    expect(next.threads.t1.status).toBe("idle");
  });

  it("keeps the latest Desktop todo list with normalized live statuses", () => {
    const next = reduceCodexState(initialCodexState, {
      method: "turn/plan/updated",
      params: {
        threadId: "t1",
        turnId: "turn-1",
        explanation: "Implementation plan",
        plan: [
          { step: "Inspect protocol", status: "completed" },
          { step: "Build UI", status: "in_progress" },
          { step: "Run tests", status: "pending" },
        ],
      },
    });

    expect(next.threads.t1.todoList).toEqual({
      turnId: "turn-1",
      explanation: "Implementation plan",
      items: [
        { step: "Inspect protocol", status: "completed" },
        { step: "Build UI", status: "inProgress" },
        { step: "Run tests", status: "pending" },
      ],
    });
  });

  it("aggregates command, plan, tool, file, and terminal event streams in their turn", () => {
    const notifications = [
      {
        method: "item/commandExecution/outputDelta",
        params: { threadId: "t1", turnId: "turn-1", itemId: "command", delta: "PASS\n" },
      },
      {
        method: "item/commandExecution/terminalInteraction",
        params: { threadId: "t1", turnId: "turn-1", itemId: "command", stdin: "y\n" },
      },
      {
        method: "item/plan/delta",
        params: { threadId: "t1", turnId: "turn-1", itemId: "plan", delta: "Run tests" },
      },
      {
        method: "item/mcpToolCall/progress",
        params: { threadId: "t1", turnId: "turn-1", itemId: "tool", message: "Searching" },
      },
      {
        method: "item/fileChange/patchUpdated",
        params: {
          threadId: "t1",
          turnId: "turn-1",
          itemId: "files",
          changes: [{ path: "src/app.ts", kind: "update" }, { path: "src/new.ts", kind: "add" }],
        },
      },
    ];

    const state = notifications.reduce(reduceCodexState, initialCodexState);
    const items = state.threads.t1.turns["turn-1"].items;
    expect(items.command).toMatchObject({
      type: "commandExecution",
      text: "PASS\n> y\n",
      status: "running",
    });
    expect(items.plan).toMatchObject({ type: "plan", text: "Run tests" });
    expect(items.tool).toMatchObject({ type: "mcpToolCall", text: "Searching" });
    expect(items.files).toMatchObject({
      type: "fileChange",
      text: "update src/app.ts\nadd src/new.ts",
    });
    expect(state.threads.t1.turns["turn-1"].itemOrder).toEqual([
      "command",
      "plan",
      "tool",
      "files",
    ]);
  });

  it("applies authoritative name and settings notifications", () => {
    const named = reduceCodexState(initialCodexState, {
      method: "thread/name/updated",
      params: { threadId: "t1", name: "Desktop title" },
    });
    const configured = reduceCodexState(named, {
      method: "thread/settings/updated",
      params: {
        threadId: "t1",
        threadSettings: {
          model: "gpt-5.6-sol",
          effort: "high",
          approvalPolicy: "never",
          approvalsReviewer: "user",
          sandboxPolicy: { type: "dangerFullAccess" },
          activePermissionProfile: null,
        },
      },
    });

    expect(configured.threads.t1).toMatchObject({
      title: "Desktop title",
      model: "gpt-5.6-sol",
      reasoningEffort: "high",
      permission: "full-access",
      approvalPolicy: "never",
      approvalsReviewer: "user",
      sandboxPolicy: { type: "dangerFullAccess" },
    });
  });

  it("distinguishes Desktop guardian approval from normal request approval", () => {
    const configured = reduceCodexState(initialCodexState, {
      method: "thread/settings/updated",
      params: {
        threadId: "t1",
        threadSettings: {
          approvalPolicy: "on-request",
          approvalsReviewer: "guardian_subagent",
          sandboxPolicy: { type: "workspaceWrite" },
          activePermissionProfile: { id: ":workspace" },
        },
      },
    });

    expect(configured.threads.t1).toMatchObject({
      permission: "guardian-approvals",
      permissionProfile: ":workspace",
      approvalPolicy: "on-request",
      approvalsReviewer: "guardian_subagent",
    });
  });
});
