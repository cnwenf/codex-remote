// @vitest-environment node

import { once } from "node:events";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import WebSocket from "ws";
import { describe, expect, it } from "vitest";
import type {
  CodexTransport,
  RpcMessage,
  TransportDiagnostic,
} from "../protocol/types";
import { createGateway } from "./server";

class FakeTransport implements CodexTransport {
  sent: RpcMessage[] = [];
  private onMessage: ((message: RpcMessage) => void) | undefined;

  async start(
    onMessage: (message: RpcMessage) => void,
    _onDiagnostic: (diagnostic: TransportDiagnostic) => void,
  ) {
    this.onMessage = onMessage;
  }

  send(message: RpcMessage) {
    this.sent.push(message);
    if ("method" in message && message.method === "initialize" && "id" in message) {
      queueMicrotask(() => this.emit({ id: message.id, result: { ready: true } }));
    }
  }

  emit(message: RpcMessage) {
    this.onMessage?.(message);
  }

  async stop() {}
}

class AlreadyInitializedTransport extends FakeTransport {
  readonly requiresInitialize = false;
  getSessionInfo() {
    return {
      transport: "desktop-live" as const,
      readOnly: false,
      appServerVersion: "0.148.0-alpha.15",
    };
  }
}

class ReadOnlyTransport extends FakeTransport {
  readonly requiresInitialize = false;
  getSessionInfo() {
    return {
      transport: "desktop-cold" as const,
      readOnly: true,
      appServerVersion: "0.148.0-alpha.15",
    };
  }

  override send() {
    throw new Error("desktop-bridge-read-only");
  }
}

function protocols(token: string) {
  return ["codex-local", `token.${Buffer.from(token).toString("base64url")}`];
}

const messageQueues = new WeakMap<WebSocket, Buffer[]>();

async function connect(
  address: AddressInfo,
  token: string | undefined,
  origin: string,
  cookie?: string,
  autoPong = true,
) {
  const socket = new WebSocket(
    `ws://127.0.0.1:${address.port}/rpc`,
    token === undefined ? ["codex-local"] : protocols(token),
    {
      origin,
      autoPong,
      ...(cookie ? { headers: { cookie } } : {}),
    },
  );
  const queue: Buffer[] = [];
  messageQueues.set(socket, queue);
  socket.on("message", (data) => queue.push(Buffer.from(data as Buffer)));
  await once(socket, "open");
  return socket;
}

async function nextJson(socket: WebSocket) {
  const queue = messageQueues.get(socket);
  if (!queue) throw new Error("Socket was not created by connect");
  while (queue.length === 0) {
    await new Promise((resolve) => setTimeout(resolve, 1));
  }
  const data = queue.shift() as Buffer;
  return JSON.parse(data.toString("utf8"));
}

async function waitForSentMethod(transport: FakeTransport, method: string) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const message = transport.sent.find(
      (candidate) => "method" in candidate && candidate.method === method,
    );
    if (message) return message;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for forwarded ${method} request`);
}

async function waitForSentRequests(transport: FakeTransport, method: string, count: number) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const messages = transport.sent.filter(
      (candidate) => "method" in candidate && candidate.method === method,
    );
    if (messages.length >= count) return messages;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for ${count} forwarded ${method} requests`);
}

