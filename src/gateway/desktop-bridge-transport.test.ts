import { describe, expect, it, vi } from "vitest";
import type { RpcMessage } from "../protocol/types";
import { DesktopBridgeTransport, type DesktopBridgeClient } from "./desktop-bridge-transport";

class FakeBridgeClient implements DesktopBridgeClient {
  sent: unknown[] = [];
  ownerRequests: Array<{ method: string; params: unknown }> = [];
  queueBroadcasts: Array<{ conversationId: string; messages: unknown[] }> = [];
  queuePromotionResult = true;
  ownerRequestResult: unknown = { method: "thread-follower-update-thread-settings", result: { ok: true } };
  ownerRequestError?: Error;
  ownerRequestHandler?: (method: string, params: unknown) => Promise<unknown>;
  queueBroadcastError?: Error;
  startCalls = 0;
  startFailures = 0;
  onMessage?: (message: unknown) => void;
  onDisconnect?: (cause?: Error) => void;

  async start(onMessage: (message: unknown) => void, onDisconnect: () => void) {
    this.startCalls += 1;
    if (this.startFailures > 0) {
      this.startFailures -= 1;
      throw new Error("desktop-cdp-unavailable");
    }
    this.onMessage = onMessage;
    this.onDisconnect = onDisconnect;
  }

  async sendDesktopMessage(message: unknown) {
    this.sent.push(message);
  }

  async requestThreadOwner(method: string, params: unknown) {
    this.ownerRequests.push({ method, params });
    if (this.ownerRequestHandler) return this.ownerRequestHandler(method, params);
    if (this.ownerRequestError) throw this.ownerRequestError;
    return this.ownerRequestResult;
  }

  async broadcastQueuedFollowUps(conversationId: string, messages: unknown[]) {
    this.queueBroadcasts.push({ conversationId, messages });
    if (this.queueBroadcastError) throw this.queueBroadcastError;
  }

  async stop() {}
}

function asTestRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function createStartedTransport(overrides: {
  queueRecoveryRetryDelayMs?: number;
  queueRequestTimeoutMs?: number;
  queueRecoveryDeadlineMs?: number;
} = {}) {
  const client = new FakeBridgeClient();
  const messages: RpcMessage[] = [];
  const diagnostics: string[] = [];
  const transport = new DesktopBridgeTransport({
    client,
    appServerVersion: "0.148.0-alpha.15",
    appServerDisconnectGraceMs: 0,
    reconnectDelayMs: 0,
    queueRecoveryRetryDelayMs: 0,
    ...overrides,
  });
  return transport.start(
    (message) => messages.push(message),
    (diagnostic) => diagnostics.push(diagnostic.message),
  ).then(() => ({ client, messages, diagnostics, transport }));
}

