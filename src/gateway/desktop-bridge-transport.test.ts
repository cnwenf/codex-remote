import { describe, expect, it, vi } from "vitest";
import type { RpcMessage } from "../protocol/types";
import { DesktopBridgeTransport, type DesktopBridgeClient } from "./desktop-bridge-transport";

class FakeBridgeClient implements DesktopBridgeClient {
  sent: unknown[] = [];
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
});
