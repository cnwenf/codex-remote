import type { GatewayEnvelope, RpcId, RpcMessage } from "../../protocol/types";

export interface BrowserSocket {
  readonly OPEN: number;
  readyState: number;
  onopen: (() => void) | null;
  onmessage: ((event: { data: string }) => void) | null;
  onclose: (() => void) | null;
  onerror: (() => void) | null;
  send(data: string): void;
  close(code?: number, reason?: string): void;
}

type SocketFactory = (url: string, protocols: string[]) => BrowserSocket;
type PendingRequest = {
  resolve: (value: unknown) => void;
  reject: (reason: Error) => void;
};

type RecoveryEvent = "online" | "visibilitychange";
type SocketOptions = {
  reconnectDelaysMs?: number[];
  random?: () => number;
  addWindowListener?: (name: RecoveryEvent, listener: () => void) => void;
  removeWindowListener?: (name: RecoveryEvent, listener: () => void) => void;
  isDocumentVisible?: () => boolean;
};

const DEFAULT_RECONNECT_DELAYS = [500, 1_000, 2_000, 5_000, 10_000];

export class CodexSocket {
  private socket: BrowserSocket | undefined;
  private nextId = 1;
  private readonly pending = new Map<RpcId, PendingRequest>();
  private readonly listeners = new Set<(message: RpcMessage) => void>();
  private readonly sessionListeners = new Set<(envelope: GatewayEnvelope) => void>();
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnectAttempt = 0;
  private socketUrl?: string;
  private reconnectProtocols: string[] = ["codex-local"];
  private reconnectEnabled = false;
  private deliberateDisconnect = false;
  private recoveryListenersBound = false;

  constructor(
    private readonly factory: SocketFactory = (url, protocols) =>
      new WebSocket(url, protocols) as unknown as BrowserSocket,
    private readonly options: SocketOptions = {},
  ) {}

  connect(token: string, url = defaultSocketUrl(), reuseTokenOnReconnect = false): Promise<void> {
    if (this.socket) throw new Error("codex-socket-already-connected");
    this.deliberateDisconnect = false;
    this.socketUrl = url;
    const protocols = token ? ["codex-local", `token.${encodeToken(token)}`] : ["codex-local"];
    this.reconnectProtocols = reuseTokenOnReconnect ? protocols : ["codex-local"];
    return this.open(url, protocols, false)
      .then(() => {
        this.reconnectEnabled = true;
        this.reconnectAttempt = 0;
        this.bindRecoveryListeners();
      });
  }

  private open(url: string, protocols: string[], reconnecting: boolean): Promise<void> {
    const socket = this.factory(
      url,
      protocols,
    );
    this.socket = socket;

    return new Promise<void>((resolve, reject) => {
      let opened = false;
      let sessionReady = false;
      let finished = false;
      const resolveWhenReady = () => {
        if (!opened || !sessionReady || finished) return;
        finished = true;
        resolve();
      };
      const rejectConnection = () => {
        if (finished) return;
        finished = true;
        reject(new Error("codex-socket-connect-failed"));
      };
      socket.onopen = () => {
        opened = true;
        resolveWhenReady();
      };
      socket.onmessage = (event) => {
        const envelope = this.receive(event.data);
        if (envelope?.type === "session" && envelope.state === "ready") {
          sessionReady = true;
          resolveWhenReady();
        }
      };
      socket.onerror = () => {
        rejectConnection();
      };
      socket.onclose = () => {
        rejectConnection();
        if (this.socket === socket) this.socket = undefined;
        this.rejectPending("codex-socket-disconnected");
        if (!this.deliberateDisconnect && this.reconnectEnabled) this.scheduleReconnect();
      };

      if (socket.readyState === socket.OPEN) {
        opened = true;
        resolveWhenReady();
      }
    }).then(() => {
      if (reconnecting) this.reconnectAttempt = 0;
    }).catch((cause: unknown) => {
      if (this.socket === socket) this.socket = undefined;
      if (socket.readyState !== 3) socket.close(1000, "connect-failed");
      throw cause;
    });
  }