describe("DesktopBridgeTransport", () => {
  it("starts read-only and reconnects when Desktop CDP is initially unavailable", async () => {
    const client = new FakeBridgeClient();
    client.startFailures = 1;
    const diagnostics: string[] = [];
    const transport = new DesktopBridgeTransport({
      client,
      appServerVersion: "0.148.0-alpha.15",
      reconnectDelayMs: 0,
    });

    await expect(transport.start(
      () => undefined,
      (diagnostic) => diagnostics.push(diagnostic.message),
    )).resolves.toBeUndefined();

    expect(transport.state).toBe("read-only");
    expect(diagnostics).toContain("Desktop bridge is unavailable; Desktop threads are read-only");
    await vi.waitFor(() => expect(client.startCalls).toBe(2));
    expect(transport.state).toBe("live");
    expect(diagnostics).toContain("Desktop bridge reconnected");
    await transport.stop();
  });

  it("sends client requests through Desktop's existing local host", async () => {
    const { client, transport } = await createStartedTransport();
    transport.send({ id: 3, method: "thread/list", params: { limit: 20 } });
    await vi.waitFor(() => expect(client.sent).toHaveLength(1));

    expect(client.sent[0]).toEqual({
      type: "mcp-request",
      request: { id: 3, method: "thread/list", params: { limit: 20 } },
      hostId: "local",
      priority: "interactive",
      source: "remote_control",
    });
    await transport.stop();
  });

  it("does not swallow a browser RPC id that resembles an internal queue confirmation id", async () => {
    const { client, messages, transport } = await createStartedTransport();
    const id = "codex-remote-queue-confirm-user-request";
    transport.send({ id, method: "thread/read", params: { threadId: "thread-1" } });
    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    client.onMessage?.({
      type: "mcp-response",
      hostId: "local",
      message: { id, result: { thread: { id: "thread-1" } } },
    });

    expect(messages).toContainEqual({ id, result: { thread: { id: "thread-1" } } });
    await transport.stop();
  });

  it("forwards local responses and ignores messages from another host", async () => {
    const { client, messages, transport } = await createStartedTransport();
    client.onMessage?.({
      type: "mcp-response",
      hostId: "remote-1",
      message: { id: 1, result: { wrong: true } },
    });
    client.onMessage?.({
      type: "mcp-response",
      hostId: "local",
      message: { id: 1, result: { ok: true } },
    });

    expect(messages).toEqual([{ id: 1, result: { ok: true } }]);
    await transport.stop();
  });

  it("forwards Desktop notifications as live App Server events", async () => {
    const { client, messages, transport } = await createStartedTransport();
    client.onMessage?.({
      type: "mcp-notification",
      hostId: "local",
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "agent-1",
        delta: "Live output",
      },
    });

    expect(messages).toEqual([{
      method: "item/agentMessage/delta",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "agent-1",
        delta: "Live output",
      },
    }]);
    await transport.stop();
  });

  it("forwards visible Desktop assistant text before the rollout snapshot is persisted", async () => {
    const { client, messages, transport } = await createStartedTransport();
    client.onMessage?.({
      type: "desktop-visible-agent-message",
      threadId: "thread-1",
      turnId: "turn-1",
      itemId: "agent-1",
      text: "Live text visible in Desktop",
    });

    expect(messages).toEqual([{
      method: "desktop/visibleAgentMessage",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
        itemId: "agent-1",
        text: "Live text visible in Desktop",
      },
    }]);
    await transport.stop();
  });

  it("returns server-request decisions over mcp-response exactly once", async () => {
    const { client, messages, transport } = await createStartedTransport();
    client.onMessage?.({
      type: "mcp-request",
      hostId: "local",
      request: {
        id: "approval-7",
        method: "item/commandExecution/requestApproval",
        params: { command: "git status" },
      },
    });
    expect(messages).toHaveLength(1);

    transport.send({ id: "approval-7", result: { decision: "decline" } });
    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    expect(client.sent[0]).toEqual({
      type: "mcp-response",
      hostId: "local",
      requestMethod: "item/commandExecution/requestApproval",
      response: { id: "approval-7", result: { decision: "decline" } },
    });
    expect(() => transport.send({ id: "approval-7", result: { decision: "accept" } }))
      .toThrow("desktop-server-request-not-pending");
    await transport.stop();
  });

  it("fails closed for a method outside the version manifest", async () => {
    const { transport } = await createStartedTransport();
    expect(() => transport.send({ id: 4, method: "shell/arbitrary", params: {} }))
      .toThrow("desktop-method-not-supported");
    await transport.stop();
  });

  it("uses Desktop's authoritative host route for pin state", async () => {
    const { client, messages, transport } = await createStartedTransport();
    transport.send({
      id: 11,
      method: "desktop/setThreadPinned",
      params: { threadId: "thread-1", pinned: true, beforeThreadId: "thread-0" },
    });
    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    const fetchRequest = client.sent[0] as Record<string, unknown>;
    expect(fetchRequest).toMatchObject({
      type: "fetch",
      method: "POST",
      url: "vscode://codex/set-thread-pinned",
      body: JSON.stringify({ threadId: "thread-1", pinned: true, beforeThreadId: "thread-0" }),
    });
    expect(typeof fetchRequest.requestId).toBe("string");

    client.onMessage?.({
      type: "fetch-response",
      requestId: fetchRequest.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ pinned: true }),
    });
    expect(messages).toContainEqual({ id: 11, result: { pinned: true } });

    client.onMessage?.({ type: "pinned-threads-updated" });
    expect(messages).toContainEqual({ method: "desktop/pins/updated", params: {} });
    await transport.stop();
  });

  it("reads Desktop's authoritative queued follow-ups", async () => {
    const { client, messages, transport } = await createStartedTransport();
    transport.send({ id: 15, method: "desktop/queue/list", params: { threadId: "thread-1" } });
    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    const fetchRequest = client.sent[0] as Record<string, unknown>;
    expect(fetchRequest).toMatchObject({
      type: "fetch",
      url: "vscode://codex/get-global-state",
      body: JSON.stringify({ key: "queued-follow-ups" }),
    });
    client.onMessage?.({
      type: "fetch-response",
      requestId: fetchRequest.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ value: {
        "thread-1": [{ id: "queued-1", text: "Wait for the current turn", createdAt: 7 }],
      } }),
    });
    expect(messages).toContainEqual({
      id: 15,
      result: { messages: [{ id: "queued-1", text: "Wait for the current turn", createdAt: 7 }] },
    });
    await transport.stop();
  });

  it("adds a queued follow-up through Desktop global state and broadcasts it", async () => {
    const { client, messages, transport } = await createStartedTransport();
    client.ownerRequestResult = {
      method: "thread-follower-set-queued-follow-ups-state",
      result: { ok: true },
    };
    transport.send({
      id: 16,
      method: "desktop/queue/add",
      params: {
        threadId: "thread-1",
        text: "Run this next",
        cwd: "/safe/project",
        input: [
          { type: "text", text: "Run this next" },
          { type: "localImage", path: "/safe/project/screen.png" },
        ],
      },
    });
    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    const fetchRequest = client.sent[0] as Record<string, unknown>;
    client.onMessage?.({
      type: "fetch-response",
      requestId: fetchRequest.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ value: {} }),
    });

    await vi.waitFor(() => expect(client.sent).toHaveLength(2));
    const writeRequest = client.sent[1] as Record<string, unknown>;
    expect(writeRequest).toMatchObject({
      type: "fetch",
      url: "vscode://codex/set-global-state",
    });
    const writeBody = JSON.parse(String(writeRequest.body));
    expect(writeBody).toMatchObject({
      key: "queued-follow-ups",
      value: {
        "thread-1": [{
          id: expect.any(String),
          text: "Run this next",
          cwd: "/safe/project",
          createdAt: expect.any(Number),
          context: {
            prompt: "Run this next",
            addedFiles: [],
            fileAttachments: [],
            imageAttachments: [{ src: "/safe/project/screen.png" }],
            workspaceRoots: ["/safe/project"],
          },
        }],
      },
    });
    client.onMessage?.({
      type: "fetch-response",
      requestId: writeRequest.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ success: true }),
    });
    await vi.waitFor(() => expect(client.queueBroadcasts).toHaveLength(1));
    expect(client.queueBroadcasts[0]).toMatchObject({
      conversationId: "thread-1",
      messages: [expect.objectContaining({ text: "Run this next" })],
    });
    expect(messages).toContainEqual({
      id: 16,
      result: { message: expect.objectContaining({ text: "Run this next" }) },
    });
    expect(client.ownerRequests).toEqual([]);
    await transport.stop();
  });

  it("adds an image-only queued follow-up while a Desktop turn is running", async () => {
    const { client, messages, transport } = await createStartedTransport();
    transport.send({
      id: 159,
      method: "desktop/queue/add",
      params: {
        threadId: "thread-1",
        text: "",
        cwd: "/safe/project",
        input: [{ type: "localImage", path: "/safe/project/screen.png" }],
      },
    });

    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    const readRequest = client.sent[0] as Record<string, unknown>;
    client.onMessage?.({
      type: "fetch-response",
      requestId: readRequest.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ value: {} }),
    });
    await vi.waitFor(() => expect(client.sent).toHaveLength(2));
    const writeRequest = client.sent[1] as Record<string, unknown>;
    expect(JSON.parse(String(writeRequest.body))).toMatchObject({
      value: {
        "thread-1": [{
          text: "",
          context: {
            prompt: "",
            imageAttachments: [{ src: "/safe/project/screen.png" }],
          },
        }],
      },
    });
    client.onMessage?.({
      type: "fetch-response",
      requestId: writeRequest.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ success: true }),
    });

    await vi.waitFor(() => expect(messages).toContainEqual({
      id: 159,
      result: { message: expect.objectContaining({ text: "" }) },
    }));
    await transport.stop();
  });

  it("does not report a Desktop owner timeout after the queued message was persisted", async () => {
    const { client, messages, transport } = await createStartedTransport();
    client.queueBroadcastError = new Error("desktop-queue-broadcast-failed:Error: timeout");
    transport.send({
      id: 160,
      method: "desktop/queue/add",
      params: { threadId: "thread-1", text: "Guide after persistence" },
    });
    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    const readRequest = client.sent[0] as Record<string, unknown>;
    client.onMessage?.({
      type: "fetch-response",
      requestId: readRequest.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ value: {} }),
    });
    await vi.waitFor(() => expect(client.sent).toHaveLength(2));
    const writeRequest = client.sent[1] as Record<string, unknown>;
    client.onMessage?.({
      type: "fetch-response",
      requestId: writeRequest.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ success: true }),
    });

    await vi.waitFor(() => expect(client.queueBroadcasts).toHaveLength(1));
    expect(messages).toContainEqual({
      id: 160,
      result: { message: expect.objectContaining({ text: "Guide after persistence" }), pendingConfirmation: true },
    });
    expect(messages).not.toContainEqual(expect.objectContaining({ id: 160, error: expect.anything() }));
    await transport.stop();
  });

  it("keeps a persisted queue addition pending when a generic Desktop broadcast fails", async () => {
    const { client, messages, transport } = await createStartedTransport();
    client.queueBroadcastError = new Error("desktop-queue-broadcast-failed:renderer disappeared");
    transport.send({
      id: 1601,
      method: "desktop/queue/add",
      params: { threadId: "thread-1", text: "Persist before broadcast" },
    });
    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    const readRequest = client.sent[0] as Record<string, unknown>;
    client.onMessage?.({
      type: "fetch-response",
      requestId: readRequest.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ value: {} }),
    });
    await vi.waitFor(() => expect(client.sent).toHaveLength(2));
    const writeRequest = client.sent[1] as Record<string, unknown>;
    client.onMessage?.({
      type: "fetch-response",
      requestId: writeRequest.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ success: true }),
    });

    await vi.waitFor(() => expect(messages).toContainEqual({
      id: 1601,
      result: {
        message: expect.objectContaining({ text: "Persist before broadcast" }),
        pendingConfirmation: true,
      },
    }));
    expect(messages).not.toContainEqual(expect.objectContaining({ id: 1601, error: expect.anything() }));
    await transport.stop();
  });

  it("serializes simultaneous queue additions so two browser windows cannot overwrite each other", async () => {
    const { client, messages, transport } = await createStartedTransport();
    transport.send({
      id: 161,
      method: "desktop/queue/add",
      params: { threadId: "thread-1", text: "First window" },
    });
    transport.send({
      id: 162,
      method: "desktop/queue/add",
      params: { threadId: "thread-1", text: "Second window" },
    });

    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    const firstRead = client.sent[0] as Record<string, unknown>;
    client.onMessage?.({
      type: "fetch-response",
      requestId: firstRead.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ value: {} }),
    });
    await vi.waitFor(() => expect(client.sent).toHaveLength(2));
    const firstWrite = client.sent[1] as Record<string, unknown>;
    const firstState = JSON.parse(String(firstWrite.body)).value;
    client.onMessage?.({
      type: "fetch-response",
      requestId: firstWrite.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ success: true }),
    });

    await vi.waitFor(() => expect(client.sent).toHaveLength(3));
    const secondRead = client.sent[2] as Record<string, unknown>;
    expect(secondRead).toMatchObject({ url: "vscode://codex/get-global-state" });
    client.onMessage?.({
      type: "fetch-response",
      requestId: secondRead.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ value: firstState }),
    });
    await vi.waitFor(() => expect(client.sent).toHaveLength(4));
    const secondWrite = client.sent[3] as Record<string, unknown>;
    expect(JSON.parse(String(secondWrite.body)).value["thread-1"]).toEqual([
      expect.objectContaining({ text: "First window" }),
      expect.objectContaining({ text: "Second window" }),
    ]);
    client.onMessage?.({
      type: "fetch-response",
      requestId: secondWrite.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ success: true }),
    });

    await vi.waitFor(() => expect(messages).toEqual(expect.arrayContaining([
      { id: 161, result: { message: expect.objectContaining({ text: "First window" }) } },
      { id: 162, result: { message: expect.objectContaining({ text: "Second window" }) } },
    ])));
    await transport.stop();
  });

  it("continues the serialized queue after an earlier mutation fails", async () => {
    const { client, messages, transport } = await createStartedTransport();
    transport.send({
      id: 163,
      method: "desktop/queue/add",
      params: { threadId: "thread-1", text: "Fail first" },
    });
    transport.send({
      id: 164,
      method: "desktop/queue/add",
      params: { threadId: "thread-1", text: "Continue second" },
    });

    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    const failedRead = client.sent[0] as Record<string, unknown>;
    client.onMessage?.({
      type: "fetch-response",
      requestId: failedRead.requestId,
      responseType: "error",
      status: 503,
    });

    await vi.waitFor(() => expect(messages).toContainEqual({
      id: 163,
      error: { code: -32002, message: "Desktop queue read failed" },
    }));
    await vi.waitFor(() => expect(client.sent).toHaveLength(2));
    expect(client.sent[1]).toMatchObject({ url: "vscode://codex/get-global-state" });
    await transport.stop();
  });

  it("rejects an empty queue addition without blocking the valid mutation behind it", async () => {
    const { client, messages, transport } = await createStartedTransport();
    transport.send({
      id: 1641,
      method: "desktop/queue/add",
      params: { threadId: "thread-1", text: "", input: [] },
    });
    transport.send({
      id: 1642,
      method: "desktop/queue/add",
      params: { threadId: "thread-1", text: "Valid next mutation" },
    });

    expect(messages).toContainEqual({
      id: 1641,
      error: { code: -32602, message: "text or localImage input is required" },
    });
    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    expect(client.sent[0]).toMatchObject({ url: "vscode://codex/get-global-state" });
    await transport.stop();
  });

  it("fails active and queued mutations on disconnect, then accepts a new mutation after reconnect", async () => {
    const { client, messages, transport } = await createStartedTransport();
    transport.send({
      id: 165,
      method: "desktop/queue/add",
      params: { threadId: "thread-1", text: "Active read" },
    });
    transport.send({
      id: 166,
      method: "desktop/queue/add",
      params: { threadId: "thread-1", text: "Queued behind read" },
    });
    await vi.waitFor(() => expect(client.sent).toHaveLength(1));

    client.onDisconnect?.(new Error("renderer disconnected"));
    await vi.waitFor(() => expect(messages).toEqual(expect.arrayContaining([
      { id: 165, error: { code: -32005, message: "Desktop queue operation interrupted by disconnect" } },
      { id: 166, error: { code: -32005, message: "Desktop queue operation interrupted by disconnect" } },
    ])));
    await vi.waitFor(() => expect(transport.state).toBe("live"));

    transport.send({
      id: 167,
      method: "desktop/queue/add",
      params: { threadId: "thread-1", text: "After reconnect" },
    });
    await vi.waitFor(() => expect(client.sent).toHaveLength(2));
    expect(client.sent[1]).toMatchObject({ url: "vscode://codex/get-global-state" });
    await transport.stop();
  });

  it("recovers an add that disconnects while its global-state write is ambiguous", async () => {
    const { client, messages, transport } = await createStartedTransport();
    transport.send({
      id: 168,
      method: "desktop/queue/add",
      params: { threadId: "thread-1", text: "Writing now" },
    });
    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    const readRequest = client.sent[0] as Record<string, unknown>;
    client.onMessage?.({
      type: "fetch-response",
      requestId: readRequest.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ value: {} }),
    });
    await vi.waitFor(() => expect(client.sent).toHaveLength(2));

    client.onDisconnect?.(new Error("renderer disconnected"));
    expect(messages.some((message) => "id" in message && message.id === 168)).toBe(false);
    await vi.waitFor(() => expect(transport.state).toBe("live"));
    await vi.waitFor(() => expect(client.sent).toHaveLength(3));
    const recoveryRead = client.sent[2] as Record<string, unknown>;
    client.onMessage?.({
      type: "fetch-response",
      requestId: recoveryRead.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ value: {} }),
    });
    await vi.waitFor(() => expect(client.sent).toHaveLength(4));
    const recoveryWrite = client.sent[3] as Record<string, unknown>;
    client.onMessage?.({
      type: "fetch-response",
      requestId: recoveryWrite.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ success: true }),
    });
    await vi.waitFor(() => expect(messages).toContainEqual({
      id: 168,
      result: {
        message: expect.objectContaining({ text: "Writing now" }),
        pendingConfirmation: true,
      },
    }));
    transport.send({
      id: 169,
      method: "desktop/queue/add",
      params: { threadId: "thread-1", text: "After write disconnect" },
    });
    await vi.waitFor(() => expect(client.sent).toHaveLength(5));
    await transport.stop();
  });

  it("restores a steer that disconnects while its queue-removal write is ambiguous", async () => {
    const { client, messages, transport } = await createStartedTransport();
    client.queuePromotionResult = false;
    transport.send({
      id: 1690,
      method: "desktop/queue/steer",
      params: { threadId: "thread-1", messageId: "queued-1", expectedTurnId: "turn-1" },
    });
    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    const readRequest = client.sent[0] as Record<string, unknown>;
    client.onMessage?.({
      type: "fetch-response",
      requestId: readRequest.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ value: {
        "thread-1": [{ id: "queued-1", text: "Do not lose me", createdAt: 7 }],
      } }),
    });
    await vi.waitFor(() => expect(client.sent).toHaveLength(2));

    client.onDisconnect?.(new Error("renderer disconnected during removal write"));
    expect(messages.some((message) => "id" in message && message.id === 1690)).toBe(false);
    await vi.waitFor(() => expect(transport.state).toBe("live"));
    await vi.waitFor(() => expect(client.sent).toHaveLength(3));
    const recoveryRead = client.sent[2] as Record<string, unknown>;
    client.onMessage?.({
      type: "fetch-response",
      requestId: recoveryRead.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ value: {} }),
    });
    await vi.waitFor(() => expect(client.sent).toHaveLength(4));
    const recoveryWrite = client.sent[3] as Record<string, unknown>;
    expect(JSON.parse(String(recoveryWrite.body)).value["thread-1"]).toEqual([
      expect.objectContaining({ id: "queued-1", text: "Do not lose me" }),
    ]);
    client.onMessage?.({
      type: "fetch-response",
      requestId: recoveryWrite.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ success: true }),
    });

    await vi.waitFor(() => expect(messages).toContainEqual({
      id: 1690,
      error: {
        code: -32003,
        message: "Desktop could not confirm the promotion; the message was kept queued",
      },
    }));
    expect(client.ownerRequests).toEqual([]);
    await transport.stop();
  });

  it("confirms a persisted add across disconnect without making the user retry or duplicating it", async () => {
    const { client, messages, transport } = await createStartedTransport();
    let finishBroadcast!: () => void;
    client.broadcastQueuedFollowUps = vi.fn(() => new Promise<void>((resolve) => {
      finishBroadcast = resolve;
    }));
    transport.send({
      id: 1691,
      method: "desktop/queue/add",
      params: { threadId: "thread-1", text: "Broadcast in flight" },
    });
    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    const readRequest = client.sent[0] as Record<string, unknown>;
    client.onMessage?.({
      type: "fetch-response",
      requestId: readRequest.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ value: {} }),
    });
    await vi.waitFor(() => expect(client.sent).toHaveLength(2));
    const writeRequest = client.sent[1] as Record<string, unknown>;
    client.onMessage?.({
      type: "fetch-response",
      requestId: writeRequest.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ success: true }),
    });
    await vi.waitFor(() => expect(client.broadcastQueuedFollowUps).toHaveBeenCalledTimes(1));

    client.onDisconnect?.(new Error("renderer disconnected"));
    await vi.waitFor(() => expect(messages).toContainEqual({
      id: 1691,
      result: {
        message: expect.objectContaining({ text: "Broadcast in flight" }),
        pendingConfirmation: true,
      },
    }));
    await vi.waitFor(() => expect(transport.state).toBe("live"));
    transport.send({
      id: 1692,
      method: "desktop/queue/add",
      params: { threadId: "thread-1", text: "New active mutation" },
    });
    await vi.waitFor(() => expect(client.sent).toHaveLength(3));

    finishBroadcast();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(messages.filter((message) => "id" in message && message.id === 1691)).toHaveLength(1);
    const persistedMessage = JSON.parse(String(writeRequest.body)).value["thread-1"][0];
    const newRead = client.sent[2] as Record<string, unknown>;
    client.onMessage?.({
      type: "fetch-response",
      requestId: newRead.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ value: { "thread-1": [persistedMessage] } }),
    });
    await vi.waitFor(() => expect(client.sent).toHaveLength(4));
    const nextWrite = JSON.parse(String((client.sent[3] as Record<string, unknown>).body));
    expect(nextWrite.value["thread-1"].filter((message: Record<string, unknown>) => (
      message.id === persistedMessage.id
    ))).toHaveLength(1);
    await transport.stop();
  });

  it("continues a persisted queue promotion after its broadcast rejects following disconnect", async () => {
    const { client, messages, transport } = await createStartedTransport();
    client.queuePromotionResult = false;
    let failBroadcast!: (cause: Error) => void;
    client.broadcastQueuedFollowUps = vi.fn(() => new Promise<void>((_resolve, reject) => {
      failBroadcast = reject;
    }));
    transport.send({
      id: 1693,
      method: "desktop/queue/steer",
      params: { threadId: "thread-1", messageId: "queued-1", expectedTurnId: "turn-1" },
    });
    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    const readRequest = client.sent[0] as Record<string, unknown>;
    client.onMessage?.({
      type: "fetch-response",
      requestId: readRequest.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ value: {
        "thread-1": [{ id: "queued-1", text: "Promote later", createdAt: 7 }],
      } }),
    });
    await vi.waitFor(() => expect(client.sent).toHaveLength(2));
    const removalWrite = client.sent[1] as Record<string, unknown>;
    client.onMessage?.({
      type: "fetch-response",
      requestId: removalWrite.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ success: true }),
    });
    await vi.waitFor(() => expect(client.broadcastQueuedFollowUps).toHaveBeenCalledTimes(1));

    client.onDisconnect?.(new Error("renderer disconnected"));
    expect(messages.some((message) => "id" in message && message.id === 1693)).toBe(false);
    failBroadcast(new Error("renderer disappeared"));
    await vi.waitFor(() => expect(client.ownerRequests).toHaveLength(1));
    await vi.waitFor(() => expect(messages).toContainEqual({
      id: 1693,
      result: { messageId: "queued-1" },
    }));

    await transport.stop();
  });

  it("restores a persisted queue promotion exactly once when its owner rejects after disconnect", async () => {
    const { client, messages, transport } = await createStartedTransport();
    client.queuePromotionResult = false;
    let rejectOwner!: (cause: Error) => void;
    client.requestThreadOwner = vi.fn((method: string) => {
      client.ownerRequests.push({ method, params: {} });
      if (method === "thread-follower-start-turn") {
        return Promise.reject(new Error("desktop-thread-owner-request-failed:Error: no active turn to steer"));
      }
      return new Promise((_resolve, reject) => {
        rejectOwner = reject;
      });
    });
    transport.send({
      id: 1694,
      method: "desktop/queue/steer",
      params: { threadId: "thread-1", messageId: "queued-1", expectedTurnId: "turn-1" },
    });
    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    const readRequest = client.sent[0] as Record<string, unknown>;
    client.onMessage?.({
      type: "fetch-response",
      requestId: readRequest.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ value: {
        "thread-1": [{ id: "queued-1", text: "Owner in flight", createdAt: 7 }],
      } }),
    });
    await vi.waitFor(() => expect(client.sent).toHaveLength(2));
    const removalWrite = client.sent[1] as Record<string, unknown>;
    client.onMessage?.({
      type: "fetch-response",
      requestId: removalWrite.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ success: true }),
    });
    await vi.waitFor(() => expect(client.requestThreadOwner).toHaveBeenCalledTimes(1));

    client.onDisconnect?.(new Error("renderer disconnected"));
    expect(messages.some((message) => "id" in message && message.id === 1694)).toBe(false);
    rejectOwner(new Error("desktop-thread-owner-request-failed:Error: no active turn to steer"));
    await vi.waitFor(() => expect(transport.state).toBe("live"));
    await vi.waitFor(() => expect(client.sent).toHaveLength(3));
    const restoreRead = client.sent[2] as Record<string, unknown>;
    client.onMessage?.({
      type: "fetch-response",
      requestId: restoreRead.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ value: {} }),
    });
    await vi.waitFor(() => expect(client.sent).toHaveLength(4));
    const restoreWrite = client.sent[3] as Record<string, unknown>;
    const restored = JSON.parse(String(restoreWrite.body)).value["thread-1"];
    expect(restored.filter((message: Record<string, unknown>) => message.id === "queued-1"))
      .toHaveLength(1);
    client.onMessage?.({
      type: "fetch-response",
      requestId: restoreWrite.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ success: true }),
    });
    await vi.waitFor(() => expect(messages).toContainEqual({
      id: 1694,
      error: {
        code: -32003,
        message: "Desktop could not confirm the promotion; the message was kept queued",
      },
    }));

    await transport.stop();
  });

  it("removes one queued follow-up then steers it through the Desktop thread owner without clicking Desktop DOM", async () => {
    const { client, messages, transport } = await createStartedTransport();
    transport.send({
      id: 17,
      method: "desktop/queue/steer",
      params: { threadId: "thread-1", messageId: "queued-1", expectedTurnId: "turn-1" },
    });
    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    const fetchRequest = client.sent[0] as Record<string, unknown>;
    client.onMessage?.({
      type: "fetch-response",
      requestId: fetchRequest.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ value: {
        "thread-1": [
          { id: "queued-1", text: "Guide now", cwd: "/safe/project", createdAt: 7, context: { prompt: "Guide now" } },
          { id: "queued-2", text: "Keep queued", createdAt: 8 },
        ],
      } }),
    });

    await vi.waitFor(() => expect(client.sent).toHaveLength(2));
    const writeRequest = client.sent[1] as Record<string, unknown>;
    expect(JSON.parse(String(writeRequest.body))).toEqual({
      key: "queued-follow-ups",
      value: { "thread-1": [{ id: "queued-2", text: "Keep queued", createdAt: 8 }] },
    });
    client.onMessage?.({
      type: "fetch-response",
      requestId: writeRequest.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ success: true }),
    });

    await vi.waitFor(() => expect(client.ownerRequests).toHaveLength(1));
    expect(client.ownerRequests[0]).toMatchObject({
      method: "thread-follower-steer-turn",
      params: {
        conversationId: "thread-1",
        input: [{ type: "text", text: "Guide now", text_elements: [] }],
        clientUserMessageId: "queued-1",
      },
    });
    expect(messages).toContainEqual({ id: 17, result: { messageId: "queued-1" } });
    await transport.stop();
  });

  it("starts the queued follow-up exactly once when Stop wins the active-turn race", async () => {
    const { client, messages, transport } = await createStartedTransport();
    client.queuePromotionResult = false;
    client.ownerRequestHandler = async (method) => {
      if (method === "thread-follower-steer-turn") {
        throw new Error("desktop-thread-owner-request-failed:Error: no active turn to steer");
      }
      if (method === "thread-follower-start-turn") return { result: { turnId: "turn-after-stop" } };
      throw new Error(`unexpected-owner-method:${method}`);
    };
    transport.send({
      id: 1701,
      method: "desktop/queue/steer",
      params: { threadId: "thread-1", messageId: "queued-1", expectedTurnId: "turn-stopped" },
    });

    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    const readRequest = client.sent[0] as Record<string, unknown>;
    client.onMessage?.({
      type: "fetch-response",
      requestId: readRequest.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ value: {
        "thread-1": [{
          id: "queued-1",
          text: "Continue after Stop",
          cwd: "/safe/project",
          createdAt: 7,
          context: { prompt: "Continue after Stop" },
        }],
      } }),
    });

    await vi.waitFor(() => expect(client.sent).toHaveLength(2));
    const writeRequest = client.sent[1] as Record<string, unknown>;
    client.onMessage?.({
      type: "fetch-response",
      requestId: writeRequest.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ success: true }),
    });

    await vi.waitFor(() => expect(client.ownerRequests).toHaveLength(2));
    expect(client.ownerRequests.map((request) => request.method)).toEqual([
      "thread-follower-steer-turn",
      "thread-follower-start-turn",
    ]);
    expect(client.ownerRequests[1]).toMatchObject({
      params: {
        conversationId: "thread-1",
        input: [{ type: "text", text: "Continue after Stop", text_elements: [] }],
        clientUserMessageId: "queued-1",
      },
    });
    expect(messages).toContainEqual({ id: 1701, result: { messageId: "queued-1" } });
    expect(client.sent).toHaveLength(2);
    await transport.stop();
  });

  it.each([
    ["desktop-thread-owner-request-failed:Error: no active turn to steer", undefined],
    ["desktop-thread-owner-request-failed:Error: turn is not active", "desktop-queue-broadcast-failed:renderer disappeared"],
  ])("restores a queued message when Desktop explicitly rejects its promotion: %s", async (ownerError, broadcastError) => {
    const { client, messages, transport } = await createStartedTransport();
    client.queuePromotionResult = false;
    client.ownerRequestError = new Error(ownerError);
    if (broadcastError) client.queueBroadcastError = new Error(broadcastError);
    transport.send({
      id: 18,
      method: "desktop/queue/steer",
      params: { threadId: "thread-1", messageId: "queued-1", expectedTurnId: "turn-1" },
    });

    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    const readRequest = client.sent[0] as Record<string, unknown>;
    client.onMessage?.({
      type: "fetch-response",
      requestId: readRequest.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ value: {
        "thread-1": [
          { id: "queued-1", text: "Guide now", createdAt: 7 },
          { id: "queued-2", text: "Keep queued", createdAt: 8 },
        ],
      } }),
    });

    await vi.waitFor(() => expect(client.sent).toHaveLength(2));
    const writeRequest = client.sent[1] as Record<string, unknown>;
    client.onMessage?.({
      type: "fetch-response",
      requestId: writeRequest.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ success: true }),
    });

    await vi.waitFor(() => expect(client.ownerRequests).toHaveLength(2));
    expect(client.ownerRequests.map((ownerRequest) => ownerRequest.method)).toEqual([
      "thread-follower-steer-turn",
      "thread-follower-start-turn",
    ]);
    await vi.waitFor(() => expect(client.sent).toHaveLength(3));
    const restoreReadRequest = client.sent[2] as Record<string, unknown>;
    expect(restoreReadRequest).toMatchObject({
      type: "fetch",
      url: "vscode://codex/get-global-state",
    });
    client.onMessage?.({
      type: "fetch-response",
      requestId: restoreReadRequest.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ value: {
        "thread-1": [
          { id: "queued-2", text: "Keep queued", createdAt: 8 },
          { id: "queued-3", text: "Added concurrently", createdAt: 9 },
        ],
        "thread-2": [{ id: "other-1", text: "Other thread update", createdAt: 10 }],
      } }),
    });

    await vi.waitFor(() => expect(client.sent).toHaveLength(4));
    const restoreWriteRequest = client.sent[3] as Record<string, unknown>;
    expect(JSON.parse(String(restoreWriteRequest.body))).toEqual({
      key: "queued-follow-ups",
      value: {
        "thread-1": [
          { id: "queued-1", text: "Guide now", createdAt: 7 },
          { id: "queued-2", text: "Keep queued", createdAt: 8 },
          { id: "queued-3", text: "Added concurrently", createdAt: 9 },
        ],
        "thread-2": [{ id: "other-1", text: "Other thread update", createdAt: 10 }],
      },
    });
    client.onMessage?.({
      type: "fetch-response",
      requestId: restoreWriteRequest.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ success: true }),
    });

    await vi.waitFor(() => expect(messages).toContainEqual({
      id: 18,
      error: {
        code: -32003,
        message: "Desktop could not confirm the promotion; the message was kept queued",
      },
    }));
    expect(client.queueBroadcasts.at(-1)).toEqual({
      conversationId: "thread-1",
      messages: [
        { id: "queued-1", text: "Guide now", createdAt: 7 },
        { id: "queued-2", text: "Keep queued", createdAt: 8 },
        { id: "queued-3", text: "Added concurrently", createdAt: 9 },
      ],
    });
    await transport.stop();
  });

  it("confirms an ambiguous owner timeout by client message id instead of restoring a duplicate", async () => {
    const { client, messages, transport } = await createStartedTransport();
    client.queuePromotionResult = false;
    client.ownerRequestError = new Error("desktop-cdp-owner-call-timeout");
    transport.send({
      id: 180,
      method: "desktop/queue/steer",
      params: { threadId: "thread-1", messageId: "queued-1", expectedTurnId: "turn-1" },
    });

    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    const readRequest = client.sent[0] as Record<string, unknown>;
    client.onMessage?.({
      type: "fetch-response",
      requestId: readRequest.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ value: {
        "thread-1": [{ id: "queued-1", text: "May already have run", createdAt: 7 }],
      } }),
    });
    await vi.waitFor(() => expect(client.sent).toHaveLength(2));
    const removalWrite = client.sent[1] as Record<string, unknown>;
    client.onMessage?.({
      type: "fetch-response",
      requestId: removalWrite.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ success: true }),
    });

    await vi.waitFor(() => expect(client.sent).toHaveLength(3));
    const confirmation = client.sent[2] as Record<string, unknown>;
    expect(confirmation).toMatchObject({
      type: "mcp-request",
      request: { method: "thread/read", params: { threadId: "thread-1", includeTurns: true } },
    });
    const confirmationRequest = confirmation.request as Record<string, unknown>;
    client.onMessage?.({
      type: "mcp-response",
      hostId: "local",
      message: {
        id: confirmationRequest.id,
        result: {
          thread: {
            id: "thread-1",
            turns: [{ items: [{ type: "userMessage", clientId: "queued-1" }] }],
          },
        },
      },
    });

    await vi.waitFor(() => expect(messages).toContainEqual({
      id: 180,
      result: { messageId: "queued-1", pendingConfirmation: true },
    }));
    expect(client.sent).toHaveLength(3);
    await transport.stop();
  });

  it("ignores unrelated, wrong-thread, and incomplete confirmation identities", async () => {
    const { client, messages, transport } = await createStartedTransport();
    client.queuePromotionResult = false;
    client.ownerRequestError = new Error("desktop-cdp-owner-call-timeout");
    transport.send({
      id: 1803,
      method: "desktop/queue/steer",
      params: { threadId: "thread-1", messageId: "queued-1", expectedTurnId: "turn-1" },
    });

    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    const readRequest = client.sent[0] as Record<string, unknown>;
    client.onMessage?.({
      type: "fetch-response",
      requestId: readRequest.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ value: {
        "thread-1": [{ id: "queued-1", text: "Check the exact item", createdAt: 7 }],
      } }),
    });
    await vi.waitFor(() => expect(client.sent).toHaveLength(2));
    const removalWrite = client.sent[1] as Record<string, unknown>;
    client.onMessage?.({
      type: "fetch-response",
      requestId: removalWrite.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ success: true }),
    });

    const snapshots = [
      { thread: { id: "thread-1", metadata: { clientId: "queued-1" } } },
      {
        thread: {
          id: "thread-other",
          turns: [{ items: [{ type: "userMessage", clientId: "queued-1" }] }],
        },
      },
      {
        thread: {
          id: "thread-1",
          turns: [{ items: [{ type: "assistantMessage", metadata: { clientId: "queued-1" } }] }],
        },
      },
      {
        thread: {
          id: "thread-1",
          turns: [{ items: [{ type: "userMessage", clientId: "queued-1" }] }],
        },
      },
    ];
    for (let index = 0; index < snapshots.length; index += 1) {
      await vi.waitFor(() => expect(client.sent).toHaveLength(3 + index));
      const confirmation = client.sent[2 + index] as Record<string, unknown>;
      expect(confirmation).toMatchObject({
        type: "mcp-request",
        request: { method: "thread/read", params: { threadId: "thread-1", includeTurns: true } },
      });
      const confirmationRequest = confirmation.request as Record<string, unknown>;
      client.onMessage?.({
        type: "mcp-response",
        hostId: "local",
        message: { id: confirmationRequest.id, result: snapshots[index] },
      });
      if (index < snapshots.length - 1) {
        expect(messages.some((message) => "id" in message && message.id === 1803)).toBe(false);
      }
    }

    await vi.waitFor(() => expect(messages).toContainEqual({
      id: 1803,
      result: { messageId: "queued-1", pendingConfirmation: true },
    }));
    expect(client.sent).toHaveLength(6);
    await transport.stop();
  });

  it("uses paginated turn history and restarts at the newest page when a cursor loops", async () => {
    const { client, messages, transport } = await createStartedTransport();
    client.queuePromotionResult = false;
    client.ownerRequestError = new Error("desktop-cdp-owner-call-timeout");
    transport.send({
      id: 1804,
      method: "desktop/queue/steer",
      params: { threadId: "thread-1", messageId: "queued-1", expectedTurnId: "turn-1" },
    });

    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    const readRequest = client.sent[0] as Record<string, unknown>;
    client.onMessage?.({
      type: "fetch-response",
      requestId: readRequest.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ value: {
        "thread-1": [{ id: "queued-1", text: "Find me in paginated history", createdAt: 7 }],
      } }),
    });
    await vi.waitFor(() => expect(client.sent).toHaveLength(2));
    const removalWrite = client.sent[1] as Record<string, unknown>;
    client.onMessage?.({
      type: "fetch-response",
      requestId: removalWrite.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ success: true }),
    });

    await vi.waitFor(() => expect(client.sent).toHaveLength(3));
    const threadRead = client.sent[2] as Record<string, unknown>;
    const threadReadRequest = threadRead.request as Record<string, unknown>;
    client.onMessage?.({
      type: "mcp-response",
      hostId: "local",
      message: {
        id: threadReadRequest.id,
        result: { thread: { id: "thread-1", historyMode: "paginated", turns: [] } },
      },
    });

    await vi.waitFor(() => expect(client.sent).toHaveLength(4));
    const turnsList = client.sent[3] as Record<string, unknown>;
    expect(turnsList).toMatchObject({
      type: "mcp-request",
      request: {
        method: "thread/turns/list",
        params: {
          threadId: "thread-1",
          limit: 8,
          sortDirection: "desc",
          itemsView: "full",
        },
      },
    });
    const turnsListRequest = turnsList.request as Record<string, unknown>;
    client.onMessage?.({
      type: "mcp-response",
      hostId: "local",
      message: {
        id: turnsListRequest.id,
        result: {
          data: [{ items: [{ type: "assistantMessage", text: "newer page" }] }],
          nextCursor: "older-page",
        },
      },
    });

    await vi.waitFor(() => expect(client.sent).toHaveLength(5));
    const olderTurnsList = client.sent[4] as Record<string, unknown>;
    expect(olderTurnsList).toMatchObject({
      type: "mcp-request",
      request: {
        method: "thread/turns/list",
        params: {
          threadId: "thread-1",
          cursor: "older-page",
          limit: 8,
          sortDirection: "desc",
          itemsView: "full",
        },
      },
    });
    const olderTurnsListRequest = olderTurnsList.request as Record<string, unknown>;
    client.onMessage?.({
      type: "mcp-response",
      hostId: "local",
      message: {
        id: olderTurnsListRequest.id,
        result: {
          data: [{ items: [{ type: "assistantMessage", text: "cyclic older page" }] }],
          nextCursor: "older-page",
        },
      },
    });

    await vi.waitFor(() => expect(client.sent).toHaveLength(6));
    const refreshedTurnsList = client.sent[5] as Record<string, unknown>;
    expect(refreshedTurnsList).toMatchObject({
      type: "mcp-request",
      request: {
        method: "thread/turns/list",
        params: {
          threadId: "thread-1",
          limit: 8,
          sortDirection: "desc",
          itemsView: "full",
        },
      },
    });
    expect(asTestRecord(asTestRecord(refreshedTurnsList).request).params).not.toHaveProperty("cursor");
    const refreshedTurnsListRequest = refreshedTurnsList.request as Record<string, unknown>;
    client.onMessage?.({
      type: "mcp-response",
      hostId: "local",
      message: {
        id: refreshedTurnsListRequest.id,
        result: { data: [{ items: [{ type: "userMessage", clientId: "queued-1" }] }] },
      },
    });

    await vi.waitFor(() => expect(messages).toContainEqual({
      id: 1804,
      result: { messageId: "queued-1", pendingConfirmation: true },
    }));
    expect(client.sent).toHaveLength(6);
    await transport.stop();
  });

  it("restores after an ambiguous owner failure only when repeated fresh snapshots lack the client id", async () => {
    const { client, messages, transport } = await createStartedTransport();
    client.queuePromotionResult = false;
    client.ownerRequestError = new Error("desktop-thread-owner-request-failed:renderer unavailable");
    transport.send({
      id: 1802,
      method: "desktop/queue/steer",
      params: { threadId: "thread-1", messageId: "queued-1", expectedTurnId: "turn-1" },
    });

    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    const readRequest = client.sent[0] as Record<string, unknown>;
    client.onMessage?.({
      type: "fetch-response",
      requestId: readRequest.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ value: {
        "thread-1": [{ id: "queued-1", text: "Confirm before restore", createdAt: 7 }],
      } }),
    });
    await vi.waitFor(() => expect(client.sent).toHaveLength(2));
    const removalWrite = client.sent[1] as Record<string, unknown>;
    client.onMessage?.({
      type: "fetch-response",
      requestId: removalWrite.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ success: true }),
    });

    for (let attempt = 0; attempt < 4; attempt += 1) {
      await vi.waitFor(() => expect(client.sent).toHaveLength(3 + attempt));
      const confirmation = client.sent[2 + attempt] as Record<string, unknown>;
      expect(confirmation).toMatchObject({
        type: "mcp-request",
        request: { method: "thread/read", params: { threadId: "thread-1", includeTurns: true } },
      });
      const confirmationRequest = confirmation.request as Record<string, unknown>;
      client.onMessage?.({
        type: "mcp-response",
        hostId: "local",
        message: attempt === 0
          ? { id: confirmationRequest.id, error: { code: -32002, message: "snapshot unavailable" } }
          : {
              id: confirmationRequest.id,
              result: { thread: { id: "thread-1", turns: [] } },
            },
      });
    }

    await vi.waitFor(() => expect(client.sent).toHaveLength(7));
    const restoreRead = client.sent[6] as Record<string, unknown>;
    expect(restoreRead).toMatchObject({ type: "fetch", url: "vscode://codex/get-global-state" });
    client.onMessage?.({
      type: "fetch-response",
      requestId: restoreRead.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ value: {} }),
    });
    await vi.waitFor(() => expect(client.sent).toHaveLength(8));
    const restoreWrite = client.sent[7] as Record<string, unknown>;
    client.onMessage?.({
      type: "fetch-response",
      requestId: restoreWrite.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ success: true }),
    });

    await vi.waitFor(() => expect(messages).toContainEqual({
      id: 1802,
      error: {
        code: -32003,
        message: "Desktop could not confirm the promotion; the message was kept queued",
      },
    }));
    await transport.stop();
  });

  it.each(["non-2xx", "malformed", "wrong-shape"])(
    "keeps retrying authoritative queue recovery after a %s restore read and a failed restore write",
    async (readFailure) => {
      const { client, messages, transport } = await createStartedTransport();
      client.queuePromotionResult = false;
      client.ownerRequestError = new Error("desktop-thread-owner-request-failed:Error: no active turn to steer");
      transport.send({
        id: 1801,
        method: "desktop/queue/steer",
        params: { threadId: "thread-1", messageId: "queued-1", expectedTurnId: "turn-1" },
      });

      await vi.waitFor(() => expect(client.sent).toHaveLength(1));
      const initialRead = client.sent[0] as Record<string, unknown>;
      client.onMessage?.({
        type: "fetch-response",
        requestId: initialRead.requestId,
        responseType: "success",
        status: 200,
        bodyJsonString: JSON.stringify({ value: {
          "thread-1": [{ id: "queued-1", text: "Recover safely", createdAt: 7 }],
        } }),
      });
      await vi.waitFor(() => expect(client.sent).toHaveLength(2));
      const removalWrite = client.sent[1] as Record<string, unknown>;
      client.onMessage?.({
        type: "fetch-response",
        requestId: removalWrite.requestId,
        responseType: "success",
        status: 200,
        bodyJsonString: JSON.stringify({ success: true }),
      });
      await vi.waitFor(() => expect(client.sent).toHaveLength(3));
      const failedRestoreRead = client.sent[2] as Record<string, unknown>;
      client.onMessage?.(readFailure === "non-2xx" ? {
        type: "fetch-response",
        requestId: failedRestoreRead.requestId,
        responseType: "error",
        status: 503,
      } : {
        type: "fetch-response",
        requestId: failedRestoreRead.requestId,
        responseType: "success",
        status: 200,
        bodyJsonString: readFailure === "malformed"
          ? "{bad json"
          : JSON.stringify({ value: [] }),
      });

      expect(messages.some((message) => "id" in message && message.id === 1801)).toBe(false);
      await vi.waitFor(() => expect(client.sent).toHaveLength(4));
      const retryRead = client.sent[3] as Record<string, unknown>;
      client.onMessage?.({
        type: "fetch-response",
        requestId: retryRead.requestId,
        responseType: "success",
        status: 200,
        bodyJsonString: JSON.stringify({ value: {
          "thread-other": [{ id: "other-1", text: "Preserve another queue", createdAt: 8 }],
        } }),
      });
      await vi.waitFor(() => expect(client.sent).toHaveLength(5));
      const failedRestoreWrite = client.sent[4] as Record<string, unknown>;
      client.onMessage?.({
        type: "fetch-response",
        requestId: failedRestoreWrite.requestId,
        responseType: "error",
        status: 503,
      });

      expect(messages.some((message) => "id" in message && message.id === 1801)).toBe(false);
      await vi.waitFor(() => expect(client.sent).toHaveLength(6));
      const finalRead = client.sent[5] as Record<string, unknown>;
      client.onMessage?.({
        type: "fetch-response",
        requestId: finalRead.requestId,
        responseType: "success",
        status: 200,
        bodyJsonString: JSON.stringify({ value: {
          "thread-other": [{ id: "other-1", text: "Preserve another queue", createdAt: 8 }],
        } }),
      });
      await vi.waitFor(() => expect(client.sent).toHaveLength(7));
      const finalWrite = client.sent[6] as Record<string, unknown>;
      expect(JSON.parse(String(finalWrite.body)).value["thread-other"]).toEqual([
        expect.objectContaining({ id: "other-1", text: "Preserve another queue" }),
      ]);
      client.onMessage?.({
        type: "fetch-response",
        requestId: finalWrite.requestId,
        responseType: "success",
        status: 200,
        bodyJsonString: JSON.stringify({ success: true }),
      });

      await vi.waitFor(() => expect(messages).toContainEqual({
        id: 1801,
        error: {
          code: -32003,
          message: "Desktop could not confirm the promotion; the message was kept queued",
        },
      }));
      await transport.stop();
    },
  );

  it.each(["restore-read", "restore-write"])(
    "restarts queue recovery when disconnecting during %s",
    async (disconnectStage) => {
      const { client, messages, transport } = await createStartedTransport();
      client.queuePromotionResult = false;
      client.ownerRequestError = new Error("desktop-thread-owner-request-failed:Error: no active turn to steer");
      transport.send({
        id: 181,
        method: "desktop/queue/steer",
        params: { threadId: "thread-1", messageId: "queued-1", expectedTurnId: "turn-1" },
      });

      await vi.waitFor(() => expect(client.sent).toHaveLength(1));
      const readRequest = client.sent[0] as Record<string, unknown>;
      client.onMessage?.({
        type: "fetch-response",
        requestId: readRequest.requestId,
        responseType: "success",
        status: 200,
        bodyJsonString: JSON.stringify({ value: {
          "thread-1": [{ id: "queued-1", text: "Restore me", createdAt: 7 }],
        } }),
      });
      await vi.waitFor(() => expect(client.sent).toHaveLength(2));
      const removalWrite = client.sent[1] as Record<string, unknown>;
      client.onMessage?.({
        type: "fetch-response",
        requestId: removalWrite.requestId,
        responseType: "success",
        status: 200,
        bodyJsonString: JSON.stringify({ success: true }),
      });
      await vi.waitFor(() => expect(client.ownerRequests).toHaveLength(2));
      await vi.waitFor(() => expect(client.sent).toHaveLength(3));
      const restoreRead = client.sent[2] as Record<string, unknown>;
      if (disconnectStage === "restore-write") {
        client.onMessage?.({
          type: "fetch-response",
          requestId: restoreRead.requestId,
          responseType: "success",
          status: 200,
          bodyJsonString: JSON.stringify({ value: {} }),
        });
        await vi.waitFor(() => expect(client.sent).toHaveLength(4));
      }

      client.onDisconnect?.(new Error("renderer disconnected"));
      expect(messages.some((message) => "id" in message && message.id === 181)).toBe(false);
      await vi.waitFor(() => expect(transport.state).toBe("live"));
      const retryIndex = disconnectStage === "restore-write" ? 4 : 3;
      await vi.waitFor(() => expect(client.sent).toHaveLength(retryIndex + 1));
      const retryRead = client.sent[retryIndex] as Record<string, unknown>;
      expect(retryRead).toMatchObject({ url: "vscode://codex/get-global-state" });
      client.onMessage?.({
        type: "fetch-response",
        requestId: retryRead.requestId,
        responseType: "success",
        status: 200,
        bodyJsonString: JSON.stringify({ value: {} }),
      });
      await vi.waitFor(() => expect(client.sent).toHaveLength(retryIndex + 2));
      const retryWrite = client.sent[retryIndex + 1] as Record<string, unknown>;
      const restored = JSON.parse(String(retryWrite.body)).value["thread-1"];
      expect(restored.filter((message: Record<string, unknown>) => message.id === "queued-1"))
        .toHaveLength(1);
      client.onMessage?.({
        type: "fetch-response",
        requestId: retryWrite.requestId,
        responseType: "success",
        status: 200,
        bodyJsonString: JSON.stringify({ success: true }),
      });
      await vi.waitFor(() => expect(messages).toContainEqual({
        id: 181,
        error: {
          code: -32003,
          message: "Desktop could not confirm the promotion; the message was kept queued",
        },
      }));
      await transport.stop();
    },
  );

  it("releases foreground queue traffic after confirmation requests stop responding and recovers silently", async () => {
    const { client, messages, transport } = await createStartedTransport({
      queueRequestTimeoutMs: 100,
      queueRecoveryDeadlineMs: 300,
      queueRecoveryRetryDelayMs: 0,
    });
    client.queuePromotionResult = false;
    client.ownerRequestError = new Error("desktop-cdp-owner-call-timeout");
    transport.send({
      id: 182,
      method: "desktop/queue/steer",
      params: { threadId: "thread-1", messageId: "queued-1", expectedTurnId: "turn-1" },
    });

    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    const readRequest = client.sent[0] as Record<string, unknown>;
    client.onMessage?.({
      type: "fetch-response",
      requestId: readRequest.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ value: {
        "thread-1": [{ id: "queued-1", text: "Uncertain delivery", createdAt: 7 }],
      } }),
    });
    await vi.waitFor(() => expect(client.sent).toHaveLength(2));
    const removalWrite = client.sent[1] as Record<string, unknown>;
    client.onMessage?.({
      type: "fetch-response",
      requestId: removalWrite.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ success: true }),
    });
    await vi.waitFor(() => expect(client.sent.some((item) => (
      asTestRecord(asTestRecord(item).request).method === "thread/read"
    ))).toBe(true));

    transport.send({
      id: 183,
      method: "desktop/queue/add",
      params: { threadId: "thread-1", text: "Must not wait for recovery" },
    });
    await vi.waitFor(() => expect(messages).toContainEqual({
      id: 182,
      result: { messageId: "queued-1", pendingConfirmation: true },
    }));
    await vi.waitFor(() => expect(client.sent.some((item) => (
      asTestRecord(item).url === "vscode://codex/get-global-state" &&
      client.sent.indexOf(item) > 1
    ))).toBe(true));
    const nextRead = [...client.sent].reverse().find((item) => (
      asTestRecord(item).url === "vscode://codex/get-global-state"
    )) as Record<string, unknown>;
    client.onMessage?.({
      type: "fetch-response",
      requestId: nextRead.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ value: {} }),
    });
    await vi.waitFor(() => expect(client.sent.some((item) => (
      asTestRecord(item).url === "vscode://codex/set-global-state" &&
      client.sent.indexOf(item) > client.sent.indexOf(nextRead)
    ))).toBe(true));
    const nextWrite = [...client.sent].reverse().find((item) => (
      asTestRecord(item).url === "vscode://codex/set-global-state"
    )) as Record<string, unknown>;
    client.onMessage?.({
      type: "fetch-response",
      requestId: nextWrite.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ success: true }),
    });
    await vi.waitFor(() => expect(messages).toContainEqual({
      id: 183,
      result: { message: expect.objectContaining({ text: "Must not wait for recovery" }) },
    }));

    await vi.waitFor(() => expect(client.sent.some((item) => (
      String(asTestRecord(asTestRecord(item).request).id).startsWith("codex-remote-queue-confirm-") &&
      client.sent.indexOf(item) > client.sent.indexOf(nextWrite)
    ))).toBe(true), { timeout: 1_000 });
    const backgroundConfirmation = [...client.sent].reverse().find((item) => (
      String(asTestRecord(asTestRecord(item).request).id).startsWith("codex-remote-queue-confirm-")
    )) as Record<string, unknown>;
    const backgroundRequest = backgroundConfirmation.request as Record<string, unknown>;
    client.onMessage?.({
      type: "mcp-response",
      hostId: "local",
      message: {
        id: backgroundRequest.id,
        result: {
          thread: {
            id: "thread-1",
            turns: [{ items: [{ type: "userMessage", clientId: "queued-1" }] }],
          },
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(messages.filter((message) => "id" in message && (
      message.id === 182 || message.id === 183
    ))).toHaveLength(2);
    await transport.stop();
  });

  it("releases the serializer after repeated restore failures reach the recovery deadline", async () => {
    const { client, messages, transport } = await createStartedTransport({
      queueRequestTimeoutMs: 100,
      queueRecoveryDeadlineMs: 300,
      queueRecoveryRetryDelayMs: 0,
    });
    client.queuePromotionResult = false;
    client.ownerRequestError = new Error("desktop-thread-owner-request-failed:Error: no active turn to steer");
    transport.send({
      id: 184,
      method: "desktop/queue/steer",
      params: { threadId: "thread-1", messageId: "queued-1", expectedTurnId: "turn-1" },
    });

    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    const readRequest = client.sent[0] as Record<string, unknown>;
    client.onMessage?.({
      type: "fetch-response",
      requestId: readRequest.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ value: {
        "thread-1": [{ id: "queued-1", text: "Restore eventually", createdAt: 7 }],
      } }),
    });
    await vi.waitFor(() => expect(client.sent).toHaveLength(2));
    const removalWrite = client.sent[1] as Record<string, unknown>;
    client.onMessage?.({
      type: "fetch-response",
      requestId: removalWrite.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ success: true }),
    });
    transport.send({
      id: 185,
      method: "desktop/queue/add",
      params: { threadId: "thread-1", text: "Continue after restore deadline" },
    });

    for (let attempt = 0; attempt < 3; attempt += 1) {
      await vi.waitFor(() => expect(client.sent).toHaveLength(3 + attempt));
      const failedRestore = client.sent[2 + attempt] as Record<string, unknown>;
      expect(failedRestore).toMatchObject({ url: "vscode://codex/get-global-state" });
      client.onMessage?.({
        type: "fetch-response",
        requestId: failedRestore.requestId,
        responseType: "error",
        status: 503,
      });
    }

    await vi.waitFor(() => expect(messages).toContainEqual({
      id: 184,
      error: { code: -32006, message: "Desktop queue recovery continues in background" },
    }));
    await vi.waitFor(() => expect(client.sent.some((item) => (
      asTestRecord(item).url === "vscode://codex/get-global-state" &&
      client.sent.indexOf(item) >= 5
    ))).toBe(true));
    expect(messages.some((message) => "id" in message && message.id === 185)).toBe(false);
    await transport.stop();
  });

  it("round-robins deferred recoveries so one permanent failure cannot starve the next", async () => {
    const { client, messages, transport } = await createStartedTransport({
      queueRequestTimeoutMs: 60,
      queueRecoveryDeadlineMs: 180,
      queueRecoveryRetryDelayMs: 0,
    });
    client.queuePromotionResult = false;
    client.ownerRequestError = new Error("desktop-cdp-owner-call-timeout");

    const firstStart = client.sent.length;
    transport.send({
      id: 188,
      method: "desktop/queue/steer",
      params: { threadId: "thread-a", messageId: "queued-a", expectedTurnId: "turn-a" },
    });
    transport.send({
      id: 189,
      method: "desktop/queue/steer",
      params: { threadId: "thread-b", messageId: "queued-b", expectedTurnId: "turn-b" },
    });
    await vi.waitFor(() => expect(client.sent.length).toBeGreaterThan(firstStart));
    const firstRead = client.sent[firstStart] as Record<string, unknown>;
    client.onMessage?.({
      type: "fetch-response",
      requestId: firstRead.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ value: {
        "thread-a": [{ id: "queued-a", text: "First deferred", createdAt: 7 }],
      } }),
    });
    await vi.waitFor(() => expect(client.sent.length).toBeGreaterThan(firstStart + 1));
    const firstWrite = client.sent[firstStart + 1] as Record<string, unknown>;
    client.onMessage?.({
      type: "fetch-response",
      requestId: firstWrite.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ success: true }),
    });
    await vi.waitFor(() => expect(messages).toContainEqual({
      id: 188,
      result: { messageId: "queued-a", pendingConfirmation: true },
    }));

    const secondRead = [...client.sent].reverse().find((item) => (
      asTestRecord(item).url === "vscode://codex/get-global-state"
    )) as Record<string, unknown>;
    client.onMessage?.({
      type: "fetch-response",
      requestId: secondRead.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ value: {
        "thread-b": [{ id: "queued-b", text: "Second deferred", createdAt: 8 }],
      } }),
    });
    await vi.waitFor(() => expect(client.sent.some((item) => (
      asTestRecord(item).url === "vscode://codex/set-global-state" &&
      client.sent.indexOf(item) > client.sent.indexOf(secondRead)
    ))).toBe(true));
    const secondWrite = [...client.sent].reverse().find((item) => (
      asTestRecord(item).url === "vscode://codex/set-global-state"
    )) as Record<string, unknown>;
    client.onMessage?.({
      type: "fetch-response",
      requestId: secondWrite.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ success: true }),
    });
    await vi.waitFor(() => expect(messages).toContainEqual({
      id: 189,
      result: { messageId: "queued-b", pendingConfirmation: true },
    }));

    const backgroundStart = client.sent.length;
    await vi.waitFor(() => expect(client.sent.slice(backgroundStart).some((item) => (
      asTestRecord(asTestRecord(item).request).method === "thread/read" &&
      asTestRecord(asTestRecord(asTestRecord(item).request).params).threadId === "thread-a"
    ))).toBe(true), { timeout: 1_000 });
    await vi.waitFor(() => expect(client.sent.slice(backgroundStart).some((item) => (
      asTestRecord(asTestRecord(item).request).method === "thread/read" &&
      asTestRecord(asTestRecord(asTestRecord(item).request).params).threadId === "thread-b"
    ))).toBe(true), { timeout: 1_500 });
    const secondBackground = [...client.sent].reverse().find((item) => (
      asTestRecord(asTestRecord(item).request).method === "thread/read" &&
      asTestRecord(asTestRecord(asTestRecord(item).request).params).threadId === "thread-b"
    )) as Record<string, unknown>;
    const secondBackgroundRequest = secondBackground.request as Record<string, unknown>;
    client.onMessage?.({
      type: "mcp-response",
      hostId: "local",
      message: {
        id: secondBackgroundRequest.id,
        result: {
          thread: {
            id: "thread-b",
            turns: [{ items: [{ type: "userMessage", clientId: "queued-b" }] }],
          },
        },
      },
    });
    await new Promise((resolve) => setTimeout(resolve, 25));
    expect(messages.filter((message) => "id" in message && (
      message.id === 188 || message.id === 189
    ))).toHaveLength(2);
    await transport.stop();
  });

  it("keeps an add exactly once when its global-state write response is lost", async () => {
    const { client, messages, transport } = await createStartedTransport({
      queueRequestTimeoutMs: 75,
      queueRecoveryDeadlineMs: 1_000,
    });
    transport.send({
      id: 186,
      method: "desktop/queue/add",
      params: { threadId: "thread-1", text: "Persist despite a lost response" },
    });

    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    const initialRead = client.sent[0] as Record<string, unknown>;
    client.onMessage?.({
      type: "fetch-response",
      requestId: initialRead.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ value: {} }),
    });
    await vi.waitFor(() => expect(client.sent).toHaveLength(2));
    const timedOutWrite = client.sent[1] as Record<string, unknown>;
    const intendedMessage = JSON.parse(String(timedOutWrite.body)).value["thread-1"][0];

    await vi.waitFor(() => expect(client.sent).toHaveLength(3));
    const recoveryRead = client.sent[2] as Record<string, unknown>;
    expect(recoveryRead).toMatchObject({ url: "vscode://codex/get-global-state" });
    client.onMessage?.({
      type: "fetch-response",
      requestId: recoveryRead.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ value: { "thread-1": [intendedMessage] } }),
    });
    await vi.waitFor(() => expect(client.sent).toHaveLength(4));
    const recoveryWrite = client.sent[3] as Record<string, unknown>;
    const recovered = JSON.parse(String(recoveryWrite.body)).value["thread-1"];
    expect(recovered.filter((message: Record<string, unknown>) => message.id === intendedMessage.id))
      .toHaveLength(1);
    client.onMessage?.({
      type: "fetch-response",
      requestId: recoveryWrite.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ success: true }),
    });

    await vi.waitFor(() => expect(messages).toContainEqual({
      id: 186,
      result: {
        message: expect.objectContaining({ id: intendedMessage.id }),
        pendingConfirmation: true,
      },
    }));
    await transport.stop();
  });

  it("continues add write-timeout recovery across a Desktop reconnect", async () => {
    const { client, messages, transport } = await createStartedTransport({
      queueRequestTimeoutMs: 75,
      queueRecoveryDeadlineMs: 1_000,
    });
    transport.send({
      id: 1861,
      method: "desktop/queue/add",
      params: { threadId: "thread-1", text: "Recover after reconnect" },
    });

    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    const initialRead = client.sent[0] as Record<string, unknown>;
    client.onMessage?.({
      type: "fetch-response",
      requestId: initialRead.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ value: {} }),
    });
    await vi.waitFor(() => expect(client.sent).toHaveLength(2));
    const intendedMessage = JSON.parse(String((client.sent[1] as Record<string, unknown>).body))
      .value["thread-1"][0];
    await vi.waitFor(() => expect(client.sent).toHaveLength(3));

    client.onDisconnect?.(new Error("renderer disconnected during add recovery"));
    expect(messages.some((message) => "id" in message && message.id === 1861)).toBe(false);
    await vi.waitFor(() => expect(transport.state).toBe("live"));
    await vi.waitFor(() => expect(client.sent).toHaveLength(4));
    const retryRead = client.sent[3] as Record<string, unknown>;
    client.onMessage?.({
      type: "fetch-response",
      requestId: retryRead.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ value: { "thread-1": [intendedMessage] } }),
    });
    await vi.waitFor(() => expect(client.sent).toHaveLength(5));
    const retryWrite = client.sent[4] as Record<string, unknown>;
    client.onMessage?.({
      type: "fetch-response",
      requestId: retryWrite.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ success: true }),
    });

    await vi.waitFor(() => expect(messages).toContainEqual({
      id: 1861,
      result: {
        message: expect.objectContaining({ id: intendedMessage.id }),
        pendingConfirmation: true,
      },
    }));
    expect(messages.filter((message) => "id" in message && message.id === 1861)).toHaveLength(1);
    await transport.stop();
  });

  it("restores rather than promotes when a steer removal write response is lost", async () => {
    const { client, messages, transport } = await createStartedTransport({
      queueRequestTimeoutMs: 75,
      queueRecoveryDeadlineMs: 1_000,
    });
    client.queuePromotionResult = false;
    transport.send({
      id: 187,
      method: "desktop/queue/steer",
      params: { threadId: "thread-1", messageId: "queued-1", expectedTurnId: "turn-1" },
    });

    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    const initialRead = client.sent[0] as Record<string, unknown>;
    client.onMessage?.({
      type: "fetch-response",
      requestId: initialRead.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ value: {
        "thread-1": [{ id: "queued-1", text: "Keep safely queued", createdAt: 7 }],
      } }),
    });
    await vi.waitFor(() => expect(client.sent).toHaveLength(2));

    await vi.waitFor(() => expect(client.sent).toHaveLength(3));
    const recoveryRead = client.sent[2] as Record<string, unknown>;
    client.onMessage?.({
      type: "fetch-response",
      requestId: recoveryRead.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ value: {} }),
    });
    await vi.waitFor(() => expect(client.sent).toHaveLength(4));
    const recoveryWrite = client.sent[3] as Record<string, unknown>;
    expect(JSON.parse(String(recoveryWrite.body)).value["thread-1"]).toEqual([
      expect.objectContaining({ id: "queued-1", text: "Keep safely queued" }),
    ]);
    client.onMessage?.({
      type: "fetch-response",
      requestId: recoveryWrite.requestId,
      responseType: "success",
      status: 200,
      bodyJsonString: JSON.stringify({ success: true }),
    });

    await vi.waitFor(() => expect(messages).toContainEqual({
      id: 187,
      error: {
        code: -32003,
        message: "Desktop could not confirm the promotion; the message was kept queued",
      },
    }));
    expect(client.ownerRequests).toEqual([]);
    await transport.stop();
  });

  it("updates settings through the Desktop thread owner so the Desktop UI stays in sync", async () => {
    const { client, messages, transport } = await createStartedTransport();
    transport.send({
      id: 21,
      method: "thread/settings/update",
      params: {
        threadId: "thread-1",
        model: "gpt-5.6-sol",
        effort: "high",
        approvalPolicy: "never",
        sandboxPolicy: { type: "danger-full-access" },
      },
    });

    await vi.waitFor(() => expect(client.ownerRequests).toHaveLength(1));
    expect(client.ownerRequests[0]).toEqual({
      method: "thread-follower-update-thread-settings",
      params: {
        conversationId: "thread-1",
        threadSettings: {
          model: "gpt-5.6-sol",
          effort: "high",
          approvalPolicy: "never",
          sandboxPolicy: { type: "danger-full-access" },
        },
      },
    });
    expect(messages).toContainEqual({ id: 21, result: { ok: true } });
    expect(client.sent).toEqual([]);
    await transport.stop();
  });

  it("steers through the Desktop thread owner so the user message appears in Desktop", async () => {
    const { client, messages, transport } = await createStartedTransport();
    client.ownerRequestResult = {
      method: "thread-follower-steer-turn",
      result: { result: { turnId: "turn-1" } },
    };
    transport.send({
      id: 22,
      method: "turn/steer",
      params: {
        threadId: "thread-1",
        expectedTurnId: "turn-1",
        clientMessageId: "client-message-1",
        cwd: "/safe/project",
        input: [
          { type: "text", text: "Continue from the phone" },
          { type: "localImage", path: "/safe/upload/image.png" },
        ],
      },
    });

    await vi.waitFor(() => expect(client.ownerRequests).toHaveLength(1));
    const ownerRequest = client.ownerRequests[0];
    expect(ownerRequest?.method).toBe("thread-follower-steer-turn");
    expect(ownerRequest?.params).toMatchObject({
      conversationId: "thread-1",
      input: [
        { type: "text", text: "Continue from the phone", text_elements: [] },
        { type: "localImage", path: "/safe/upload/image.png" },
      ],
      restoreMessage: {
        text: "Continue from the phone",
        context: {
          prompt: "Continue from the phone",
          addedFiles: [],
          fileAttachments: [],
          imageAttachments: [],
          workspaceRoots: ["/safe/project"],
        },
        cwd: "/safe/project",
      },
    });
    expect(ownerRequest?.params).toMatchObject({
      clientUserMessageId: "client-message-1",
      restoreMessage: { id: "client-message-1", createdAt: expect.any(Number) },
    });
    expect(messages).toContainEqual({ id: 22, result: { turnId: "turn-1" } });
    expect(client.sent).toEqual([]);
    await transport.stop();
  });

  it("falls back to App Server when the Desktop thread is not open", async () => {
    const { client, transport } = await createStartedTransport();
    client.ownerRequestError = new Error("desktop-thread-owner-unavailable");
    transport.send({
      id: 23,
      method: "turn/steer",
      params: { threadId: "thread-closed", input: [{ type: "text", text: "Continue" }] },
    });

    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    expect(client.sent[0]).toMatchObject({
      type: "mcp-request",
      request: {
        id: 23,
        method: "turn/steer",
        params: { threadId: "thread-closed", input: [{ type: "text", text: "Continue" }] },
      },
    });
    await transport.stop();
  });

  it("falls back when Desktop reports a stale thread owner timeout", async () => {
    const { client, messages, transport } = await createStartedTransport();
    client.ownerRequestError = new Error("desktop-thread-owner-request-failed:Error: timeout");
    transport.send({
      id: 24,
      method: "turn/steer",
      params: { threadId: "thread-stale", input: [{ type: "text", text: "Continue" }] },
    });

    await vi.waitFor(() => expect(client.sent).toHaveLength(1));
    expect(client.sent[0]).toMatchObject({
      type: "mcp-request",
      request: { id: 24, method: "turn/steer" },
    });
    expect(messages).toEqual([]);
    await transport.stop();
  });

  it("becomes read-only when the renderer disconnects", async () => {
    const { client, diagnostics, transport } = await createStartedTransport();
    expect(transport.state).toBe("live");
    client.onDisconnect?.();
    expect(transport.state).toBe("read-only");
    expect(diagnostics).toContain("Desktop bridge disconnected; Desktop threads are read-only");
    expect(() => transport.send({ id: 5, method: "thread/list", params: {} }))
      .toThrow("desktop-bridge-read-only");
    await transport.stop();
  });

  it("reattaches and becomes live after the renderer disconnects", async () => {
    const client = new FakeBridgeClient();
    const diagnostics: string[] = [];
    const transport = new DesktopBridgeTransport({
      client,
      appServerVersion: "0.148.0-alpha.15",
      reconnectDelayMs: 0,
    });
    await transport.start(() => undefined, (diagnostic) => diagnostics.push(diagnostic.message));

    client.onDisconnect?.();
    await vi.waitFor(() => expect(client.startCalls).toBe(2));

    expect(transport.state).toBe("live");
    expect(diagnostics).toContain("Desktop bridge reconnected");
    await transport.stop();
  });

  it("returns to live when Desktop reconnects its App Server", async () => {
    const { client, diagnostics, transport } = await createStartedTransport();

    client.onMessage?.({
      type: "codex-app-server-connection-changed",
      hostId: "local",
      state: "disconnected",
    });
    expect(transport.state).toBe("read-only");

    client.onMessage?.({
      type: "codex-app-server-connection-changed",
      hostId: "local",
      state: "connected",
    });

    expect(transport.state).toBe("live");
    expect(diagnostics).toContain("Desktop bridge reconnected");
    expect(client.startCalls).toBe(1);
    await transport.stop();
  });

  it("actively probes the Desktop App Server until a read-only bridge recovers", async () => {
    const client = new FakeBridgeClient();
    const diagnostics: string[] = [];
    const transport = new DesktopBridgeTransport({
      client,
      appServerVersion: "0.148.0-alpha.15",
      appServerProbeIntervalMs: 1,
      appServerDisconnectGraceMs: 0,
    });
    await transport.start(() => undefined, (diagnostic) => diagnostics.push(diagnostic.message));

    client.onMessage?.({
      type: "codex-app-server-connection-changed",
      hostId: "local",
      state: "disconnected",
    });
    await vi.waitFor(() => expect(client.sent.length).toBeGreaterThan(0));
    const probe = client.sent.at(-1) as any;
    expect(probe).toMatchObject({
      type: "mcp-request",
      hostId: "local",
      request: { method: "thread/list", params: { limit: 1 } },
    });

    client.onMessage?.({
      type: "mcp-response",
      hostId: "local",
      message: { id: probe.request.id, result: { data: [] } },
    });

    expect(transport.state).toBe("live");
    expect(diagnostics).toContain("Desktop bridge reconnected");
    await transport.stop();
  });

  it("treats any valid App Server response as proof that a stale disconnected event recovered", async () => {
    const { client, diagnostics, messages, transport } = await createStartedTransport();

    client.onMessage?.({
      type: "codex-app-server-connection-changed",
      hostId: "local",
      state: "disconnected",
    });
    expect(transport.state).toBe("read-only");

    client.onMessage?.({
      type: "mcp-response",
      hostId: "local",
      message: { id: "gateway-internal-3", result: { data: [] } },
    });

    expect(transport.state).toBe("live");
    expect(diagnostics).toContain("Desktop bridge reconnected");
    expect(messages).toContainEqual({ id: "gateway-internal-3", result: { data: [] } });
    await transport.stop();
  });

  it("does not flicker into read-only when Desktop answers during the disconnect grace period", async () => {
    vi.useFakeTimers();
    const client = new FakeBridgeClient();
    const diagnostics: string[] = [];
    const transport = new DesktopBridgeTransport({
      client,
      appServerVersion: "0.148.0-alpha.15",
      appServerDisconnectGraceMs: 1_500,
    });
    await transport.start(() => undefined, (diagnostic) => diagnostics.push(diagnostic.message));

    client.onMessage?.({
      type: "codex-app-server-connection-changed",
      hostId: "local",
      state: "disconnected",
    });
    expect(transport.state).toBe("live");
    client.onMessage?.({
      type: "mcp-response",
      hostId: "local",
      message: { id: "gateway-internal-4", result: { data: [] } },
    });
    await vi.advanceTimersByTimeAsync(2_000);

    expect(transport.state).toBe("live");
    expect(diagnostics).not.toContain("Desktop bridge disconnected; Desktop threads are read-only");
    await transport.stop();
    vi.useRealTimers();
  });
});
