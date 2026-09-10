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
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("CodexSocket", () => {
  it("uploads an image on the authenticated chat connection without an HTTP request", async () => {
    const fake = new FakeBrowserSocket(false);
    const socket = new CodexSocket(() => fake);
    const connecting = socket.connect("secret", "ws://127.0.0.1/rpc");
    fake.serverSend({ type: "session", state: "ready", imageUpload: true });
    await connecting;
    const http = vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("HTTP path unavailable"));
    const image = pngFile("phone.png", 400, 300);
    const result = socket.uploadImage(image);
    await vi.waitFor(() => expect(fake.sent).toHaveLength(1));
    const request = JSON.parse(fake.sent[0]).payload;
    expect(request).toMatchObject({ method: "gateway/image/upload", params: {
      name: "phone.png", mimeType: "image/png", data: expect.any(String),
    } });
    expect(Buffer.from(request.params.data, "base64").length).toBe(image.size);
    fake.serverSend({ type: "rpc", payload: { id: request.id, result: {
      id: "image-1", name: "phone.png", mimeType: "image/png", size: image.size,
    } } });
    await expect(result).resolves.toMatchObject({ id: "image-1", size: image.size });
    expect(http).not.toHaveBeenCalled();
    socket.disconnect();
  });

  it("does not send a file to a different connection after reading it", async () => {
    const first = new FakeBrowserSocket(false);
    const second = new FakeBrowserSocket(false);
    let connection = first;
    const socket = new CodexSocket(() => connection);
    const ready = socket.connect("first", "ws://first.test/rpc");
    first.serverSend({ type: "session", state: "ready", imageUpload: true });
    await ready;
    const upload = socket.uploadImage(pngFile("private.png", 1, 1));
    const rejected = expect(upload).rejects.toThrow("连接已切换或断开");
    socket.disconnect();
    connection = second;
    const connected = socket.connect("second", "ws://second.test/rpc");
    second.serverSend({ type: "session", state: "ready", imageUpload: true });
    await connected;
    await rejected;
    expect(first.sent).toEqual([]);
    expect(second.sent).toEqual([]);
    socket.disconnect();
  });

  it("asks for a Mac upgrade immediately when its gateway lacks chat image upload", async () => {
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    await socket.connect("secret", "ws://127.0.0.1/rpc");
    await expect(socket.uploadImage(pngFile("phone.png", 1, 1))).rejects.toThrow("更新 Mac");
    expect(fake.sent).toHaveLength(0);
    socket.disconnect();
  });

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
    const image = pngFile("screen.png", 400, 300);
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

  it("compresses a large image before invoking the native uploader", async () => {
    const original = pngFile("large.png", 2_400, 1_200, 1_000_001);
    const imageUploader = vi.fn(async (transmitted: File) => ({
      id: "upload-1", name: transmitted.name, mimeType: transmitted.type, size: transmitted.size,
    }));
    const webFetch = vi.fn(() => Promise.reject(new Error("webview-fetch-blocked")));
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:large"), revokeObjectURL: vi.fn() });
    vi.stubGlobal("Image", class {
      naturalWidth = 2_400;
      naturalHeight = 1_200;
      decode = vi.fn().mockResolvedValue(undefined);
    });
    vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
      set fillStyle(_value: string | CanvasGradient | CanvasPattern) {}, fillRect: vi.fn(), drawImage: vi.fn(),
    } as unknown as CanvasRenderingContext2D);
    vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
      callback(new Blob([new Uint8Array(750_000)], { type: "image/jpeg" }));
    });

    await uploadImage(original, webFetch as typeof fetch, { imageUploader });

    expect(imageUploader).toHaveBeenCalledOnce();
    const transmitted = imageUploader.mock.calls[0][0];
    expect(transmitted.size).toBeLessThanOrEqual(1_000_000);
    expect(transmitted.type).toBe("image/jpeg");
    expect(webFetch).not.toHaveBeenCalled();
  });

  it("rejects an original above 50 MiB before invoking any uploader", async () => {
    const original = new File([new Uint8Array(50 * 1024 * 1024 + 1)], "too-large.png", { type: "image/png" });
    const imageUploader = vi.fn();
    const webFetch = vi.fn();

    await expect(uploadImage(original, webFetch as typeof fetch, { imageUploader }))
      .rejects.toThrow("50 MiB");

    expect(imageUploader).not.toHaveBeenCalled();
    expect(webFetch).not.toHaveBeenCalled();
  });

  it("times out a stalled header read without invoking a codec or uploader, and ignores late load", async () => {
    vi.useFakeTimers();
    const header = pngHeader(2_400, 1_200).buffer;
    let lateLoad!: () => void;
    vi.stubGlobal("FileReader", class {
      result: string | ArrayBuffer | null = header;
      onload: (() => void) | null = null;
      onerror: (() => void) | null = null;
      onabort: (() => void) | null = null;
      abort = vi.fn(() => this.onabort?.());
      readAsArrayBuffer() { lateLoad = this.onload!; }
    });
    const createObjectURL = vi.fn();
    const image = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL: vi.fn() });
    vi.stubGlobal("Image", image);
    const imageUploader = vi.fn();
    const webFetch = vi.fn();
    let state = "pending";
    const result = uploadImage(
      pngFile("stalled.png", 2_400, 1_200, 1_000_001),
      webFetch as typeof fetch,
      { imageUploader },
    );
    void result.then(
      () => { state = "resolved"; },
      () => { state = "rejected"; },
    );

    await vi.advanceTimersByTimeAsync(5_000);
    expect(state).toBe("rejected");
    await expect(result).rejects.toThrow("无法读取图片尺寸");
    lateLoad();
    await Promise.resolve();

    expect(createObjectURL).not.toHaveBeenCalled();
    expect(image).not.toHaveBeenCalled();
    expect(imageUploader).not.toHaveBeenCalled();
    expect(webFetch).not.toHaveBeenCalled();
  });

  it("rejects bytes that do not match the claimed PNG type before fetch", async () => {
    const image = new File(["not a png"], "screen.png", { type: "image/png" });
    const webFetch = vi.fn(async () => new Response(null, { status: 415 }));

    await expect(uploadImage(image, webFetch as typeof fetch))
      .rejects.toThrow("无法读取图片尺寸");
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

  it("removes an aborted request and ignores its late response", async () => {
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    await socket.connect("secret", "ws://127.0.0.1/rpc");
    const controller = new AbortController();

    const abandoned = socket.request("desktopState/readQuestionContext", { turnId: "old" }, {
      signal: controller.signal,
    });
    controller.abort();
    await expect(abandoned).rejects.toThrow("codex-socket-request-aborted");

    const current = socket.request("desktopState/readQuestionContext", { turnId: "current" });
    fake.serverSend({ type: "rpc", payload: { id: 1, result: { stale: true } } });
    fake.serverSend({ type: "rpc", payload: { id: 2, result: { stale: false } } });
    await expect(current).resolves.toEqual({ stale: false });
  });

  it("rejects immediately without sending when the request signal is already aborted", async () => {
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    await socket.connect("secret", "ws://127.0.0.1/rpc");
    const controller = new AbortController();
    controller.abort();

    await expect(socket.request("thread/list", {}, { signal: controller.signal }))
      .rejects.toThrow("codex-socket-request-aborted");
    expect(fake.sent).toHaveLength(0);
  });

  it("expires one unresolved request without affecting later responses", async () => {
    vi.useFakeTimers();
    const fake = new FakeBrowserSocket();
    const socket = new CodexSocket(() => fake);
    await socket.connect("secret", "ws://127.0.0.1/rpc");

    const stalled = socket.request("desktopState/readQuestionContext", { turnId: "old" }, { timeoutMs: 25 });
    const timeout = expect(stalled).rejects.toThrow("codex-socket-request-timeout");
    await vi.advanceTimersByTimeAsync(25);
    await timeout;

    const current = socket.request("desktopState/readQuestionContext", { turnId: "current" });
    fake.serverSend({ type: "rpc", payload: { id: 1, result: { stale: true } } });
    fake.serverSend({ type: "rpc", payload: { id: 2, result: { stale: false } } });
    await expect(current).resolves.toEqual({ stale: false });
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

  it("retries only once when a hidden page becomes visible during reconnect backoff", async () => {
    vi.useFakeTimers();
    const sockets: FakeBrowserSocket[] = [];
    const visibilityListeners = new Set<() => void>();
    let visible = false;
    const socket = new CodexSocket(() => {
      const next = new FakeBrowserSocket();
      sockets.push(next);
      return next;
    }, {
      reconnectDelaysMs: [1_000],
      random: () => 0.5,
      addWindowListener: (name, listener) => {
        if (name === "visibilitychange") visibilityListeners.add(listener);
      },
      removeWindowListener: (_name, listener) => visibilityListeners.delete(listener),
      isDocumentVisible: () => visible,
    });

    await socket.connect("", "ws://127.0.0.1/rpc");
    sockets[0].close();
    for (const listener of visibilityListeners) listener();
    await Promise.resolve();
    expect(sockets).toHaveLength(1);

    visible = true;
    for (const listener of visibilityListeners) listener();
    for (const listener of visibilityListeners) listener();
    await Promise.resolve();

    expect(sockets).toHaveLength(2);
    await vi.advanceTimersByTimeAsync(1_000);
    expect(sockets).toHaveLength(2);
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

function pngFile(name: string, width: number, height: number, size = 24) {
  const header = pngHeader(width, height);
  return new File([header, new Uint8Array(Math.max(0, size - header.length))], name, { type: "image/png" });
}

function pngHeader(width: number, height: number) {
  const header = new Uint8Array(24);
  header.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const view = new DataView(header.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return header;
}
