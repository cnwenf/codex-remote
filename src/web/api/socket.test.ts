import { afterEach, describe, expect, it, vi } from "vitest";
import { CodexSocket, createBrowserSession, type BrowserSocket, uploadImage } from "./socket";

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

  fail() {
    this.onerror?.();
  }
}

afterEach(() => {
  vi.useRealTimers();
});

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

  it("releases a failed initial socket so login can retry immediately", async () => {
    const sockets: FakeBrowserSocket[] = [];
    const socket = new CodexSocket(() => {
      const next = new FakeBrowserSocket(sockets.length > 0);
      sockets.push(next);
      return next;
    });

    const initial = socket.connect("", "ws://127.0.0.1/rpc");
    sockets[0].fail();
    await expect(initial).rejects.toThrow("codex-socket-connect-failed");

    await expect(socket.connect("secret", "ws://127.0.0.1/rpc")).resolves.toBeUndefined();
    expect(sockets).toHaveLength(2);
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

  it("uses a configured native image uploader instead of WebView fetch", async () => {
    const image = new File(["image"], "screen.png", { type: "image/png" });
    const uploaded = { id: "upload-1", name: "screen.png", mimeType: "image/png", size: 5 };
    const imageUploader = vi.fn(async () => uploaded);
    const webFetch = vi.fn(() => Promise.reject(new Error("webview-fetch-blocked")));

    await expect(uploadImage(image, webFetch as typeof fetch, {
      baseUrl: "https://remote.example.test",
      token: "test-token",
      imageUploader,
    })).resolves.toEqual(uploaded);

    expect(imageUploader).toHaveBeenCalledWith(image);
    expect(webFetch).not.toHaveBeenCalled();
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

  it("reconnects with the saved cookie after an established connection closes", async () => {
    vi.useFakeTimers();
    const sockets: FakeBrowserSocket[] = [];
    const protocols: string[][] = [];
    const socket = new CodexSocket((_url, value) => {
      protocols.push(value);
      const next = new FakeBrowserSocket();
      sockets.push(next);
      return next;
    }, { reconnectDelaysMs: [100, 200], random: () => 0.5 });
    const sessions: string[] = [];
    socket.subscribeSession((session) => {
      if (session.type === "session") sessions.push(session.state);
    });

    await socket.connect("initial-secret", "ws://127.0.0.1/rpc");
    sockets[0].close();

    expect(sessions.at(-1)).toBe("reconnecting");
    await vi.advanceTimersByTimeAsync(100);
    await Promise.resolve();

    expect(sockets).toHaveLength(2);
    expect(protocols).toEqual([
      ["codex-local", expect.stringMatching(/^token\./)],
      ["codex-local"],
    ]);
    expect(sessions.at(-1)).toBe("ready");
  });

  it("reuses the in-memory token protocol for native reconnects", async () => {
    vi.useFakeTimers();
    const sockets: FakeBrowserSocket[] = [];
    const protocols: string[][] = [];
    const socket = new CodexSocket((_url, value) => {
      protocols.push(value);
      const next = new FakeBrowserSocket();
      sockets.push(next);
      return next;
    }, { reconnectDelaysMs: [10], random: () => 0.5 });

    await socket.connect("native-secret", "ws://remote/rpc", true);
    sockets[0].close();
    await vi.advanceTimersByTimeAsync(10);

    expect(protocols).toHaveLength(2);
    expect(protocols[1]).toEqual(protocols[0]);
    expect(protocols[1]).toEqual(["codex-local", expect.stringMatching(/^token\./)]);
  });

  it("backs off after a failed reconnect and retries immediately when the network returns", async () => {
    vi.useFakeTimers();
    const sockets: FakeBrowserSocket[] = [];
    const onlineListeners = new Set<() => void>();
    const socket = new CodexSocket(() => {
      const next = new FakeBrowserSocket(sockets.length !== 1);
      sockets.push(next);
      return next;
    }, {
      reconnectDelaysMs: [100, 1_000],
      random: () => 0.5,
      addWindowListener: (name, listener) => {
        if (name === "online") onlineListeners.add(listener);
      },
      removeWindowListener: (_name, listener) => onlineListeners.delete(listener),
    });

    await socket.connect("", "ws://127.0.0.1/rpc");
    sockets[0].close();
    await vi.advanceTimersByTimeAsync(100);
    expect(sockets).toHaveLength(2);
    sockets[1].close();

    for (const listener of onlineListeners) listener();
    await Promise.resolve();

    expect(sockets).toHaveLength(3);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(3);
  });

  it("does not reconnect after a deliberate disconnect", async () => {
    vi.useFakeTimers();
    const sockets: FakeBrowserSocket[] = [];
    const socket = new CodexSocket(() => {
      const next = new FakeBrowserSocket();
      sockets.push(next);
      return next;
    }, { reconnectDelaysMs: [10] });

    await socket.connect("", "ws://127.0.0.1/rpc");
    socket.disconnect();
    await vi.advanceTimersByTimeAsync(1_000);

    expect(sockets).toHaveLength(1);
  });

  it("rejects but never replays an in-flight mutation after reconnecting", async () => {
    vi.useFakeTimers();
    const sockets: FakeBrowserSocket[] = [];
    const socket = new CodexSocket(() => {
      const next = new FakeBrowserSocket();
      sockets.push(next);
      return next;
    }, { reconnectDelaysMs: [10], random: () => 0.5 });
    await socket.connect("", "ws://127.0.0.1/rpc");

    const mutation = socket.request("turn/steer", { threadId: "t1", input: "once" });
    sockets[0].close();
    await expect(mutation).rejects.toThrow("codex-socket-disconnected");
    await vi.advanceTimersByTimeAsync(10);

    expect(sockets[1].sent).toEqual([]);
  });
});
