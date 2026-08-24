import { randomUUID } from "node:crypto";
import {
  createProtocolCapabilities,
  isAllowedClientMethod,
  isSupportedServerRequest,
  type ProtocolCapabilities,
} from "../protocol/capabilities";
import {
  hasRpcId,
  isRpcRequest,
  isRpcResponse,
  type CodexTransport,
  type RpcMessage,
  type RpcResponse,
  type TransportDiagnostic,
} from "../protocol/types";

export interface DesktopBridgeClient {
  start(
    onMessage: (message: unknown) => void,
    onDisconnect: () => void,
  ): Promise<void>;
  sendDesktopMessage(message: unknown): Promise<void>;
  stop(): Promise<void>;
}

type DesktopBridgeTransportOptions = {
  client: DesktopBridgeClient;
  appServerVersion: string;
  hostId?: string;
  reconnectDelayMs?: number;
};

type DesktopEnvelope = {
  type: string;
  hostId?: unknown;
  message?: unknown;
  request?: unknown;
  method?: unknown;
  params?: unknown;
  state?: unknown;
  appServerVersion?: unknown;
  requestId?: unknown;
  responseType?: unknown;
  status?: unknown;
  bodyJsonString?: unknown;
  error?: unknown;
};

const HOST_ROUTES: Readonly<Record<string, string>> = Object.freeze({
  "desktop/listPinnedThreads": "list-pinned-threads",
  "desktop/setThreadPinned": "set-thread-pinned",
  "desktop/setPinnedThreadsOrder": "set-pinned-threads-order",
});

export class DesktopBridgeTransport implements CodexTransport {
  readonly requiresInitialize = false;
  private onMessage?: (message: RpcMessage) => void;
  private onDiagnostic?: (diagnostic: TransportDiagnostic) => void;
  private pendingServerRequests = new Map<string, string>();
  private pendingHostRequests = new Map<string, string | number>();
  private capabilities: ProtocolCapabilities;
  private bridgeState: "stopped" | "live" | "read-only" = "stopped";
  private readonly hostId: string;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private reconnecting = false;

  constructor(private readonly options: DesktopBridgeTransportOptions) {
    this.hostId = options.hostId ?? "local";
    this.capabilities = createProtocolCapabilities(options.appServerVersion);
  }

  get state() {
    return this.bridgeState;
  }

  get protocolCapabilities() {
    return this.capabilities;
  }

  getSessionInfo() {
    return {
      transport: this.bridgeState === "live" ? "desktop-live" as const : "desktop-cold" as const,
      readOnly: this.bridgeState !== "live",
      appServerVersion: this.capabilities.appServerVersion,
    };
  }

  async start(
    onMessage: (message: RpcMessage) => void,
    onDiagnostic: (diagnostic: TransportDiagnostic) => void,
  ): Promise<void> {
    if (this.bridgeState !== "stopped") throw new Error("desktop-bridge-already-started");
    if (!this.capabilities.compatible) {
      this.bridgeState = "read-only";
      throw new Error(this.capabilities.reason ?? "desktop-protocol-incompatible");
    }
    this.onMessage = onMessage;
    this.onDiagnostic = onDiagnostic;
    await this.options.client.start(
      (message) => this.receiveDesktopMessage(message),
      () => this.markDisconnected(true),
    );
    this.bridgeState = "live";
  }

  send(message: RpcMessage): void {
    if (this.bridgeState !== "live") throw new Error("desktop-bridge-read-only");
    if (isRpcRequest(message)) {
      if (!isAllowedClientMethod(this.capabilities, message.method)) {
        throw new Error("desktop-method-not-supported");
      }
      const hostRoute = HOST_ROUTES[message.method];
      if (hostRoute) {
        this.sendHostRequest(message.id, hostRoute, message.params);
        return;
      }
      this.dispatch({
        type: "mcp-request",
        request: message,
        hostId: this.hostId,
        priority: "interactive",
        source: "remote_control",
      });
      return;
    }
    if (isRpcResponse(message)) {
      this.sendServerResponse(message);
      return;
    }
    throw new Error("desktop-notification-send-not-supported");
  }

  async stop(): Promise<void> {
    this.bridgeState = "stopped";
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = undefined;
    this.pendingServerRequests.clear();
    this.pendingHostRequests.clear();
    await this.options.client.stop();
  }

  private receiveDesktopMessage(value: unknown) {
    if (!isDesktopEnvelope(value)) return;
    if (value.type === "fetch-response") {
      this.receiveHostResponse(value);
      return;
    }
    if (value.type === "pinned-threads-updated") {
      this.onMessage?.({ method: "desktop/pins/updated", params: {} });
      return;
    }
    if (value.hostId !== this.hostId) return;
    if (value.type === "mcp-response" && isRpcMessage(value.message)) {
      this.onMessage?.(value.message);
      return;
    }
    if (value.type === "mcp-notification") {
      const notification = { method: value.method, params: value.params };
      if (isRpcMessage(notification)) this.onMessage?.(notification);
      return;
    }
    if (value.type === "mcp-request" && isRpcMessage(value.request)) {
      if (isRpcRequest(value.request)) {
        if (!isSupportedServerRequest(this.capabilities, value.request.method)) {
          this.denyUnsupportedServerRequest(value.request);
          return;
        }
        this.pendingServerRequests.set(rpcKey(value.request.id), value.request.method);
      }
      this.onMessage?.(value.request);
      return;
    }
    if (value.type === "codex-app-server-initialized") {
      this.updateVersion(value.appServerVersion);
      return;
    }
    if (
      value.type === "codex-app-server-connection-changed" &&
      value.state !== "connected"
    ) {
      this.markDisconnected(false);
    }
  }

