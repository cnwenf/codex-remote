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

  it("replaces a visible Desktop assistant message and reuses its persisted item", () => {
    const started = reduceCodexState(initialCodexState, {
      method: "turn/started",
      params: { threadId: "t1", turn: { id: "turn-1" } },
    });
    const live = reduceCodexState(started, {
      method: "desktop/visibleAgentMessage",
      params: {
        threadId: "t1",
        turnId: "turn-1",
        itemId: "agent-1",
        text: "Immediate Desktop text",
      },
    });

    expect(live.threads.t1.turns["turn-1"].items["agent-1"]).toMatchObject({
      type: "agentMessage",
      text: "Immediate Desktop text",
      status: "running",
    });

    const persisted = reduceCodexState(live, {
      method: "item/completed",
      params: {
        threadId: "t1",
        turnId: "turn-1",
        item: {
          id: "agent-1",
          type: "agentMessage",
          text: "Immediate Desktop text",
          status: "completed",
        },
      },
    });

    expect(persisted.threads.t1.turns["turn-1"].itemOrder).toEqual(["agent-1"]);
    expect(persisted.threads.t1.turns["turn-1"].items["agent-1"].status).toBe("completed");

    const completed = reduceCodexState(persisted, {
      method: "turn/completed",
      params: { threadId: "t1", turn: { id: "turn-1", status: "completed" } },
    });
    const lateDomUpdate = reduceCodexState(completed, {
      method: "desktop/visibleAgentMessage",
      params: {
        threadId: "t1",
        turnId: "turn-1",
        itemId: "agent-1",
        text: "Immediate Desktop text with final punctuation.",
      },
    });
    expect(lateDomUpdate.threads.t1.status).toBe("idle");
    expect(lateDomUpdate.threads.t1.turns["turn-1"].status).toBe("completed");
    expect(lateDomUpdate.threads.t1.turns["turn-1"].items["agent-1"].status).toBe("completed");
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

  it("replaces an optimistic steer when Desktop confirms it in another turn and type spelling", () => {
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
        turnId: "turn-2",
        item: {
          id: "desktop-user-1",
          type: "user_message",
          content: [{ type: "text", text: "Check this image" }],
        },
      },
    });
    const originalTurn = next.threads.t1.turns["turn-1"];
    const authoritativeTurn = next.threads.t1.turns["turn-2"];

    expect(originalTurn.itemOrder).toEqual(["agent-before"]);
    expect(originalTurn.items["web-steer-1"]).toBeUndefined();
    expect(authoritativeTurn.itemOrder).toEqual(["desktop-user-1"]);
    expect(authoritativeTurn.items["desktop-user-1"]).toMatchObject({
      id: "desktop-user-1",
      type: "user_message",
      text: "Check this image",
      imageIds: ["uploaded-image"],
    });
  });

  it("replaces an optimistic image steer when Desktop appends attachment markup", () => {
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
              itemOrder: ["web-steer-image"],
              items: {
                "web-steer-image": {
                  id: "web-steer-image",
                  type: "userMessage",
                  text: "调整移动端标题布局",
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
        turnId: "turn-2",
        item: {
          id: "desktop-user-image",
          type: "user_message",
          content: [{
            type: "text",
            text: "调整移动端标题布局\n<image name=[Image #1] path=\"/private/upload.jpg\">\n</image>",
          }],
        },
      },
    });

    expect(next.threads.t1.turns["turn-1"].items["web-steer-image"]).toBeUndefined();
    expect(next.threads.t1.turns["turn-2"].items["desktop-user-image"]).toMatchObject({
      text: expect.stringContaining("调整移动端标题布局"),
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
