import readline from "node:readline";

const lines = readline.createInterface({ input: process.stdin });
let createdThread;
const loadedThreads = new Set();
const pinnedThreads = new Set();
const pinnedSection = { id: "fixture-pinned-section", name: "Pinned", appearance: null };

lines.on("line", (line) => {
  const message = JSON.parse(line);
  if (message.method === "initialize") {
    send({ id: message.id, result: { ready: true } });
    return;
  }
  if (message.method === "thread/list") {
    const threads = listThreads();
    const data = message.params && Object.hasOwn(message.params, "sectionId")
      ? threads.filter((thread) => message.params.sectionId === pinnedSection.id
        ? thread.section?.id === pinnedSection.id
        : !thread.section)
      : threads;
    send({ id: message.id, result: { data } });
    return;
  }
  if (message.method === "threadSection/list") {
    send({ id: message.id, result: { data: [pinnedSection], nextCursor: null } });
    return;
  }
  if (message.method === "threadSection/create") {
    send({ id: message.id, result: { section: pinnedSection } });
    return;
  }
  if (message.method === "thread/section/move") {
    if (message.params?.sectionId === pinnedSection.id) pinnedThreads.add(message.params.threadId);
    else pinnedThreads.delete(message.params?.threadId);
    send({ id: message.id, result: {} });
    return;
  }
  if (message.method === "model/list") {
    send({
      id: message.id,
      result: {
        data: [{
          id: "gpt-fixture",
          model: "gpt-fixture",
          displayName: "GPT Fixture",
          hidden: false,
          isDefault: true,
          defaultReasoningEffort: "medium",
          supportedReasoningEfforts: [
            { reasoningEffort: "low", description: "Fast" },
            { reasoningEffort: "medium", description: "Balanced" },
            { reasoningEffort: "high", description: "Deep" },
          ],
        }],
      },
    });
    return;
  }
  if (message.method === "permissionProfile/list") {
    send({
      id: message.id,
      result: {
        data: [
          { id: ":read-only", description: null, allowed: true },
          { id: ":workspace", description: null, allowed: true },
          { id: ":danger-full-access", description: null, allowed: true },
        ],
      },
    });
    return;
  }
  if (message.method === "thread/resume") {
    const isFixture = message.params?.threadId === "fixture-thread";
    loadedThreads.add(message.params?.threadId);
    send({
      id: message.id,
      result: {
        thread: isFixture
          ? fixtureThreadWithTurns()
          : listThreads().find((thread) => thread.id === message.params?.threadId),
        model: "gpt-fixture",
        reasoningEffort: "medium",
        activePermissionProfile: { id: ":workspace" },
        approvalPolicy: "on-request",
        approvalsReviewer: "user",
        sandboxPolicy: { type: "workspaceWrite" },
      },
    });
    return;
  }
  if (message.method === "thread/start") {
    createdThread = {
      id: "new-fixture-thread",
      name: "New fixture conversation",
      cwd: message.params?.cwd ?? "/tmp/direct-conversation",
      status: { type: "idle" },
      updatedAt: 1_787_200_100,
      turns: [],
    };
    loadedThreads.add(createdThread.id);
    send({
      id: message.id,
      result: {
        thread: createdThread,
        model: message.params?.model,
        reasoningEffort: message.params?.config?.model_reasoning_effort,
      },
    });
    return;
  }
  if (message.method === "turn/start" || message.method === "turn/steer") {
    if (!loadedThreads.has(message.params?.threadId)) {
      send({ id: message.id, error: { code: -32000, message: "thread not loaded" } });
      return;
    }
    send({ id: message.id, result: { turn: { id: "fixture-live-turn" } } });
    send({
      method: "turn/started",
      params: { threadId: "fixture-thread", turn: { id: "fixture-live-turn" } },
    });
    if (message.method === "turn/start") {
      const text = message.params?.input?.find?.((item) => item.type === "text")?.text;
      if (text) {
        send({
          method: "item/started",
          params: {
            threadId: "fixture-thread",
            turnId: "fixture-live-turn",
            item: { id: "fixture-live-user", type: "userMessage", content: [{ type: "text", text }] },
          },
        });
      }
    }
    send({
      method: "item/started",
      params: {
        threadId: "fixture-thread",
        turnId: "fixture-live-turn",
        item: { id: "fixture-live-reason", type: "reasoning", summary: ["Running checks"] },
      },
    });
    send({
      method: "turn/plan/updated",
      params: {
        threadId: "fixture-thread",
        turnId: "fixture-live-turn",
        explanation: "Keep the fixture checklist current",
        plan: [
          { step: "Inspect fixture", status: "completed" },
          { step: "Run checks", status: "inProgress" },
          { step: "Review result", status: "pending" },
        ],
      },
    });
    send({
      method: "item/completed",
      params: {
        threadId: "fixture-thread",
        turnId: "fixture-live-turn",
        item: {
          id: "fixture-live-command",
          type: "commandExecution",
          command: "pnpm test",
          status: "completed",
        },
      },
    });
    send({
      method: "item/agentMessage/delta",
      params: {
        threadId: "fixture-thread",
        turnId: "fixture-live-turn",
        itemId: "fixture-agent",
        delta: "## Checks complete\n\n- All tests passed\n- Markdown rendered",
      },
    });
    send({
      method: "turn/diff/updated",
      params: {
        threadId: "fixture-thread",
        turnId: "fixture-live-turn",
        diff: "--- a/fixture.txt\n+++ b/fixture.txt\n@@ -1 +1 @@\n-before\n+after",
      },
    });
    send({
      id: "fixture-approval",
      method: "item/commandExecution/requestApproval",
      params: { command: "pnpm test", cwd: "/tmp/codex-fixture" },
    });
    return;
  }
  if (message.id === "fixture-approval" && message.result?.decision === "decline") {
    send({
      method: "item/agentMessage/delta",
      params: {
        threadId: "fixture-thread",
        turnId: "fixture-live-turn",
        itemId: "fixture-denied",
        delta: "Request denied",
      },
    });
  }
});

