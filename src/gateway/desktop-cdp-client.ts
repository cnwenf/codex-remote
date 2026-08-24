import WebSocket from "ws";

const BINDING_NAME = "__codexLocalDesktopEvent";
const DEFAULT_TIMEOUT_MS = 5_000;
const FORWARDED_MESSAGE_TYPES = [
  "mcp-request",
  "mcp-response",
  "codex-app-server-initialized",
  "codex-app-server-connection-changed",
  "fetch-response",
  "pinned-threads-updated",
];
const NOTIFICATION_MESSAGE_TYPE = "mcp-notification";

type DesktopCdpClientOptions = {
  endpoint: string;
  timeoutMs?: number;
};

type CdpTarget = {
  id?: unknown;
  type?: unknown;
  title?: unknown;
  url?: unknown;
  webSocketDebuggerUrl?: unknown;
};

type CdpResponse = {
  id: number;
  result?: Record<string, unknown>;
  error?: { code?: number; message?: string };
};

type CdpEvent = {
  method: string;
  params?: Record<string, unknown>;
};

type PendingCall = {
  resolve: (result: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timeout: ReturnType<typeof setTimeout>;
};

export class DesktopCdpClient {
  private socket?: WebSocket;
  private nextId = 1;
  private pending = new Map<number, PendingCall>();
  private onDesktopMessage?: (message: unknown) => void;
  private onDisconnect?: () => void;
  private windowObjectId?: string;
  private stopping = false;
  private disconnectNotified = false;

  constructor(private readonly options: DesktopCdpClientOptions) {}

  async start(
    onDesktopMessage: (message: unknown) => void,
    onDisconnect: () => void,
  ): Promise<void> {
    if (this.socket) throw new Error("desktop-cdp-already-started");
    const endpoint = parseLoopbackUrl(this.options.endpoint, "desktop-cdp-endpoint");
    this.onDesktopMessage = onDesktopMessage;
    this.onDisconnect = onDisconnect;
    this.stopping = false;
    this.disconnectNotified = false;

    const target = await this.discoverTarget(endpoint);
    const websocketUrl = parseLoopbackUrl(
      String(target.webSocketDebuggerUrl),
      "desktop-cdp-websocket",
      ["ws:", "wss:"],
    );
    const socket = new WebSocket(websocketUrl, { maxPayload: 8 * 1024 * 1024 });
    this.socket = socket;
    socket.on("message", (raw) => this.handleFrame(raw.toString()));
    socket.on("close", () => this.handleDisconnect(socket));
    socket.on("error", () => this.handleDisconnect(socket));

    try {
      await waitForOpen(socket, this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      await this.call("Runtime.enable");
      await this.call("Runtime.addBinding", { name: BINDING_NAME });
      const installed = await this.call("Runtime.evaluate", {
        expression: listenerExpression(),
        returnByValue: false,
        awaitPromise: false,
      });
      const runtimeResult = installed.result;
      if (!runtimeResult || typeof runtimeResult !== "object") {
        throw new Error("desktop-cdp-window-object-missing");
      }
      const objectId = (runtimeResult as Record<string, unknown>).objectId;
      if (typeof objectId !== "string") {
        throw new Error("desktop-cdp-window-object-missing");
      }
      this.windowObjectId = objectId;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async sendDesktopMessage(message: unknown): Promise<void> {
    if (!this.windowObjectId) throw new Error("desktop-cdp-not-ready");
    await this.call("Runtime.callFunctionOn", {
      objectId: this.windowObjectId,
      functionDeclaration: "function(message) { return this.electronBridge.sendMessageFromView(message); }",
      arguments: [{ value: message }],
      awaitPromise: true,
      returnByValue: true,
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.windowObjectId = undefined;
    const socket = this.socket;
    this.socket = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("desktop-cdp-stopped"));
    }
    this.pending.clear();
    if (!socket || socket.readyState === WebSocket.CLOSED) return;
    await new Promise<void>((resolve) => {
      socket.once("close", () => resolve());
      socket.close();
      const timeout = setTimeout(() => {
        socket.terminate();
        resolve();
      }, 500);
      socket.once("close", () => clearTimeout(timeout));
    });
  }

  private async discoverTarget(endpoint: URL): Promise<CdpTarget> {
    const discoveryUrl = new URL("/json/list", endpoint);
    const controller = new AbortController();
    const timeout = setTimeout(
      () => controller.abort(),
      this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
    );
    try {
      const response = await fetch(discoveryUrl, { signal: controller.signal });
      if (!response.ok) throw new Error("desktop-cdp-discovery-failed");
      const body = await response.json() as unknown;
      if (!Array.isArray(body)) throw new Error("desktop-cdp-discovery-invalid");
      const target = body.find(isCodexRenderer);
      if (!target) throw new Error("desktop-cdp-renderer-not-found");
      return target;
    } finally {
      clearTimeout(timeout);
    }
  }

  private call(method: string, params?: Record<string, unknown>) {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("desktop-cdp-not-connected"));
    }
    const id = this.nextId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("desktop-cdp-call-timeout"));
      }, this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timeout });
      socket.send(JSON.stringify({ id, method, ...(params ? { params } : {}) }));
    });
  }

  private handleFrame(raw: string) {
    let frame: CdpResponse | CdpEvent;
    try {
      frame = JSON.parse(raw) as CdpResponse | CdpEvent;
    } catch {
      return;
    }
    if ("id" in frame) {
      const pending = this.pending.get(frame.id);
      if (!pending) return;
      this.pending.delete(frame.id);
      clearTimeout(pending.timeout);
      if (frame.error) {
        pending.reject(new Error(`desktop-cdp-call-failed:${frame.error.code ?? "unknown"}`));
      } else {
        pending.resolve(frame.result ?? {});
      }
      return;
    }
    if (frame.method !== "Runtime.bindingCalled") return;
    if (frame.params?.name !== BINDING_NAME || typeof frame.params.payload !== "string") return;
    try {
      this.onDesktopMessage?.(JSON.parse(frame.params.payload));
    } catch {
      // Ignore malformed renderer payloads at this boundary.
    }
  }

  private handleDisconnect(socket: WebSocket) {
    if (this.socket !== socket) return;
    this.socket = undefined;
    this.windowObjectId = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("desktop-cdp-disconnected"));
    }
    this.pending.clear();
    if (this.stopping || this.disconnectNotified) return;
    this.disconnectNotified = true;
    this.onDisconnect?.();
  }
}