  private sendServerResponse(response: RpcResponse) {
    const key = rpcKey(response.id);
    const requestMethod = this.pendingServerRequests.get(key);
    if (!requestMethod) throw new Error("desktop-server-request-not-pending");
    this.pendingServerRequests.delete(key);
    this.dispatch({
      type: "mcp-response",
      hostId: this.hostId,
      requestMethod,
      response,
    });
  }

  private sendHostRequest(rpcId: string | number, route: string, params: unknown) {
    const requestId = randomUUID();
    this.pendingHostRequests.set(requestId, rpcId);
    this.dispatch({
      type: "fetch",
      requestId,
      method: "POST",
      url: `vscode://codex/${route}`,
      body: JSON.stringify(params ?? {}),
      reportUploadProgress: false,
    });
  }

  private receiveHostResponse(response: DesktopEnvelope) {
    if (typeof response.requestId !== "string") return;
    const rpcId = this.pendingHostRequests.get(response.requestId);
    if (rpcId === undefined) return;
    this.pendingHostRequests.delete(response.requestId);
    if (
      response.responseType !== "success" ||
      typeof response.status !== "number" ||
      response.status < 200 ||
      response.status >= 300
    ) {
      this.onMessage?.({
        id: rpcId,
        error: { code: -32002, message: "Desktop host request failed" },
      });
      return;
    }
    try {
      const result = typeof response.bodyJsonString === "string"
        ? JSON.parse(response.bodyJsonString)
        : {};
      this.onMessage?.({ id: rpcId, result });
    } catch {
      this.onMessage?.({
        id: rpcId,
        error: { code: -32700, message: "Desktop host response was malformed" },
      });
    }
  }

  private denyUnsupportedServerRequest(request: RpcMessage) {
    if (!isRpcRequest(request)) return;
    this.dispatch({
      type: "mcp-response",
      hostId: this.hostId,
      requestMethod: request.method,
      response: {
        id: request.id,
        error: { code: -32601, message: "Unsupported server request" },
      },
    });
    this.onDiagnostic?.({
      category: "protocol",
      message: "Denied an unsupported Desktop server request",
    });
  }

  private updateVersion(value: unknown) {
    if (typeof value !== "string") return;
    const capabilities = createProtocolCapabilities(value);
    this.capabilities = capabilities;
    if (!capabilities.compatible) {
      this.bridgeState = "read-only";
      this.onDiagnostic?.({
        category: "protocol",
        message: "Desktop App Server version is unsupported; Desktop threads are read-only",
      });
    }
  }

  private markDisconnected(shouldReconnect: boolean) {
    if (this.isStopped()) return;
    if (this.bridgeState === "live") {
      this.bridgeState = "read-only";
      this.pendingServerRequests.clear();
      this.pendingHostRequests.clear();
      this.onDiagnostic?.({
        category: "protocol",
        message: "Desktop bridge disconnected; Desktop threads are read-only",
      });
    }
    if (shouldReconnect) this.scheduleReconnect();
  }

  private scheduleReconnect() {
    if (this.bridgeState !== "read-only" || this.reconnectTimer || this.reconnecting) return;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      void this.reconnect();
    }, this.options.reconnectDelayMs ?? 1_000);
  }

  private async reconnect() {
    if (this.bridgeState !== "read-only" || this.reconnecting) return;
    this.reconnecting = true;
    let connected = false;
    try {
      await this.options.client.start(
        (message) => this.receiveDesktopMessage(message),
        () => this.markDisconnected(true),
      );
      connected = true;
    } catch {
      // Desktop can be between renderer instances; retry while the gateway is alive.
    } finally {
      this.reconnecting = false;
    }
    if (this.isStopped()) return;
    if (!connected) {
      this.scheduleReconnect();
      return;
    }
    this.bridgeState = "live";
    this.onDiagnostic?.({ category: "protocol", message: "Desktop bridge reconnected" });
  }

  private isStopped() {
    return this.bridgeState === "stopped";
  }

  private dispatch(message: unknown) {
    void this.options.client.sendDesktopMessage(message).catch(() => {
      this.markDisconnected(true);
    });
  }
}

function isDesktopEnvelope(value: unknown): value is DesktopEnvelope {
  return !!value && typeof value === "object" && typeof (value as DesktopEnvelope).type === "string";
}

function isRpcMessage(value: unknown): value is RpcMessage {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if ("method" in record && typeof record.method !== "string") return false;
  if ("id" in record) return typeof record.id === "number" || typeof record.id === "string";
  return typeof record.method === "string";
}

function rpcKey(id: string | number) {
  return `${typeof id}:${String(id)}`;
}