function listThreads() {
  const fixture = {
    id: "fixture-thread",
    name: "Fixture task",
    cwd: "/tmp/codex-fixture",
    status: { type: "idle" },
    updatedAt: 1_787_200_000,
  };
  const extras = Array.from({ length: 17 }, (_, index) => ({
    id: `fixture-extra-${index}`,
    name: `Fixture conversation ${String(index + 1).padStart(2, "0")}`,
    cwd: index % 2 === 0 ? "/tmp/codex-fixture" : "/tmp/second-project",
    status: { type: index === 2 ? "active" : "idle", activeFlags: [] },
    updatedAt: 1_787_199_999 - index,
  }));
  return [createdThread, fixture, ...extras].filter(Boolean).map((thread) => ({
    ...thread,
    section: pinnedThreads.has(thread.id) ? pinnedSection : null,
    sectionEnteredAt: pinnedThreads.has(thread.id) ? 1_787_200_200 : null,
  }));
}

function fixtureThreadWithTurns() {
  const firstTurn = {
    id: "fixture-history-turn",
    status: "completed",
    durationMs: 4_200,
    startedAt: 1_787_199_000,
    completedAt: 1_787_199_004,
    items: [
      { id: "history-user", type: "userMessage", content: [{ type: "text", text: "Inspect the fixture" }] },
      { id: "history-reason", type: "reasoning", summary: ["Inspecting the repository"], content: [] },
      { id: "history-command", type: "commandExecution", command: "pnpm test", status: "completed" },
      { id: "history-agent", type: "agentMessage", text: "Initial inspection complete" },
    ],
  };
  const longTurns = Array.from({ length: 10 }, (_, index) => ({
    id: `fixture-history-${index}`,
    status: "completed",
    durationMs: 1_500 + index,
    items: [
      {
        id: `user-${index}`,
        type: "userMessage",
        content: [{ type: "text", text: `Follow-up instruction ${index + 1}` }],
      },
      {
        id: `agent-${index}`,
        type: "agentMessage",
        text: `Completed follow-up ${index + 1}. This response is intentionally long enough to exercise the independent mobile conversation scroller.`,
      },
    ],
  }));
  return {
    id: "fixture-thread",
    name: "Fixture task",
    cwd: "/tmp/codex-fixture",
    status: { type: "idle" },
    updatedAt: 1_787_200_000,
    turns: [firstTurn, ...longTurns],
  };
}

function send(message) {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}