function isCodexRenderer(value: unknown): value is CdpTarget {
  if (!value || typeof value !== "object") return false;
  const target = value as CdpTarget;
  if (target.type !== "page" || typeof target.webSocketDebuggerUrl !== "string") {
    return false;
  }
  const url = typeof target.url === "string" ? target.url : "";
  const title = typeof target.title === "string" ? target.title : "";
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return false;
  }
  if (parsed.protocol === "file:") {
    return /\/ChatGPT\.app\/Contents\/Resources\/(?:app\.asar\/)?webview\/index\.html$/.test(
      decodeURIComponent(parsed.pathname),
    );
  }
  return parsed.protocol === "app:" && /\bcodex\b/i.test(title);
}

function parseLoopbackUrl(
  value: string,
  errorPrefix: string,
  protocols = ["http:", "https:"],
): URL {
  let parsed: URL;
  try {
    parsed = new URL(value);
  } catch {
    throw new Error(`${errorPrefix}-invalid`);
  }
  if (!protocols.includes(parsed.protocol)) throw new Error(`${errorPrefix}-invalid`);
  if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "[::1]") {
    throw new Error(`${errorPrefix}-not-loopback`);
  }
  return parsed;
}

function listenerExpression(): string {
  const types = JSON.stringify(FORWARDED_MESSAGE_TYPES);
  const notificationType = JSON.stringify(NOTIFICATION_MESSAGE_TYPE);
  return `(() => {
    if (!window.__codexLocalDesktopListenerInstalled) {
      window.__codexLocalDesktopListenerInstalled = true;
      const allowed = new Set(${types});
      window.addEventListener("message", (event) => {
        const data = event.data;
        if (data && typeof data === "object" && allowed.has(data.type)) {
          window.${BINDING_NAME}(JSON.stringify(data));
        }
      });
    }
    if (!window.__codexLocalDesktopNotificationListenerInstalled) {
      window.__codexLocalDesktopNotificationListenerInstalled = true;
      window.addEventListener("message", (event) => {
        const data = event.data;
        if (data && typeof data === "object" && data.type === ${notificationType}) {
          window.${BINDING_NAME}(JSON.stringify(data));
        }
      });
    }
    return window;
  })()`;
}

function waitForOpen(socket: WebSocket, timeoutMs: number) {
  if (socket.readyState === WebSocket.OPEN) return Promise.resolve();
  return new Promise<void>((resolve, reject) => {
    const timeout = setTimeout(() => {
      cleanup();
      reject(new Error("desktop-cdp-connect-timeout"));
    }, timeoutMs);
    const onOpen = () => {
      cleanup();
      resolve();
    };
    const onError = () => {
      cleanup();
      reject(new Error("desktop-cdp-connect-failed"));
    };
    const cleanup = () => {
      clearTimeout(timeout);
      socket.off("open", onOpen);
      socket.off("error", onError);
    };
    socket.once("open", onOpen);
    socket.once("error", onError);
  });
}
