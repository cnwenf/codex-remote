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

export class CodexSocket {
  private socket: BrowserSocket | undefined;
  private nextId = 1;
  private readonly pending = new Map<RpcId, PendingRequest>();
  private readonly listeners = new Set<(message: RpcMessage) => void>();
  private readonly sessionListeners = new Set<(envelope: GatewayEnvelope) => void>();

  constructor(
    private readonly factory: SocketFactory = (url, protocols) =>
      new WebSocket(url, protocols) as unknown as BrowserSocket,
  ) {}

  connect(token: string, url = defaultSocketUrl()): Promise<void> {
    if (this.socket) throw new Error("codex-socket-already-connected");
    const socket = this.factory(
      url,
      token ? ["codex-local", `token.${encodeToken(token)}`] : ["codex-local"],
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
      };

      if (socket.readyState === socket.OPEN) {
        opened = true;
        resolveWhenReady();
      }
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
