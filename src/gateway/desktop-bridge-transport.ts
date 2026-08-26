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
    onDisconnect: (cause?: Error) => void,
  ): Promise<void>;
  sendDesktopMessage(message: unknown): Promise<void>;
  requestThreadOwner(method: string, params: unknown): Promise<unknown>;
  broadcastQueuedFollowUps(conversationId: string, messages: unknown[]): Promise<void>;
  promoteQueuedFollowUp(conversationId: string, messageId: string, text: string): Promise<boolean>;
  stop(): Promise<void>;
}

type DesktopBridgeTransportOptions = {
  client: DesktopBridgeClient;
  appServerVersion: string;
  hostId?: string;
  reconnectDelayMs?: number;
  appServerProbeIntervalMs?: number;
  appServerDisconnectGraceMs?: number;
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
  threadId?: unknown;
  turnId?: unknown;
  itemId?: unknown;
  text?: unknown;
};

type QueueRequest = Extract<RpcMessage, { id: string | number; method: string }>;

type PendingQueueRead = {
  request: QueueRequest;
  operation: "list" | "add" | "steer";
};

type PendingQueueWrite = {
  request: QueueRequest;
  operation: "add" | "steer";
  threadId: string;
  messages: Record<string, unknown>[];
  message: Record<string, unknown>;
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
  private pendingQueueReads = new Map<string, PendingQueueRead>();
  private pendingQueueWrites = new Map<string, PendingQueueWrite>();
  private capabilities: ProtocolCapabilities;
  private bridgeState: "stopped" | "live" | "read-only" = "stopped";
  private readonly hostId: string;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private appServerProbeTimer?: ReturnType<typeof setTimeout>;
  private appServerDisconnectTimer?: ReturnType<typeof setTimeout>;
  private appServerProbeRequestIds = new Set<string>();
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
    try {
      await this.options.client.start(
        (message) => this.receiveDesktopMessage(message),
        (cause) => this.markDisconnected(true, cause),
      );
      this.bridgeState = "live";
    } catch {
      this.bridgeState = "read-only";
      this.onDiagnostic?.({
        category: "protocol",
        message: "Desktop bridge is unavailable; Desktop threads are read-only",
      });
      this.scheduleReconnect();
    }
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
      if (
        message.method === "desktop/queue/list" ||
        message.method === "desktop/queue/add" ||
        message.method === "desktop/queue/steer"
      ) {
        const operation = message.method.slice("desktop/queue/".length) as PendingQueueRead["operation"];
        this.sendQueueRead(message, operation);
        return;
      }
      const ownerRequest = createOwnerRequest(message);
      if (ownerRequest) {
        void this.sendThreadOwnerRequest(message, ownerRequest);
        return;
      }
      this.dispatchRpcRequest(message);
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
    if (this.appServerProbeTimer) clearTimeout(this.appServerProbeTimer);
    if (this.appServerDisconnectTimer) clearTimeout(this.appServerDisconnectTimer);
    this.reconnectTimer = undefined;
    this.appServerProbeTimer = undefined;
    this.appServerDisconnectTimer = undefined;
    this.appServerProbeRequestIds.clear();
    this.pendingServerRequests.clear();
    this.pendingHostRequests.clear();
    this.pendingQueueReads.clear();
    this.pendingQueueWrites.clear();
    await this.options.client.stop();
  }

  private receiveDesktopMessage(value: unknown) {
    if (!isDesktopEnvelope(value)) return;
    if (value.type === "desktop-visible-agent-message") {
      if (
        typeof value.threadId === "string" &&
        typeof value.turnId === "string" &&
        typeof value.itemId === "string" &&
        typeof value.text === "string"
      ) {
        this.onMessage?.({
          method: "desktop/visibleAgentMessage",
          params: {
            threadId: value.threadId,
            turnId: value.turnId,
            itemId: value.itemId,
            text: value.text,
          },
        });
      }
      return;
    }
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
      this.clearAppServerDisconnectVerification();
      if (this.bridgeState === "read-only" && isRpcResponse(value.message)) {
        // Desktop can briefly emit a disconnected state while the App Server is
        // already answering again. A valid response is authoritative evidence
        // that the bridge is writable, even when Desktop remapped the request id.
        this.markConnected();
      }
      if (
        isRpcResponse(value.message) &&
        this.appServerProbeRequestIds.has(String(value.message.id))
      ) {
        this.markConnected();
        return;
      }
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
    if (value.type === "codex-app-server-connection-changed") {
      if (value.state === "connected") {
        this.clearAppServerDisconnectVerification();
        this.markConnected();
      } else {
        this.scheduleAppServerDisconnectVerification();
      }
      return;
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

  private async sendThreadOwnerRequest(
    original: Extract<RpcMessage, { id: string | number; method: string }>,
    ownerRequest: { method: string; params: unknown },
  ) {
    try {
      const response = await this.options.client.requestThreadOwner(
        ownerRequest.method,
        ownerRequest.params,
      );
      this.onMessage?.({ id: original.id, result: unwrapOwnerResponse(response) });
    } catch (cause) {
      if (isOwnerUnavailable(cause)) {
        this.dispatchRpcRequest(original);
        return;
      }
      this.onMessage?.({
        id: original.id,
        error: {
          code: -32003,
          message: cause instanceof Error ? cause.message : "Desktop thread owner request failed",
        },
      });
    }
  }

  private dispatchRpcRequest(request: RpcMessage) {
    this.dispatch({
      type: "mcp-request",
      request,
      hostId: this.hostId,
      priority: "interactive",
      source: "remote_control",
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
    const queueRead = this.pendingQueueReads.get(response.requestId);
    if (queueRead) {
      this.pendingQueueReads.delete(response.requestId);
      this.receiveQueueState(response, queueRead);
      return;
    }
    const queueWrite = this.pendingQueueWrites.get(response.requestId);
    if (queueWrite) {
      this.pendingQueueWrites.delete(response.requestId);
      void this.receiveQueueWrite(response, queueWrite);
      return;
    }
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

  private sendQueueRead(request: QueueRequest, operation: PendingQueueRead["operation"]) {
    const params = asRecord(request.params);
    if (typeof params.threadId !== "string") {
      this.onMessage?.({ id: request.id, error: { code: -32602, message: "threadId is required" } });
      return;
    }
    if (operation === "add" && (typeof params.text !== "string" || !params.text.trim())) {
      this.onMessage?.({ id: request.id, error: { code: -32602, message: "text is required" } });
      return;
    }
    if (operation === "steer" && typeof params.messageId !== "string") {
      this.onMessage?.({ id: request.id, error: { code: -32602, message: "messageId is required" } });
      return;
    }
    const requestId = randomUUID();
    this.pendingQueueReads.set(requestId, { request, operation });
    this.dispatch({
      type: "fetch",
      requestId,
      method: "POST",
      url: "vscode://codex/get-global-state",
      body: JSON.stringify({ key: "queued-follow-ups" }),
      reportUploadProgress: false,
    });
  }

  private receiveQueueState(response: DesktopEnvelope, pending: PendingQueueRead) {
    if (
      response.responseType !== "success" ||
      typeof response.status !== "number" ||
      response.status < 200 ||
      response.status >= 300
    ) {
      this.onMessage?.({ id: pending.request.id, error: { code: -32002, message: "Desktop queue read failed" } });
      return;
    }
    let state: Record<string, unknown>;
    try {
      const body = typeof response.bodyJsonString === "string"
        ? asRecord(JSON.parse(response.bodyJsonString))
        : {};
      state = asRecord(body.value);
    } catch {
      this.onMessage?.({ id: pending.request.id, error: { code: -32700, message: "Desktop queue state was malformed" } });
      return;
    }
    const params = asRecord(pending.request.params);
    const threadId = String(params.threadId);
    const messages = sanitizeQueueMessages(state[threadId]);
    if (pending.operation === "list") {
      this.onMessage?.({ id: pending.request.id, result: { messages } });
      return;
    }
    if (pending.operation === "steer") {
      const messageId = String(params.messageId);
      const message = messages.find((item) => item.id === messageId);
      if (!message) {
        this.onMessage?.({ id: pending.request.id, error: { code: -32004, message: "Queued message not found" } });
        return;
      }
      void this.promoteVisibleQueuedMessage(
        pending.request,
        threadId,
        messageId,
        message,
        state,
        messages,
      );
      return;
    }
    const text = String(params.text).trim();
    const cwd = typeof params.cwd === "string" && params.cwd ? params.cwd : null;
    const input = Array.isArray(params.input) ? params.input : [];
    const imageAttachments = input.flatMap((item) => {
      const record = asRecord(item);
      return record.type === "localImage" && typeof record.path === "string"
        ? [{ src: record.path }]
        : [];
    });
    const message = {
      id: randomUUID(),
      text,
      context: {
        prompt: text,
        addedFiles: [],
        fileAttachments: [],
        ideContext: null,
        imageAttachments,
        workspaceRoots: cwd ? [cwd] : [],
      },
      cwd,
      createdAt: Date.now(),
    };
    const nextState = { ...state, [threadId]: [...messages, message] };
    this.sendQueueWrite(
      pending.request,
      "add",
      threadId,
      nextState,
      [...messages, message],
      message,
    );
  }

  private async promoteVisibleQueuedMessage(
    request: QueueRequest,
    threadId: string,
    messageId: string,
    message: Record<string, unknown>,
    state: Record<string, unknown>,
    messages: Record<string, unknown>[],
  ) {
    const text = typeof message.text === "string" ? message.text : "";
    try {
      if (await this.options.client.promoteQueuedFollowUp(threadId, messageId, text)) {
        this.onMessage?.({ id: request.id, result: { messageId } });
        return;
      }
    } catch {
      // A hidden or remounting Desktop thread cannot expose its queue action.
    }
    const remaining = messages.filter((item) => item.id !== messageId);
    const nextState = { ...state };
    if (remaining.length > 0) nextState[threadId] = remaining;
    else delete nextState[threadId];
    this.sendQueueWrite(request, "steer", threadId, nextState, remaining, message);
  }

  private sendQueueWrite(
    request: QueueRequest,
    operation: PendingQueueWrite["operation"],
    threadId: string,
    state: Record<string, unknown>,
    messages: Record<string, unknown>[],
    message: Record<string, unknown>,
  ) {
    const requestId = randomUUID();
    this.pendingQueueWrites.set(requestId, { request, operation, threadId, messages, message });
    this.dispatch({
      type: "fetch",
      requestId,
      method: "POST",
      url: "vscode://codex/set-global-state",
      body: JSON.stringify({ key: "queued-follow-ups", value: state }),
      reportUploadProgress: false,
    });
  }

  private async receiveQueueWrite(response: DesktopEnvelope, pending: PendingQueueWrite) {
    if (
      response.responseType !== "success" ||
      typeof response.status !== "number" ||
      response.status < 200 ||
      response.status >= 300
    ) {
      this.onMessage?.({
        id: pending.request.id,
        error: { code: -32002, message: "Desktop queue update failed" },
      });
      return;
    }
    try {
      await this.options.client.broadcastQueuedFollowUps(pending.threadId, pending.messages);
    } catch (cause) {
      this.onMessage?.({
        id: pending.request.id,
        error: {
          code: -32003,
          message: cause instanceof Error ? cause.message : "Desktop queue broadcast failed",
        },
      });
      return;
    }
    if (pending.operation === "add") {
      this.onMessage?.({ id: pending.request.id, result: { message: pending.message } });
      return;
    }
    await this.promoteQueuedMessage(pending.request, pending.threadId, pending.message);
  }

  private async promoteQueuedMessage(
    request: QueueRequest,
    threadId: string,
    message: Record<string, unknown>,
  ) {
    const text = typeof message.text === "string" ? message.text : "";
    const context = asRecord(message.context);
    const imageInput = Array.isArray(context.imageAttachments)
      ? context.imageAttachments.flatMap((attachment) => {
          const record = asRecord(attachment);
          return typeof record.src === "string" ? [{ type: "localImage", path: record.src }] : [];
        })
      : [];
    try {
      await this.options.client.requestThreadOwner(
        "thread-follower-steer-turn",
        {
          conversationId: threadId,
          input: [
            ...(text ? [{ type: "text", text, text_elements: [] }] : []),
            ...imageInput,
          ],
          restoreMessage: message,
          attachments: [],
          clientUserMessageId: typeof message.id === "string" ? message.id : randomUUID(),
        },
      );
      this.onMessage?.({ id: request.id, result: { messageId: message.id } });
    } catch (cause) {
      this.onMessage?.({
        id: request.id,
        error: {
          code: -32003,
          message: cause instanceof Error ? cause.message : "Desktop queue promotion failed",
        },
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

  private markDisconnected(shouldReconnect: boolean, cause?: Error) {
    if (this.isStopped()) return;
    this.clearAppServerDisconnectVerification();
    if (this.bridgeState === "live") {
      this.bridgeState = "read-only";
      this.pendingServerRequests.clear();
      this.pendingHostRequests.clear();
      this.pendingQueueReads.clear();
      this.pendingQueueWrites.clear();
      this.onDiagnostic?.({
        category: "protocol",
        message: cause
          ? `Desktop bridge disconnected (${cause.message}); Desktop threads are read-only`
          : "Desktop bridge disconnected; Desktop threads are read-only",
      });
    }
    if (shouldReconnect) {
      this.clearAppServerProbe();
      this.scheduleReconnect();
    } else {
      this.scheduleAppServerProbe();
    }
  }

  private markConnected() {
    this.clearAppServerDisconnectVerification();
    if (this.bridgeState !== "read-only" || !this.capabilities.compatible) return;
    this.clearAppServerProbe();
    this.bridgeState = "live";
    this.onDiagnostic?.({ category: "protocol", message: "Desktop bridge reconnected" });
  }

  private scheduleAppServerDisconnectVerification() {
    if (this.isStopped() || this.appServerDisconnectTimer) return;
    const delay = this.options.appServerDisconnectGraceMs ?? 1_500;
    if (delay <= 0) {
      this.markDisconnected(false);
      return;
    }
    this.appServerDisconnectTimer = setTimeout(() => {
      this.appServerDisconnectTimer = undefined;
      this.markDisconnected(false);
    }, delay);
  }

  private clearAppServerDisconnectVerification() {
    if (this.appServerDisconnectTimer) clearTimeout(this.appServerDisconnectTimer);
    this.appServerDisconnectTimer = undefined;
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
        (cause) => this.markDisconnected(true, cause),
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
    this.clearAppServerProbe();
    this.onDiagnostic?.({ category: "protocol", message: "Desktop bridge reconnected" });
  }

  private scheduleAppServerProbe() {
    if (
      this.bridgeState !== "read-only" ||
      this.appServerProbeTimer
    ) return;
    this.appServerProbeTimer = setTimeout(() => {
      this.appServerProbeTimer = undefined;
      void this.probeAppServer();
    }, this.options.appServerProbeIntervalMs ?? 2_000);
  }

  private async probeAppServer() {
    if (this.bridgeState !== "read-only") return;
    const requestId = `codex-remote-probe-${randomUUID()}`;
    this.appServerProbeRequestIds.add(requestId);
    while (this.appServerProbeRequestIds.size > 5) {
      const oldest = this.appServerProbeRequestIds.values().next().value;
      if (typeof oldest === "string") this.appServerProbeRequestIds.delete(oldest);
    }
    try {
      await this.options.client.sendDesktopMessage({
        type: "mcp-request",
        hostId: this.hostId,
        priority: "background",
        source: "remote_control",
        request: { id: requestId, method: "thread/list", params: { limit: 1 } },
      });
    } catch {
      this.appServerProbeRequestIds.delete(requestId);
      this.markDisconnected(true);
      return;
    }
    this.appServerProbeTimer = setTimeout(() => {
      this.appServerProbeTimer = undefined;
      this.scheduleAppServerProbe();
    }, this.options.appServerProbeIntervalMs ?? 2_000);
  }

  private clearAppServerProbe() {
    if (this.appServerProbeTimer) clearTimeout(this.appServerProbeTimer);
    this.appServerProbeTimer = undefined;
    this.appServerProbeRequestIds.clear();
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

function createOwnerRequest(message: RpcMessage) {
  if (!isRpcRequest(message) || !message.params || typeof message.params !== "object") return undefined;
  const params = message.params as Record<string, unknown>;
  const conversationId = typeof params.threadId === "string" ? params.threadId : undefined;
  if (!conversationId) return undefined;
  if (message.method === "thread/settings/update") {
    const { threadId: _threadId, ...threadSettings } = params;
    return {
      method: "thread-follower-update-thread-settings",
      params: { conversationId, threadSettings },
    };
  }
  if (message.method !== "turn/steer" || !Array.isArray(params.input)) return undefined;
  const input = params.input.map((item) => {
    if (!item || typeof item !== "object") return item;
    const record = item as Record<string, unknown>;
    return record.type === "text" && typeof record.text === "string"
      ? { ...record, text_elements: Array.isArray(record.text_elements) ? record.text_elements : [] }
      : item;
  });
  const text = input
    .map((item) => item && typeof item === "object" && (item as Record<string, unknown>).type === "text"
      ? (item as Record<string, unknown>).text
      : undefined)
    .filter((value): value is string => typeof value === "string")
    .join("\n");
  const clientUserMessageId = typeof params.clientMessageId === "string"
    ? params.clientMessageId
    : randomUUID();
  const cwd = typeof params.cwd === "string" ? params.cwd : null;
  return {
    method: "thread-follower-steer-turn",
    params: {
      conversationId,
      input,
      restoreMessage: {
        id: clientUserMessageId,
        text,
        context: {
          prompt: text,
          addedFiles: [],
          fileAttachments: [],
          ideContext: null,
          imageAttachments: [],
          workspaceRoots: cwd ? [cwd] : [],
        },
        cwd,
        createdAt: Date.now(),
      },
      serviceTier: params.serviceTier,
      attachments: [],
      clientUserMessageId,
      additionalContext: params.additionalContext,
    },
  };
}

function unwrapOwnerResponse(value: unknown) {
  if (!value || typeof value !== "object") return value;
  const response = value as Record<string, unknown>;
  const result = response.result;
  if (!result || typeof result !== "object") return result;
  const resultRecord = result as Record<string, unknown>;
  return Object.prototype.hasOwnProperty.call(resultRecord, "result")
    ? resultRecord.result
    : resultRecord;
}

function isOwnerUnavailable(cause: unknown) {
  const message = cause instanceof Error ? cause.message : String(cause);
  return message.includes("desktop-thread-owner-unavailable") ||
    message.endsWith("Error: timeout") ||
    message.includes("desktop-owner-module-not-found") ||
    message.includes("desktop-owner-rpc-factory-not-found") ||
    message.includes("desktop-owner-coordination-unavailable") ||
    message.includes("no-client-found") ||
    message.includes("client-disconnected") ||
    message.includes("webcontents-destroyed");
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

function asRecord(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function sanitizeQueueMessages(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is Record<string, unknown> => (
    item !== null &&
    typeof item === "object" &&
    !Array.isArray(item) &&
    typeof (item as Record<string, unknown>).id === "string" &&
    typeof (item as Record<string, unknown>).text === "string"
  ));
}

function rpcKey(id: string | number) {
  return `${typeof id}:${String(id)}`;
}