async function waitForSentResponse(transport: FakeTransport, id: string | number) {
  const deadline = Date.now() + 1_000;
  while (Date.now() < deadline) {
    const message = transport.sent.find(
      (candidate) => "id" in candidate && !("method" in candidate) && candidate.id === id,
    );
    if (message) return message;
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
  throw new Error(`Timed out waiting for forwarded response ${id}`);
}

describe("gateway server", () => {
  it("terminates a controller that stops answering heartbeat pings", async () => {
    const gateway = createGateway({
      port: 0,
      token: "test-token",
      transport: new AlreadyInitializedTransport(),
      heartbeatIntervalMs: 10,
    });
    const address = await gateway.start();
    const socket = await connect(
      address,
      "test-token",
      `http://127.0.0.1:${address.port}`,
      undefined,
      false,
    );
    await nextJson(socket);

    await once(socket, "close");
    expect(socket.readyState).toBe(WebSocket.CLOSED);
    await gateway.stop();
  });

  it("initializes App Server before accepting browser work", async () => {
    const transport = new FakeTransport();
    const gateway = createGateway({ port: 0, token: "test-token", transport });

    await gateway.start();
    expect(transport.sent[0]).toMatchObject({
      method: "initialize",
      params: { clientInfo: { name: "codex-remote" } },
    });
    await gateway.stop();
  });

  it("does not initialize Desktop's already-running App Server connection", async () => {
    const transport = new AlreadyInitializedTransport();
    const gateway = createGateway({ port: 0, token: "test-token", transport });

    const address = await gateway.start();
    expect(transport.sent).toEqual([]);
    const socket = await connect(address, "test-token", `http://127.0.0.1:${address.port}`);
    await expect(nextJson(socket)).resolves.toMatchObject({
      type: "session",
      state: "ready",
      transport: "desktop-live",
      readOnly: false,
      appServerVersion: "0.148.0-alpha.15",
    });
    socket.close();
    await once(socket, "close");
    await gateway.stop();
  });

  it("accepts an authenticated Capacitor WebView controller", async () => {
    const gateway = createGateway({
      port: 0,
      token: "test-token",
      transport: new AlreadyInitializedTransport(),
    });
    const address = await gateway.start();
    const socket = await connect(address, "test-token", "capacitor://localhost");
    await expect(nextJson(socket)).resolves.toMatchObject({ type: "session", state: "ready" });
    socket.close();
    await once(socket, "close");
    await gateway.stop();
  });

  it("defaults to loopback", async () => {
    const gateway = createGateway({
      port: 0,
      token: "test-token",
      transport: new FakeTransport(),
    });

    const address = await gateway.start();
    expect(address.address).toBe("127.0.0.1");
    await gateway.stop();
  });

  it("serves a no-store app shell and a build fingerprint for open clients", async () => {
    const staticDir = await mkdtemp(join(tmpdir(), "codex-remote-static-"));
    await writeFile(join(staticDir, "index.html"), "<main>build-one</main>");
    const gateway = createGateway({
      port: 0,
      token: "test-token",
      staticDir,
      transport: new FakeTransport(),
    });

    const address = await gateway.start();
    try {
      const shell = await fetch(`http://127.0.0.1:${address.port}/`);
      expect(shell.headers.get("cache-control")).toBe("no-store");
      const version = await fetch(`http://127.0.0.1:${address.port}/app-version`);
      expect(version.headers.get("cache-control")).toBe("no-store");
      await expect(version.json()).resolves.toEqual({
        version: expect.stringMatching(/^[0-9a-f]{16}$/),
      });
    } finally {
      await gateway.stop();
      await rm(staticDir, { recursive: true, force: true });
    }
  });

  it("serves a bounded mobile status snapshot to Bearer and browser-session authentication", async () => {
    const token = "test-token";
    const origin = "http://127.0.0.1:4310";
    const desktopState = {
      request(method: string) {
        expect(method).toBe("desktopState/listThreads");
        return {
          data: [{
            id: "task-1",
            title: "Active task",
            status: "running",
            updatedAt: 42,
            cwd: "/must/not/leak",
            turns: [{ items: [{ text: "private output" }] }],
          }],
        };
      },
      close() {},
    };
    const gateway = createGateway({
      port: 0,
      token,
      allowedOrigins: [origin],
      desktopState,
      transport: new AlreadyInitializedTransport(),
    });
    const address = await gateway.start();
    try {
      const unauthenticated = await fetch(`http://127.0.0.1:${address.port}/api/mobile/status`);
      expect(unauthenticated.status).toBe(401);

      const bearer = await fetch(`http://127.0.0.1:${address.port}/api/mobile/status`, {
        headers: { authorization: `Bearer ${token}` },
      });
      expect(bearer.status).toBe(200);
      expect(bearer.headers.get("cache-control")).toBe("no-store");
      const body = await bearer.json() as Record<string, unknown>;
      expect(body).toMatchObject({
        version: 1,
        threads: [{ id: "task-1", title: "Active task", status: "running", updatedAt: 42 }],
      });
      expect(JSON.stringify(body)).not.toMatch(/must\/not\/leak|private output/);

      const login = await fetch(`http://127.0.0.1:${address.port}/auth/session`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const cookie = login.headers.get("set-cookie")?.split(";", 1)[0] as string;
      const session = await fetch(`http://127.0.0.1:${address.port}/api/mobile/status`, {
        headers: { cookie },
      });
      expect(session.status).toBe(200);

      const wrongMethod = await fetch(`http://127.0.0.1:${address.port}/api/mobile/status`, {
        method: "POST",
        headers: { authorization: `Bearer ${token}` },
      });
      expect(wrongMethod.status).toBe(405);
    } finally {
      await gateway.stop();
    }
  });

  it("answers native WebView CORS preflight for authenticated mobile APIs", async () => {
    const gateway = createGateway({
      port: 0,
      token: "test-token",
      desktopState: { request: () => ({ data: [] }), close() {} },
      transport: new AlreadyInitializedTransport(),
    });
    const address = await gateway.start();
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}/api/mobile/status`, {
        method: "OPTIONS",
        headers: {
          origin: "capacitor://localhost",
          "access-control-request-method": "GET",
          "access-control-request-headers": "authorization",
        },
      });
      expect(response.status).toBe(204);
      expect(response.headers.get("access-control-allow-origin")).toBe("capacitor://localhost");
      expect(response.headers.get("access-control-allow-methods")).toContain("GET");
      expect(response.headers.get("access-control-allow-headers")).toContain("Authorization");
    } finally {
      await gateway.stop();
    }
  });

  it("serves the same gateway on an additional bind host", async () => {
    const gateway = createGateway({
      host: "127.0.0.1",
      additionalHosts: ["::1"],
      port: 0,
      token: "test-token",
      transport: new FakeTransport(),
    });

    const address = await gateway.start();
    try {
      const response = await fetch(`http://[::1]:${address.port}/health`);
      expect(response.status).toBe(200);
      await expect(response.json()).resolves.toEqual({ ok: true });
    } finally {
      await gateway.stop();
    }
  });

  it("rejects a wrong token", async () => {
    const origin = "http://127.0.0.1:4310";
    const gateway = createGateway({
      port: 0,
      token: "correct-token",
      allowedOrigins: [origin],
      transport: new FakeTransport(),
    });
    const address = await gateway.start();

    await expect(connect(address, "wrong-token", origin)).rejects.toThrow(
      /Unexpected server response: 401/,
    );
    await gateway.stop();
  });

  it("creates an HttpOnly browser session and accepts its cookie on websocket upgrade", async () => {
    const token = "test-token";
    const origin = "http://127.0.0.1:4310";
    const gateway = createGateway({
      port: 0,
      token,
      allowedOrigins: [origin],
      transport: new FakeTransport(),
    });
    const address = await gateway.start();

    const response = await fetch(`http://127.0.0.1:${address.port}/auth/session`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(response.status).toBe(204);
    const setCookie = response.headers.get("set-cookie");
    expect(setCookie).toMatch(/codex_local_session=[^;]+/);
    expect(setCookie).toContain("HttpOnly");
    expect(setCookie).toContain("SameSite=Strict");
    expect(setCookie).toContain("Max-Age=2592000");

    const cookie = setCookie?.split(";", 1)[0];
    const socket = await connect(address, undefined, origin, cookie);
    await expect(nextJson(socket)).resolves.toMatchObject({ type: "session", state: "ready" });
    socket.close();
    await once(socket, "close");
    await gateway.stop();
  });

  it("accepts authenticated images, stores them privately, and resolves opaque ids before RPC", async () => {
    const token = "test-token";
    const origin = "http://127.0.0.1:4310";
    const uploadDir = await mkdtemp(join(tmpdir(), "codex-remote-images-"));
    const transport = new FakeTransport();
    const gateway = createGateway({
      port: 0,
      token,
      allowedOrigins: [origin],
      uploadDir,
      transport,
    });
    const address = await gateway.start();
    try {
      const login = await fetch(`http://127.0.0.1:${address.port}/auth/session`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const cookie = login.headers.get("set-cookie")?.split(";", 1)[0];
      const png = Buffer.from("89504e470d0a1a0a0000000d49484452", "hex");
      const upload = await fetch(`http://127.0.0.1:${address.port}/api/images`, {
        method: "POST",
        headers: {
          origin,
          cookie: cookie as string,
          "content-type": "image/png",
          "x-file-name": "../../private.png",
        },
        body: png,
      });
      expect(upload.status).toBe(201);
      const uploaded = await upload.json() as { id: string; name: string; mimeType: string };
      expect(uploaded).toMatchObject({
        id: expect.stringMatching(/^[0-9a-f-]+$/),
        name: "private.png",
        mimeType: "image/png",
      });

      const socket = await connect(address, undefined, origin, cookie);
      await nextJson(socket);
      socket.send(JSON.stringify({
        type: "rpc",
        payload: {
          id: 91,
          method: "turn/start",
          params: {
            threadId: "thread-1",
            input: [
              { type: "text", text: "Inspect this" },
              { type: "remoteImage", id: uploaded.id },
            ],
          },
        },
      }));
      const forwarded = await waitForSentMethod(transport, "turn/start");
      const imageInput = (forwarded as { params: { input: Array<Record<string, unknown>> } })
        .params.input[1];
      expect(imageInput).toMatchObject({ type: "localImage" });
      expect(imageInput?.path).toBe(join(uploadDir, `${uploaded.id}.png`));
      expect(await readFile(imageInput?.path as string)).toEqual(png);
      expect((await stat(imageInput?.path as string)).mode & 0o777).toBe(0o600);

      const rendered = await fetch(
        `http://127.0.0.1:${address.port}/api/images/${uploaded.id}`,
        { headers: { cookie: cookie as string } },
      );
      expect(rendered.status).toBe(200);
      expect(rendered.headers.get("content-type")).toBe("image/png");
      expect(Buffer.from(await rendered.arrayBuffer())).toEqual(png);

      const unauthenticatedRender = await fetch(
        `http://127.0.0.1:${address.port}/api/images/${uploaded.id}`,
      );
      expect(unauthenticatedRender.status).toBe(401);
      socket.close();
      await once(socket, "close");
    } finally {
      await gateway.stop();
      await rm(uploadDir, { recursive: true, force: true });
    }
  });

  it("rejects unauthenticated, oversized, and content-spoofed image uploads", async () => {
    const token = "test-token";
    const origin = "http://127.0.0.1:4310";
    const uploadDir = await mkdtemp(join(tmpdir(), "codex-remote-images-"));
    const gateway = createGateway({
      port: 0,
      token,
      allowedOrigins: [origin],
      uploadDir,
      transport: new FakeTransport(),
    });
    const address = await gateway.start();
    try {
      const unauthorized = await fetch(`http://127.0.0.1:${address.port}/api/images`, {
        method: "POST",
        headers: { origin, "content-type": "image/png" },
        body: Buffer.from("89504e470d0a1a0a", "hex"),
      });
      expect(unauthorized.status).toBe(401);

      const login = await fetch(`http://127.0.0.1:${address.port}/auth/session`, {
        method: "POST",
        headers: { origin, "content-type": "application/json" },
        body: JSON.stringify({ token }),
      });
      const cookie = login.headers.get("set-cookie")?.split(";", 1)[0] as string;
      const spoofed = await fetch(`http://127.0.0.1:${address.port}/api/images`, {
        method: "POST",
        headers: { origin, cookie, "content-type": "image/png" },
        body: Buffer.from("not a png"),
      });
      expect(spoofed.status).toBe(415);

      const oversized = await fetch(`http://127.0.0.1:${address.port}/api/images`, {
        method: "POST",
        headers: {
          origin,
          cookie,
          "content-type": "image/png",
        },
        body: Buffer.alloc(10 * 1024 * 1024 + 1),
      });
      expect(oversized.status).toBe(413);
    } finally {
      await gateway.stop();
      await rm(uploadDir, { recursive: true, force: true });
    }
  });

  it("does not create a browser session for a wrong token or foreign origin", async () => {
    const token = "test-token";
    const origin = "http://127.0.0.1:4310";
    const gateway = createGateway({
      port: 0,
      token,
      allowedOrigins: [origin],
      transport: new FakeTransport(),
    });
    const address = await gateway.start();

    const wrongToken = await fetch(`http://127.0.0.1:${address.port}/auth/session`, {
      method: "POST",
      headers: { origin, "content-type": "application/json" },
      body: JSON.stringify({ token: "wrong" }),
    });
    expect(wrongToken.status).toBe(401);
    expect(wrongToken.headers.get("set-cookie")).toBeNull();

    const wrongOrigin = await fetch(`http://127.0.0.1:${address.port}/auth/session`, {
      method: "POST",
      headers: { origin: "http://evil.test", "content-type": "application/json" },
      body: JSON.stringify({ token }),
    });
    expect(wrongOrigin.status).toBe(403);
    expect(wrongOrigin.headers.get("set-cookie")).toBeNull();
    await gateway.stop();
  });

  it("allows multiple authenticated controlling websockets", async () => {
    const token = "test-token";
    const origin = "http://127.0.0.1:4310";
    const gateway = createGateway({
      port: 0,
      token,
      allowedOrigins: [origin],
      transport: new FakeTransport(),
    });
    const address = await gateway.start();
    const first = await connect(address, token, origin);
    const second = await connect(address, token, origin);

    await expect(nextJson(first)).resolves.toMatchObject({ type: "session", state: "ready" });
    await expect(nextJson(second)).resolves.toMatchObject({ type: "session", state: "ready" });
    first.close();
    await once(first, "close");
    second.close();
    await once(second, "close");
    await gateway.stop();
  });

  it("routes overlapping request ids to their originating websocket", async () => {
    const token = "test-token";
    const origin = "http://127.0.0.1:4310";
    const transport = new FakeTransport();
    const gateway = createGateway({ port: 0, token, allowedOrigins: [origin], transport });
    const address = await gateway.start();
    const first = await connect(address, token, origin);
    const second = await connect(address, token, origin);
    await nextJson(first);
    await nextJson(second);

    first.send(JSON.stringify({
      type: "rpc",
      payload: { id: 7, method: "thread/list", params: { client: "first" } },
    }));
    second.send(JSON.stringify({
      type: "rpc",
      payload: { id: 7, method: "thread/list", params: { client: "second" } },
    }));
    const forwarded = await waitForSentRequests(transport, "thread/list", 2);
    const firstRequest = forwarded.find(
      (message) => "params" in message && (message.params as { client?: string }).client === "first",
    );
    const secondRequest = forwarded.find(
      (message) => "params" in message && (message.params as { client?: string }).client === "second",
    );
    if (!firstRequest || !secondRequest || !("id" in firstRequest) || !("id" in secondRequest)) {
      throw new Error("Expected both forwarded requests");
    }
    expect(firstRequest.id).not.toBe(secondRequest.id);

    transport.emit({ id: secondRequest.id, result: { owner: "second" } });
    transport.emit({ id: firstRequest.id, result: { owner: "first" } });
    await expect(nextJson(first)).resolves.toEqual({
      type: "rpc",
      payload: { id: 7, result: { owner: "first" } },
    });
    await expect(nextJson(second)).resolves.toEqual({
      type: "rpc",
      payload: { id: 7, result: { owner: "second" } },
    });

    first.close();
    await once(first, "close");
    second.close();
    await once(second, "close");
    await gateway.stop();
  });

  it("broadcasts live notifications to every websocket", async () => {
    const token = "test-token";
    const origin = "http://127.0.0.1:4310";
    const transport = new FakeTransport();
    const gateway = createGateway({ port: 0, token, allowedOrigins: [origin], transport });
    const address = await gateway.start();
    const first = await connect(address, token, origin);
    const second = await connect(address, token, origin);
    await nextJson(first);
    await nextJson(second);

    transport.emit({
      method: "item/agentMessage/delta",
      params: { threadId: "t1", turnId: "turn-1", itemId: "item-1", delta: "Live" },
    });

    const expected = {
      type: "rpc",
      payload: expect.objectContaining({ method: "item/agentMessage/delta" }),
    };
    await expect(nextJson(first)).resolves.toEqual(expected);
    await expect(nextJson(second)).resolves.toEqual(expected);

    first.close();
    await once(first, "close");
    second.close();
    await once(second, "close");
    await gateway.stop();
  });

  it("accepts only the first response to a broadcast approval request", async () => {
    const token = "test-token";
    const origin = "http://127.0.0.1:4310";
    const transport = new FakeTransport();
    const gateway = createGateway({ port: 0, token, allowedOrigins: [origin], transport });
    const address = await gateway.start();
    const first = await connect(address, token, origin);
    const second = await connect(address, token, origin);
    await nextJson(first);
    await nextJson(second);

    transport.emit({
      id: 91,
      method: "item/commandExecution/requestApproval",
      params: { command: "pnpm test" },
    });
    const firstApproval = await nextJson(first);
    const secondApproval = await nextJson(second);
    expect(firstApproval.payload.id).toBe(secondApproval.payload.id);

    first.send(JSON.stringify({
      type: "rpc",
      payload: { id: firstApproval.payload.id, result: { decision: "accept" } },
    }));
    await waitForSentResponse(transport, 91);
    second.send(JSON.stringify({
      type: "rpc",
      payload: { id: secondApproval.payload.id, result: { decision: "decline" } },
    }));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(transport.sent.filter((message) => "id" in message && message.id === 91)).toEqual([
      { id: 91, result: { decision: "accept" } },
    ]);
    expect(second.readyState).toBe(WebSocket.OPEN);

    first.close();
    await once(first, "close");
    second.close();
    await once(second, "close");
    await gateway.stop();
  });

  it("forwards rpc messages in both directions", async () => {
    const token = "test-token";
    const origin = "http://127.0.0.1:4310";
    const transport = new FakeTransport();
    const gateway = createGateway({
      port: 0,
      token,
      allowedOrigins: [origin],
      defaultCwd: "/service/default",
      transport,
    });
    const address = await gateway.start();
    const socket = await connect(address, token, origin);
    await expect(nextJson(socket)).resolves.toMatchObject({
      type: "session",
      state: "ready",
      defaultCwd: "/service/default",
    });

    socket.send(
      JSON.stringify({
        type: "rpc",
        payload: { id: 7, method: "thread/list", params: { limit: 20 } },
      }),
    );
    const forwarded = await waitForSentMethod(transport, "thread/list");
    expect(forwarded).toMatchObject({ method: "thread/list" });

    if (!("id" in forwarded)) throw new Error("Expected forwarded request id");
    const response = nextJson(socket);
    transport.emit({ id: forwarded.id, result: { data: [] } });
    await expect(response).resolves.toEqual({
      type: "rpc",
      payload: { id: 7, result: { data: [] } },
    });

    socket.close();
    await once(socket, "close");
    await gateway.stop();
  });

  it("returns a request error without disconnecting when Desktop is read-only", async () => {
    const token = "test-token";
    const origin = "http://127.0.0.1:4310";
    const gateway = createGateway({
      port: 0,
      token,
      allowedOrigins: [origin],
      transport: new ReadOnlyTransport(),
    });
    const address = await gateway.start();
    const socket = await connect(address, token, origin);
    await nextJson(socket);

    socket.send(JSON.stringify({
      type: "rpc",
      payload: { id: 12, method: "thread/list", params: { limit: 20 } },
    }));

    await expect(nextJson(socket)).resolves.toEqual({
      type: "rpc",
      payload: {
        id: 12,
        error: { code: -32001, message: "Desktop bridge is read-only" },
      },
    });
    expect(socket.readyState).toBe(WebSocket.OPEN);

    socket.close();
    await once(socket, "close");
    await gateway.stop();
  });

  it("serves Desktop state requests locally without forwarding them", async () => {
    const token = "test-token";
    const origin = "http://127.0.0.1:4310";
    const transport = new FakeTransport();
    const desktopState = {
      request: (method: string) => ({ method, data: [{ id: "desktop-thread", isPinned: true }] }),
      close: () => undefined,
    };
    const gateway = createGateway({
      port: 0,
      token,
      allowedOrigins: [origin],
      transport,
      desktopState,
    });
    const address = await gateway.start();
    const socket = await connect(address, token, origin);
    await nextJson(socket);

    socket.send(JSON.stringify({
      type: "rpc",
      payload: { id: 9, method: "desktopState/listThreadMetadata", params: { threadIds: ["desktop-thread"] } },
    }));

    await expect(nextJson(socket)).resolves.toMatchObject({
      type: "rpc",
      payload: { id: 9, result: { data: [{ id: "desktop-thread", isPinned: true }] } },
    });
    expect(transport.sent.some((message) => "method" in message && message.method.startsWith("desktopState/"))).toBe(false);

    socket.close();
    await once(socket, "close");
    await gateway.stop();
  });
});
