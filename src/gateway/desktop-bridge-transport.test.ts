import { describe, expect, it, vi } from "vitest";
import type { RpcMessage } from "../protocol/types";
import { DesktopBridgeTransport, type DesktopBridgeClient } from "./desktop-bridge-transport";

class FakeBridgeClient implements DesktopBridgeClient {
  sent: unknown[] = [];
  ownerRequests: Array<{ method: string; params: unknown }> = [];
  ownerRequestResult: unknown = { method: "thread-follower-update-thread-settings", result: { ok: true } };
  ownerRequestError?: Error;
  startCalls = 0;
  onMessage?: (message: unknown) => void;
  onDisconnect?: () => void;

  async start(onMessage: (message: unknown) => void, onDisconnect: () => void) {
    this.startCalls += 1;
    this.onMessage = onMessage;
    this.onDisconnect = onDisconnect;
  }

  async sendDesktopMessage(message: unknown) {
    this.sent.push(message);
  }

  async requestThreadOwner(method: string, params: unknown) {
    this.ownerRequests.push({ method, params });
    if (this.ownerRequestError) throw this.ownerRequestError;
    return this.ownerRequestResult;
  }

  async stop() {}
}

function createStartedTransport() {
  const client = new FakeBridgeClient();
  const messages: RpcMessage[] = [];
  const diagnostics: string[] = [];
  const transport = new DesktopBridgeTransport({
    client,
    appServerVersion: "0.148.0-alpha.15",
  });
  return transport.start(
    (message) => messages.push(message),
    (diagnostic) => diagnostics.push(diagnostic.message),
  ).then(() => ({ client, messages, diagnostics, transport }));
}

describe("DesktopBridgeTransport", () => {
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
      clientUserMessageId: expect.any(String),
      restoreMessage: { id: expect.any(String), createdAt: expect.any(Number) },
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
});
