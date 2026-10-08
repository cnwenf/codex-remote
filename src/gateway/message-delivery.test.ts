// @vitest-environment node
import { once } from "node:events";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { describe, expect, it, vi } from "vitest";
import type { CodexTransport, RpcMessage } from "../protocol/types";
import { createGateway } from "./server";
import { MessageDeliveries } from "./message-delivery";

class DelayedTransport implements CodexTransport {
  readonly requiresInitialize = false;
  sent: RpcMessage[] = [];
  emit: (message: RpcMessage) => void = () => {};
  async start(onMessage: (message: RpcMessage) => void) { this.emit = onMessage; }
  send(message: RpcMessage) { this.sent.push(message); }
  async stop() {}
  getSessionInfo() { return { transport: "desktop-live" as const, readOnly: false }; }
}

async function fixture() {
  const transport = new DelayedTransport();
  const uploadDir = await mkdtemp(join(tmpdir(), "codex-delivery-test-"));
  const gateway = createGateway({ port: 0, token: "test-token", transport, uploadDir });
  const address = await gateway.start();
  const sockets: WebSocket[] = [];
  async function connect() {
    const socket = new WebSocket(`ws://127.0.0.1:${address.port}/rpc`, [
      "codex-local", `token.${Buffer.from("test-token").toString("base64url")}`,
    ], { origin: `http://127.0.0.1:${address.port}` });
    sockets.push(socket);
    const messages: any[] = [];
    socket.on("message", (raw) => messages.push(JSON.parse(raw.toString())));
    await once(socket, "open");
    const rpc = (id: number, method: string, params: unknown) => socket.send(JSON.stringify({
      type: "rpc", payload: { id, method, params },
    }));
    return { socket, messages, rpc };
  }
  return { transport, connect, async close() {
    for (const socket of sockets) {
      if (socket.readyState === WebSocket.CLOSED) continue;
      socket.close(); await once(socket, "close");
    }
    await gateway.stop();
    await rm(uploadDir, { recursive: true, force: true });
  } };
}

