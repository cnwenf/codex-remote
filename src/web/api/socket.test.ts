import { describe, expect, it } from "vitest";
import { CodexSocket, createBrowserSession, type BrowserSocket } from "./socket";

class FakeBrowserSocket implements BrowserSocket {
  readonly OPEN = 1;
  readyState = this.OPEN;
  sent: string[] = [];
  onopen: (() => void) | null = null;
  onmessage: ((event: { data: string }) => void) | null = null;
  onclose: (() => void) | null = null;
  onerror: (() => void) | null = null;

  constructor(autoReady = true) {
    if (autoReady) {
      queueMicrotask(() => this.serverSend({ type: "session", state: "ready" }));
    }
  }

  send(data: string) {
    this.sent.push(data);
  }

  close() {
    this.readyState = 3;
    this.onclose?.();
  }

  serverSend(payload: unknown) {
    this.onmessage?.({ data: JSON.stringify(payload) });
  }
}

describe("CodexSocket", () => {
  it("does not finish connecting until the gateway session is ready", async () => {
    const fake = new FakeBrowserSocket(false);
    const socket = new CodexSocket(() => fake);
    let connected = false;

    const connection = socket.connect("secret", "ws://127.0.0.1/rpc")
      .then(() => { connected = true; });
    await Promise.resolve();
    expect(connected).toBe(false);

    fake.serverSend({
      type: "session",
      state: "ready",
      transport: "desktop-live",
      readOnly: false,
    });
    await connection;
    expect(connected).toBe(true);
  });

  it("opens a websocket without a token protocol when using a saved cookie session", async () => {
    const fake = new FakeBrowserSocket();
    let protocols: string[] | undefined;
    const socket = new CodexSocket((_url, value) => {
      protocols = value;
      return fake;
    });

    await socket.connect("");

    expect(protocols).toEqual(["codex-local"]);
  });

  it("creates a cookie session without exposing the token in the URL", async () => {
    let request: { input: string; init?: RequestInit } | undefined;
    await createBrowserSession("phone secret", async (input, init) => {
      request = { input: String(input), init };
      return new Response(null, { status: 204 });
    });

    expect(request?.input).toBe("/auth/session");
    expect(request?.init).toMatchObject({
      method: "POST",
      credentials: "same-origin",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ token: "phone secret" }),
    });
  });

  it("rejects a browser session when the token is invalid", async () => {
    await expect(createBrowserSession("wrong", async () =>
      new Response(null, { status: 401 })
    )).rejects.toThrow("codex-session-login-failed");
  });

  it("resolves a request when its response arrives", async () => {
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    await socket.connect("secret", "ws://127.0.0.1/rpc");

    const result = socket.request("thread/list", { limit: 20 });
    fake.serverSend({
      type: "rpc",
      payload: { id: 1, result: { data: [{ id: "t1" }] } },
    });

    await expect(result).resolves.toEqual({ data: [{ id: "t1" }] });
  });

  it("rejects pending requests when the connection closes", async () => {
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    await socket.connect("secret", "ws://127.0.0.1/rpc");

    const result = socket.request("thread/read", { threadId: "t1" });
    fake.close();

    await expect(result).rejects.toThrow("codex-socket-disconnected");
  });

  it("delivers server requests to subscribers", async () => {
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    const received: unknown[] = [];
    socket.subscribe((message) => received.push(message));
    await socket.connect("secret", "ws://127.0.0.1/rpc");

    fake.serverSend({
      type: "rpc",
      payload: { id: "server-1", method: "item/commandExecution/requestApproval" },
    });

    expect(received).toEqual([
      { id: "server-1", method: "item/commandExecution/requestApproval" },
    ]);
  });
});