  request(method: string, params?: unknown): Promise<unknown> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      try {
        this.sendRpc({ id, method, params });
      } catch (error) {
        this.pending.delete(id);
        reject(error);
      }
    });
  }

  notify(method: string, params?: unknown) {
    this.sendRpc({ method, params });
  }

  respond(id: RpcId, result?: unknown, error?: { code: number; message: string }) {
    this.sendRpc(error ? { id, error } : { id, result });
  }

  subscribe(listener: (message: RpcMessage) => void) {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  subscribeSession(listener: (envelope: GatewayEnvelope) => void) {
    this.sessionListeners.add(listener);
    return () => this.sessionListeners.delete(listener);
  }

  disconnect() {
    this.deliberateDisconnect = true;
    this.reconnectEnabled = false;
    this.cancelReconnect();
    this.unbindRecoveryListeners();
    const socket = this.socket;
    this.socket = undefined;
    socket?.close(1000, "client-disconnect");
    this.rejectPending("codex-socket-disconnected");
  }

  private sendRpc(payload: RpcMessage) {
    if (!this.socket || this.socket.readyState !== this.socket.OPEN) {
      throw new Error("codex-socket-not-connected");
    }
    this.socket.send(JSON.stringify({ type: "rpc", payload }));
  }

  private receive(raw: string) {
    let envelope: GatewayEnvelope;
    try {
      envelope = JSON.parse(raw) as GatewayEnvelope;
    } catch {
      return undefined;
    }
    for (const listener of this.sessionListeners) listener(envelope);
    if (envelope.type !== "rpc") return envelope;
    const message = envelope.payload;
    if ("id" in message && !("method" in message)) {
      const pending = this.pending.get(message.id);
      if (!pending) return envelope;
      this.pending.delete(message.id);
      if (message.error) pending.reject(new Error(message.error.message));
      else pending.resolve(message.result);
      return envelope;
    }
    for (const listener of this.listeners) listener(message);
    return envelope;
  }

  private rejectPending(message: string) {
    for (const request of this.pending.values()) request.reject(new Error(message));
    this.pending.clear();
  }

  private scheduleReconnect() {
    if (this.reconnectTimer || this.socket || !this.socketUrl) return;
    this.emitSession({ type: "session", state: "reconnecting", message: "正在重新连接…" });
    const delays = this.options.reconnectDelaysMs ?? DEFAULT_RECONNECT_DELAYS;
    const baseDelay = delays[Math.min(this.reconnectAttempt, delays.length - 1)] ?? 10_000;
    this.reconnectAttempt += 1;
    const random = this.options.random?.() ?? Math.random();
    const delay = Math.max(0, Math.round(baseDelay * (0.8 + random * 0.4)));
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.reconnectNow();
    }, delay);
  }

  private async reconnectNow() {
    if (this.socket || !this.socketUrl || !this.reconnectEnabled || this.deliberateDisconnect) return;
    try {
      await this.open(this.socketUrl, this.reconnectProtocols, true);
    } catch {
      this.scheduleReconnect();
    }
  }

  private readonly recoverImmediately = () => {
    if (!this.reconnectEnabled || this.socket) return;
    this.cancelReconnect();
    void this.reconnectNow();
  };

  private readonly recoverWhenVisible = () => {
    if (this.options.isDocumentVisible?.() ?? document.visibilityState === "visible") {
      this.recoverImmediately();
    }
  };

  private bindRecoveryListeners() {
    if (this.recoveryListenersBound) return;
    const add = this.options.addWindowListener ?? ((name: RecoveryEvent, listener: () => void) =>
      window.addEventListener(name, listener));
    add("online", this.recoverImmediately);
    add("visibilitychange", this.recoverWhenVisible);
    this.recoveryListenersBound = true;
  }

  private unbindRecoveryListeners() {
    if (!this.recoveryListenersBound) return;
    const remove = this.options.removeWindowListener ?? ((name: RecoveryEvent, listener: () => void) =>
      window.removeEventListener(name, listener));
    remove("online", this.recoverImmediately);
    remove("visibilitychange", this.recoverWhenVisible);
    this.recoveryListenersBound = false;
  }

  private cancelReconnect() {
    if (!this.reconnectTimer) return;
    clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
  }

  private emitSession(envelope: GatewayEnvelope) {
    for (const listener of this.sessionListeners) listener(envelope);
  }
}

export async function createBrowserSession(
  token: string,
  fetcher: typeof fetch = fetch,
) {
  const response = await fetcher("/auth/session", {
    method: "POST",
    credentials: "same-origin",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ token }),
  });
  if (!response.ok) throw new Error("codex-session-login-failed");
}

export type UploadedImage = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
};

export type RemoteApiOptions = {
  baseUrl?: string;
  token?: string;
  imageUploader?: (file: File) => Promise<UploadedImage>;
};

export async function uploadImage(
  file: File,
  fetcher: typeof fetch = fetch,
  options: RemoteApiOptions = {},
): Promise<UploadedImage> {
  if (options.imageUploader) return options.imageUploader(file);
  const response = await fetcher(`${options.baseUrl ?? ""}/api/images`, {
    method: "POST",
    credentials: options.baseUrl ? "omit" : "same-origin",
    headers: {
      "content-type": file.type,
      "x-file-name": encodeURIComponent(file.name),
      ...(options.token ? { authorization: `Bearer ${options.token}` } : {}),
    },
    body: file,
  });
  const value = response.ok ? await response.json() as unknown : undefined;
  return uploadedImageFromResponse(response.status, value);
}

export function uploadedImageFromResponse(status: number, value: unknown): UploadedImage {
  if (status === 413) throw new Error("图片不能超过 10 MB");
  if (status === 415) throw new Error("仅支持 PNG、JPEG、GIF 和 WebP 图片");
  if (status === 401) throw new Error("登录已失效，请重新登录");
  if (status < 200 || status >= 300) throw new Error("图片上传失败");
  if (!value || typeof value !== "object") throw new Error("图片上传响应无效");
  const image = value as Record<string, unknown>;
  if (
    typeof image.id !== "string" || typeof image.name !== "string" ||
    typeof image.mimeType !== "string" || typeof image.size !== "number"
  ) {
    throw new Error("图片上传响应无效");
  }
  return image as UploadedImage;
}

export function remoteSocketUrl(baseUrl: string) {
  const url = new URL(baseUrl);
  url.protocol = url.protocol === "https:" ? "wss:" : "ws:";
  url.pathname = `${url.pathname.replace(/\/$/, "")}/rpc`;
  url.search = "";
  url.hash = "";
  return url.toString();
}

function defaultSocketUrl() {
  const scheme = window.location.protocol === "https:" ? "wss:" : "ws:";
  return `${scheme}//${window.location.host}/rpc`;
}

function encodeToken(token: string) {
  const bytes = new TextEncoder().encode(token);
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/g, "");
}