describe("server-owned message delivery", () => {
  it.each(["start", "promote"])("acknowledges %s before Desktop responds and replays its outcome after disconnect", async (operation) => {
    const f = await fixture();
    try {
      const c = await f.connect();
      c.rpc(1, "gateway/message/submit", { id: "delivery-1", operation, params: {
        threadId: "t1", input: [{ type: "text", text: "Continue" }], messageId: "queued-1",
      } });
      await vi.waitFor(() => expect(c.messages.find((m) => m.payload?.id === 1)?.payload.result)
        .toMatchObject({ id: "delivery-1", status: "accepted" }));
      const request = f.transport.sent.find((m) => "method" in m && m.method ===
        (operation === "start" ? "turn/start" : "desktop/queue/steer"))!;
      expect(request).toBeDefined();
      c.socket.close(); await once(c.socket, "close");
      f.transport.emit({ id: (request as { id: string }).id, result: { turn: { id: "turn-2" } } });
      const next = await f.connect();
      await vi.waitFor(() => expect(next.messages.some((m) => m.payload?.method === "gateway/message/updated" &&
        m.payload.params.id === "delivery-1" && m.payload.params.status === "delivered")).toBe(true));
      next.rpc(2, "gateway/message/submit", { id: "delivery-1", operation, params: {
        threadId: "t1", input: [{ type: "text", text: "Continue" }], messageId: "queued-1",
      } });
      await vi.waitFor(() => expect(next.messages.find((m) => m.payload?.id === 2)?.payload.result.status).toBe("delivered"));
      expect(f.transport.sent.filter((m) => "method" in m && "method" in request && m.method === request.method)).toHaveLength(1);
    } finally { await f.close(); }
  });

  it("finishes queue then guide entirely on the server after the client closes", async () => {
    const f = await fixture();
    try {
      const c = await f.connect();
      c.rpc(1, "gateway/message/submit", { id: "guide-1", operation: "guide", params: {
        threadId: "t1", text: "Guide now", input: [{ type: "text", text: "Guide now" }], expectedTurnId: "active",
      } });
      await vi.waitFor(() => expect(c.messages.find((m) => m.payload?.id === 1)?.payload.result.status).toBe("accepted"));
      const add = f.transport.sent.find((m) => "method" in m && m.method === "desktop/queue/add")!;
      c.socket.close(); await once(c.socket, "close");
      f.transport.emit({ id: (add as { id: string }).id, result: { message: { id: "queued-1" } } });
      await vi.waitFor(() => expect(f.transport.sent.find((m) => "method" in m && m.method === "desktop/queue/steer"))
        .toMatchObject({ params: { threadId: "t1", messageId: "queued-1", expectedTurnId: "active" } }));
    } finally { await f.close(); }
  });

  it("queues a second rapid send after the first accepted start becomes active", async () => {
    const f = await fixture();
    try {
      const c = await f.connect();
      for (const id of [1, 2]) c.rpc(id, "gateway/message/submit", { id: `start-${id}`, operation: "start", params: {
        threadId: "t1", input: [{ type: "text", text: `Message ${id}` }],
      } });
      await vi.waitFor(() => expect(c.messages.filter((m) => m.payload?.result?.status === "accepted")).toHaveLength(2));
      const start = f.transport.sent.find((m) => "method" in m && m.method === "turn/start")!;
      expect(f.transport.sent.filter((m) => "method" in m && m.method === "turn/start")).toHaveLength(1);
      f.transport.emit({ method: "turn/started", params: { threadId: "t1", turn: { id: "active" } } });
      f.transport.emit({ id: (start as { id: string }).id, result: {} });
      await vi.waitFor(() => expect(f.transport.sent.find((m) => "method" in m && m.method === "desktop/queue/add"))
        .toMatchObject({ params: { text: "Message 2" } }));
    } finally { await f.close(); }
  });

  it("resolves socket-uploaded images before acceptance, without exposing local paths", async () => {
    const f = await fixture();
    try {
      const c = await f.connect();
      c.rpc(1, "gateway/image/upload", { name: "pixel.png", mimeType: "image/png",
        data: "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=" });
      await vi.waitFor(() => expect(c.messages.find((m) => m.payload?.id === 1)?.payload.result.id).toEqual(expect.any(String)));
      const imageId = c.messages.find((m) => m.payload?.id === 1).payload.result.id;
      c.rpc(2, "gateway/message/submit", { id: "image-1", operation: "start", params: {
        threadId: "t1", input: [{ type: "remoteImage", id: imageId }],
      } });
      await vi.waitFor(() => expect(c.messages.find((m) => m.payload?.id === 2)?.payload.result.status).toBe("accepted"));
      expect(f.transport.sent.find((m) => "method" in m && m.method === "turn/start"))
        .toMatchObject({ params: { input: [{ type: "localImage", path: expect.any(String) }] } });
      expect(JSON.stringify(c.messages)).not.toContain("localImage");
      c.rpc(3, "gateway/message/submit", { id: "forged", operation: "start", params: {
        threadId: "t1", input: [{ type: "localImage", path: "/private/forged.png" }],
      } });
      await vi.waitFor(() => expect(c.messages.find((m) => m.payload?.id === 3)?.payload.error).toBeDefined());
      expect(f.transport.sent.filter((m) => "method" in m && m.method === "turn/start")).toHaveLength(1);
    } finally { await f.close(); }
  });

  it("retries only the failed guide step and never retries an uncertain delivery", async () => {
    const request = vi.fn().mockResolvedValueOnce({ message: { id: "queued-1" } })
      .mockRejectedValueOnce(new Error("Invalid request"))
      .mockResolvedValueOnce({})
      .mockRejectedValueOnce(new Error("gateway-internal-request-timeout"))
      .mockRejectedValueOnce(Object.assign(new Error("Desktop queue promotion failed"), { rpcCode: -32003 }));
    const updated = vi.fn();
    const deliveries = new MessageDeliveries(request, updated);
    const submission = { id: "guide-1", operation: "guide" as const, params: { threadId: "t1", text: "Guide", input: [] } };
    deliveries.submit(submission);
    await vi.waitFor(() => expect(deliveries.snapshots()[0].status).toBe("failed"));
    deliveries.retry("guide-1");
    await vi.waitFor(() => expect(deliveries.snapshots()[0].status).toBe("delivered"));
    expect(request.mock.calls.map(([method]) => method)).toEqual(["desktop/queue/add", "desktop/queue/steer", "desktop/queue/steer"]);
    deliveries.submit({ id: "start-1", operation: "start", params: { threadId: "t1", input: [] } });
    await vi.waitFor(() => expect(deliveries.snapshots()[1].status).toBe("uncertain"));
    expect(() => deliveries.retry("start-1")).toThrow("只可重试已确认失败");
    deliveries.submit({ id: "promote-1", operation: "promote", params: { threadId: "t1", messageId: "queued-2" } });
    await vi.waitFor(() => expect(deliveries.snapshots()[2].status).toBe("uncertain"));
    expect(() => deliveries.retry("promote-1")).toThrow("只可重试已确认失败");
    expect(() => deliveries.submit({ ...submission, params: { threadId: "other" } })).toThrow("另一条消息");
  });
});
