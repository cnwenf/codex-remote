import { randomUUID } from "node:crypto";
import { basename } from "node:path";
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
  stop(): Promise<void>;
}

type DesktopBridgeTransportOptions = {
  client: DesktopBridgeClient;
  appServerVersion: string;
  hostId?: string;
  reconnectDelayMs?: number;
  appServerProbeIntervalMs?: number;
  appServerDisconnectGraceMs?: number;
  queueRecoveryRetryDelayMs?: number;
  queueRequestTimeoutMs?: number;
  queueRecoveryDeadlineMs?: number;
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
type QueueRecoveryOutcome = "steer-error" | "add-pending";

type PendingQueueRead = {
  request: QueueRequest;
  operation: "list" | "add" | "steer" | "restore";
  threadId?: string;
  message?: Record<string, unknown>;
  originalMessages?: Record<string, unknown>[];
  recoveryOutcome?: QueueRecoveryOutcome;
};

type PendingQueueWrite = {
  request: QueueRequest;
  operation: "add" | "steer" | "restore";
  threadId: string;
  messages: Record<string, unknown>[];
  message: Record<string, unknown>;
  restoreMessages?: Record<string, unknown>[];
  recoveryOutcome?: QueueRecoveryOutcome;
};

type PendingQueueConfirmation = {
  request: QueueRequest;
  threadId: string;
  message: Record<string, unknown>;
  originalMessages: Record<string, unknown>[];
  absenceChecks: number;
  query: "thread/read" | "thread/turns/list";
  cursor?: string;
  seenCursors: Set<string>;
};

type PendingQueuePromotion = {
  request: QueueRequest;
  threadId: string;
  message: Record<string, unknown>;
  restoreMessages?: Record<string, unknown>[];
  phase: "steer" | "start";
};

type DeferredQueueRecovery = Omit<PendingQueueConfirmation, "request" | "query"> & {
  key: string;
  phase: "confirmation" | "restore";
  query: PendingQueueConfirmation["query"];
  recoveryOutcome?: QueueRecoveryOutcome;
};

const QUEUE_CONFIRMATION_PREFIX = "codex-remote-queue-confirm-";
const QUEUE_PROMOTION_PREFIX = "codex-remote-queue-promote-";
const QUEUE_CONFIRMATION_ABSENCE_CHECKS = 3;

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
  private activeQueueMutation?: {
    request: QueueRequest;
    operation: "add" | "steer";
  };
  private persistedQueueMutation?: PendingQueueWrite;
  private pendingQueueRecovery?: {
    request: QueueRequest;
    threadId: string;
    message: Record<string, unknown>;
    originalMessages: Record<string, unknown>[];
    recoveryOutcome: QueueRecoveryOutcome;
  };
  private pendingQueueConfirmation?: PendingQueueConfirmation;
  private pendingQueueConfirmationRequests = new Map<string, PendingQueueConfirmation>();
  private pendingQueuePromotions = new Map<string, PendingQueuePromotion>();
  private queueConfirmationRequestIds = new Set<string>();
  private queueRequestTimeouts = new Map<string, {
    requestKey: string;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  private deferredQueueRecoveries = new Map<string, DeferredQueueRecovery>();
  private silentQueueRequestIds = new Set<string>();
  private activeBackgroundRecoveryKey?: string;
  private queuedQueueMutations: Array<{
    request: QueueRequest;
    operation: "add" | "steer";
  }> = [];
  private capabilities: ProtocolCapabilities;
  private bridgeState: "stopped" | "live" | "read-only" = "stopped";
  private readonly hostId: string;
  private reconnectTimer?: ReturnType<typeof setTimeout>;
  private appServerProbeTimer?: ReturnType<typeof setTimeout>;
  private appServerDisconnectTimer?: ReturnType<typeof setTimeout>;
  private queueRecoveryRetryTimer?: ReturnType<typeof setTimeout>;
  private queueRecoveryDeadlineTimer?: ReturnType<typeof setTimeout>;
  private backgroundQueueRecoveryTimer?: ReturnType<typeof setTimeout>;
  private queueRecoveryRetryCount = 0;
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
        this.enqueueQueueRead(message, operation);
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
    if (this.queueRecoveryRetryTimer) clearTimeout(this.queueRecoveryRetryTimer);
    if (this.queueRecoveryDeadlineTimer) clearTimeout(this.queueRecoveryDeadlineTimer);
    if (this.backgroundQueueRecoveryTimer) clearTimeout(this.backgroundQueueRecoveryTimer);
    for (const pending of this.queueRequestTimeouts.values()) clearTimeout(pending.timeout);
    this.reconnectTimer = undefined;
    this.appServerProbeTimer = undefined;
    this.appServerDisconnectTimer = undefined;
    this.queueRecoveryRetryTimer = undefined;
    this.queueRecoveryDeadlineTimer = undefined;
    this.backgroundQueueRecoveryTimer = undefined;
    this.appServerProbeRequestIds.clear();
    this.pendingServerRequests.clear();
    this.pendingHostRequests.clear();
    this.pendingQueueReads.clear();
    this.pendingQueueWrites.clear();
    this.pendingQueueConfirmationRequests.clear();
    this.pendingQueuePromotions.clear();
    this.queueConfirmationRequestIds.clear();
    this.queueRequestTimeouts.clear();
    this.activeQueueMutation = undefined;
    this.persistedQueueMutation = undefined;
    this.pendingQueueRecovery = undefined;
    this.pendingQueueConfirmation = undefined;
    this.deferredQueueRecoveries.clear();
    this.silentQueueRequestIds.clear();
    this.activeBackgroundRecoveryKey = undefined;
    this.queuedQueueMutations = [];
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
      if (isRpcResponse(value.message)) {
        const key = rpcKey(value.message.id);
        const promotion = this.pendingQueuePromotions.get(key);
        if (promotion) {
          this.clearQueueRequestTimeout(`rpc:${key}`);
          this.pendingQueuePromotions.delete(key);
          this.receiveQueuePromotion(value.message, promotion);
          return;
        }
        if (
          typeof value.message.id === "string" &&
          value.message.id.startsWith(QUEUE_PROMOTION_PREFIX)
        ) return;
        const confirmation = this.pendingQueueConfirmationRequests.get(key);
        if (confirmation) {
          this.clearQueueRequestTimeout(`rpc:${key}`);
          this.pendingQueueConfirmationRequests.delete(key);
          this.queueConfirmationRequestIds.delete(key);
          this.receiveQueueConfirmation(value.message, confirmation);
          return;
        }
        if (this.queueConfirmationRequestIds.delete(key)) {
          return;
        }
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
      this.clearQueueRequestTimeout(`fetch:${response.requestId}`);
      this.pendingQueueReads.delete(response.requestId);
      this.receiveQueueState(response, queueRead);
      return;
    }
    const queueWrite = this.pendingQueueWrites.get(response.requestId);
    if (queueWrite) {
      this.clearQueueRequestTimeout(`fetch:${response.requestId}`);
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

  private enqueueQueueRead(request: QueueRequest, operation: PendingQueueRead["operation"]) {
    if (operation === "list") {
      this.sendQueueRead(request, operation);
      return;
    }
    if (operation !== "add" && operation !== "steer") return;
    if (this.activeBackgroundRecoveryKey) this.deferActiveQueueRecovery(false);
    if (this.activeQueueMutation) {
      this.queuedQueueMutations.push({ request, operation });
      return;
    }
    this.activeQueueMutation = { request, operation };
    this.sendQueueRead(request, operation);
  }

  private sendQueueRead(request: QueueRequest, operation: PendingQueueRead["operation"]) {
    const params = asRecord(request.params);
    if (typeof params.threadId !== "string") {
      this.finishQueueRequest(request, { id: request.id, error: { code: -32602, message: "threadId is required" } });
      return;
    }
    const hasLocalImage = Array.isArray(params.input) && params.input.some((item) => {
      const record = asRecord(item);
      return record.type === "localImage" && typeof record.path === "string" && Boolean(record.path.trim());
    });
    if (operation === "add" &&
      (typeof params.text !== "string" || !params.text.trim()) &&
      !hasLocalImage) {
      this.finishQueueRequest(request, {
        id: request.id,
        error: { code: -32602, message: "text or localImage input is required" },
      });
      return;
    }
    if (operation === "steer" && typeof params.messageId !== "string") {
      this.finishQueueRequest(request, { id: request.id, error: { code: -32602, message: "messageId is required" } });
      return;
    }
    const requestId = randomUUID();
    this.pendingQueueReads.set(requestId, { request, operation });
    this.trackQueueRequestTimeout(`fetch:${requestId}`, request, () => {
      const pending = this.pendingQueueReads.get(requestId);
      if (!pending) return;
      this.pendingQueueReads.delete(requestId);
      this.finishQueueRequest(request, {
        id: request.id,
        error: { code: -32007, message: "Desktop queue read timed out" },
      });
    });
    this.dispatch({
      type: "fetch",
      requestId,
      method: "POST",
      url: "vscode://codex/get-global-state",
      body: JSON.stringify({ key: "queued-follow-ups" }),
      reportUploadProgress: false,
    });
  }

  private finishQueueRequest(request: QueueRequest, response: RpcMessage) {
    if (request.method !== "desktop/queue/list" && !this.isActiveQueueMutation(request)) return;
    const key = rpcKey(request.id);
    const silent = this.silentQueueRequestIds.delete(key);
    if (!silent) this.onMessage?.(response);
    if (request.method === "desktop/queue/list") return;
    if (silent && this.activeBackgroundRecoveryKey) {
      this.deferredQueueRecoveries.delete(this.activeBackgroundRecoveryKey);
      this.activeBackgroundRecoveryKey = undefined;
    }
    this.releaseActiveQueueMutation(request);
  }

  private releaseActiveQueueMutation(request: QueueRequest) {
    this.clearQueueRequestState(request);
    const next = this.queuedQueueMutations.shift();
    if (!next) {
      this.activeQueueMutation = undefined;
      this.scheduleBackgroundQueueRecovery();
      return;
    }
    this.activeQueueMutation = next;
    this.sendQueueRead(next.request, next.operation);
  }

  private isActiveQueueMutation(request: QueueRequest) {
    return Boolean(
      this.activeQueueMutation &&
      rpcKey(this.activeQueueMutation.request.id) === rpcKey(request.id),
    );
  }

  private clearQueueRequestState(request: QueueRequest) {
    const key = rpcKey(request.id);
    for (const [requestId, pending] of this.pendingQueueReads) {
      if (rpcKey(pending.request.id) === key) this.pendingQueueReads.delete(requestId);
    }
    for (const [requestId, pending] of this.pendingQueueWrites) {
      if (rpcKey(pending.request.id) === key) this.pendingQueueWrites.delete(requestId);
    }
    if (this.persistedQueueMutation && rpcKey(this.persistedQueueMutation.request.id) === key) {
      this.persistedQueueMutation = undefined;
    }
    if (this.pendingQueueRecovery && rpcKey(this.pendingQueueRecovery.request.id) === key) {
      this.pendingQueueRecovery = undefined;
    }
    if (this.pendingQueueConfirmation && rpcKey(this.pendingQueueConfirmation.request.id) === key) {
      this.pendingQueueConfirmation = undefined;
    }
    for (const [requestId, pending] of this.pendingQueueConfirmationRequests) {
      if (rpcKey(pending.request.id) === key) this.pendingQueueConfirmationRequests.delete(requestId);
    }
    for (const [requestId, pending] of this.pendingQueuePromotions) {
      if (rpcKey(pending.request.id) === key) this.pendingQueuePromotions.delete(requestId);
    }
    this.clearQueueRecoveryRetry();
    this.clearQueueRecoveryDeadline();
    for (const [requestId, pending] of this.queueRequestTimeouts) {
      if (pending.requestKey === key) {
        clearTimeout(pending.timeout);
        this.queueRequestTimeouts.delete(requestId);
      }
    }
  }

  private sendQueueConfirmationRead(
    request: QueueRequest,
    threadId: string,
    message: Record<string, unknown>,
    originalMessages: Record<string, unknown>[],
  ) {
    this.pendingQueueConfirmation = {
      request,
      threadId,
      message,
      originalMessages,
      absenceChecks: 0,
      query: "thread/read",
      seenCursors: new Set<string>(),
    };
    this.ensureQueueRecoveryDeadline();
    this.resumePendingQueueConfirmation();
  }

  private resumePendingQueueConfirmation() {
    const confirmation = this.pendingQueueConfirmation;
    if (!confirmation || this.bridgeState !== "live" || !this.isActiveQueueMutation(confirmation.request)) return;
    if ([...this.pendingQueueConfirmationRequests.values()].some((pending) => (
      rpcKey(pending.request.id) === rpcKey(confirmation.request.id)
    ))) return;
    const requestId = `${QUEUE_CONFIRMATION_PREFIX}${randomUUID()}`;
    const key = rpcKey(requestId);
    this.pendingQueueConfirmationRequests.set(key, confirmation);
    this.queueConfirmationRequestIds.add(key);
    while (this.queueConfirmationRequestIds.size > 100) {
      const oldest = this.queueConfirmationRequestIds.values().next().value;
      if (typeof oldest === "string") this.queueConfirmationRequestIds.delete(oldest);
    }
    this.trackQueueRequestTimeout(`rpc:${key}`, confirmation.request, () => {
      if (!this.pendingQueueConfirmationRequests.delete(key)) return;
      this.scheduleQueueRecoveryRetry();
    });
    this.dispatch({
      type: "mcp-request",
      request: {
        id: requestId,
        method: confirmation.query,
        params: confirmation.query === "thread/read"
          ? { threadId: confirmation.threadId, includeTurns: true }
          : {
              threadId: confirmation.threadId,
              limit: 8,
              sortDirection: "desc",
              itemsView: "full",
              ...(confirmation.cursor ? { cursor: confirmation.cursor } : {}),
            },
      },
      hostId: this.hostId,
      priority: "background",
      source: "remote_control",
    });
  }

  private receiveQueueConfirmation(response: RpcResponse, pending: PendingQueueConfirmation) {
    if (!this.isActiveQueueMutation(pending.request) || this.pendingQueueConfirmation !== pending) return;
    if (!response.result || typeof response.result !== "object" || response.error) {
      this.scheduleQueueRecoveryRetry();
      return;
    }
    const messageId = typeof pending.message.id === "string" ? pending.message.id : undefined;
    if (!messageId) {
      this.scheduleQueueRecoveryRetry();
      return;
    }
    const inspection = inspectQueueConfirmation(
      response.result,
      pending.query,
      pending.threadId,
      messageId,
    );
    if (inspection.status === "fallback") {
      pending.query = "thread/turns/list";
      pending.cursor = undefined;
      pending.seenCursors.clear();
      this.scheduleQueueRecoveryRetry();
      return;
    }
    if (inspection.status === "invalid") {
      this.scheduleQueueRecoveryRetry();
      return;
    }
    if (inspection.status === "accepted") {
      this.finishQueueRequest(pending.request, {
        id: pending.request.id,
        result: { messageId, pendingConfirmation: true },
      });
      return;
    }
    if (inspection.nextCursor) {
      if (
        inspection.nextCursor === pending.cursor ||
        pending.seenCursors.has(inspection.nextCursor)
      ) {
        // A buggy/stale cursor must not pin recovery to one old page forever.
        // Restart from the newest page; a finite history otherwise continues
        // across foreground deadlines and silent background attempts.
        pending.cursor = undefined;
        pending.seenCursors.clear();
        this.scheduleQueueRecoveryRetry();
        return;
      }
      pending.seenCursors.add(inspection.nextCursor);
      pending.cursor = inspection.nextCursor;
      this.scheduleQueueRecoveryRetry();
      return;
    }
    pending.absenceChecks += 1;
    pending.cursor = undefined;
    pending.seenCursors.clear();
    if (pending.absenceChecks < QUEUE_CONFIRMATION_ABSENCE_CHECKS) {
      this.scheduleQueueRecoveryRetry();
      return;
    }
    this.pendingQueueConfirmation = undefined;
    this.sendQueueRestoreRead(
      pending.request,
      pending.threadId,
      pending.message,
      pending.originalMessages,
    );
  }

  private sendQueueRestoreRead(
    request: QueueRequest,
    threadId: string,
    message: Record<string, unknown>,
    originalMessages: Record<string, unknown>[],
    recoveryOutcome: QueueRecoveryOutcome = "steer-error",
  ) {
    this.pendingQueueRecovery = {
      request,
      threadId,
      message,
      originalMessages,
      recoveryOutcome,
    };
    this.ensureQueueRecoveryDeadline();
    this.resumePendingQueueRecovery();
  }

  private resumePendingQueueRecovery() {
    const recovery = this.pendingQueueRecovery;
    if (!recovery || this.bridgeState !== "live" || !this.isActiveQueueMutation(recovery.request)) return;
    if ([...this.pendingQueueReads.values()].some((pending) => (
      pending.operation === "restore" && rpcKey(pending.request.id) === rpcKey(recovery.request.id)
    ))) return;
    const requestId = randomUUID();
    this.pendingQueueReads.set(requestId, {
      request: recovery.request,
      operation: "restore",
      threadId: recovery.threadId,
      message: recovery.message,
      originalMessages: recovery.originalMessages,
      recoveryOutcome: recovery.recoveryOutcome,
    });
    this.trackQueueRequestTimeout(`fetch:${requestId}`, recovery.request, () => {
      const pending = this.pendingQueueReads.get(requestId);
      if (!pending) return;
      this.pendingQueueReads.delete(requestId);
      this.scheduleQueueRecoveryRetry();
    });
    this.dispatch({
      type: "fetch",
      requestId,
      method: "POST",
      url: "vscode://codex/get-global-state",
      body: JSON.stringify({ key: "queued-follow-ups" }),
      reportUploadProgress: false,
    });
  }

  private scheduleQueueRecoveryRetry() {
    if (this.queueRecoveryRetryTimer || this.isStopped()) return;
    const attempt = this.queueRecoveryRetryCount++;
    const configuredDelay = this.options.queueRecoveryRetryDelayMs;
    const delay = configuredDelay ?? Math.min(2_000, 250 * (2 ** Math.min(attempt, 3)));
    this.queueRecoveryRetryTimer = setTimeout(() => {
      this.queueRecoveryRetryTimer = undefined;
      if (this.bridgeState !== "live") return;
      if (this.pendingQueueConfirmation) this.resumePendingQueueConfirmation();
      else this.resumePendingQueueRecovery();
    }, delay);
  }

  private clearQueueRecoveryRetry() {
    if (this.queueRecoveryRetryTimer) clearTimeout(this.queueRecoveryRetryTimer);
    this.queueRecoveryRetryTimer = undefined;
    this.queueRecoveryRetryCount = 0;
  }

  private ensureQueueRecoveryDeadline() {
    if (this.queueRecoveryDeadlineTimer || this.isStopped()) return;
    this.queueRecoveryDeadlineTimer = setTimeout(() => {
      this.queueRecoveryDeadlineTimer = undefined;
      this.deferActiveQueueRecovery(true);
    }, this.options.queueRecoveryDeadlineMs ?? 30_000);
  }

  private clearQueueRecoveryDeadline() {
    if (this.queueRecoveryDeadlineTimer) clearTimeout(this.queueRecoveryDeadlineTimer);
    this.queueRecoveryDeadlineTimer = undefined;
  }

  private trackQueueRequestTimeout(
    key: string,
    request: QueueRequest,
    onTimeout: () => void,
  ) {
    this.clearQueueRequestTimeout(key);
    const timeout = setTimeout(() => {
      this.queueRequestTimeouts.delete(key);
      if (this.isActiveQueueMutation(request)) onTimeout();
    }, this.options.queueRequestTimeoutMs ?? 10_000);
    this.queueRequestTimeouts.set(key, { requestKey: rpcKey(request.id), timeout });
  }

  private clearQueueRequestTimeout(key: string) {
    const pending = this.queueRequestTimeouts.get(key);
    if (!pending) return;
    clearTimeout(pending.timeout);
    this.queueRequestTimeouts.delete(key);
  }

  private deferActiveQueueRecovery(scheduleBackground: boolean) {
    const active = this.activeQueueMutation?.request;
    if (!active) return;
    const confirmation = this.pendingQueueConfirmation;
    const recovery = this.pendingQueueRecovery;
    const source = confirmation ?? recovery;
    if (!source || rpcKey(source.request.id) !== rpcKey(active.id)) return;
    const messageId = typeof source.message.id === "string" ? source.message.id : randomUUID();
    const deferredKey = `${source.threadId}\u0000${messageId}`;
    // Requeue an exhausted/background-preempted recovery at the tail so one
    // permanently failing item cannot starve every later deferred item.
    this.deferredQueueRecoveries.delete(deferredKey);
    this.deferredQueueRecoveries.set(deferredKey, {
      key: deferredKey,
      phase: confirmation ? "confirmation" : "restore",
      query: confirmation?.query ?? "thread/read",
      threadId: source.threadId,
      message: source.message,
      originalMessages: source.originalMessages,
      absenceChecks: confirmation?.absenceChecks ?? 0,
      cursor: confirmation?.cursor,
      seenCursors: new Set(confirmation?.seenCursors ?? []),
      recoveryOutcome: recovery?.recoveryOutcome,
    });
    const silent = this.silentQueueRequestIds.delete(rpcKey(active.id));
    if (!silent) {
      this.onMessage?.(confirmation || recovery?.recoveryOutcome === "add-pending" ? {
        id: active.id,
        result: confirmation
          ? { messageId, pendingConfirmation: true }
          : { message: outboundQueueMessage(source.message), pendingConfirmation: true },
      } : {
        id: active.id,
        error: {
          code: -32006,
          message: "Desktop queue recovery continues in background",
        },
      });
    }
    this.activeBackgroundRecoveryKey = undefined;
    this.clearQueueRequestState(active);
    const next = this.queuedQueueMutations.shift();
    if (next) {
      this.activeQueueMutation = next;
      this.sendQueueRead(next.request, next.operation);
    } else {
      this.activeQueueMutation = undefined;
      if (scheduleBackground) this.scheduleBackgroundQueueRecovery();
    }
  }

  private scheduleBackgroundQueueRecovery() {
    if (
      this.backgroundQueueRecoveryTimer ||
      this.deferredQueueRecoveries.size === 0 ||
      this.isStopped()
    ) return;
    const delay = Math.max(100, this.options.queueRecoveryRetryDelayMs ?? 1_000);
    this.backgroundQueueRecoveryTimer = setTimeout(() => {
      this.backgroundQueueRecoveryTimer = undefined;
      this.startBackgroundQueueRecovery();
    }, delay);
  }

  private startBackgroundQueueRecovery() {
    if (this.bridgeState !== "live" || this.activeQueueMutation) {
      this.scheduleBackgroundQueueRecovery();
      return;
    }
    const deferred = this.deferredQueueRecoveries.values().next().value as DeferredQueueRecovery | undefined;
    if (!deferred) return;
    const request: QueueRequest = {
      id: `codex-remote-queue-background-${randomUUID()}`,
      method: "desktop/queue/steer",
      params: { threadId: deferred.threadId, messageId: deferred.message.id },
    };
    this.silentQueueRequestIds.add(rpcKey(request.id));
    this.activeBackgroundRecoveryKey = deferred.key;
    this.activeQueueMutation = { request, operation: "steer" };
    if (deferred.phase === "confirmation") {
      this.pendingQueueConfirmation = {
        request,
        threadId: deferred.threadId,
        message: deferred.message,
        originalMessages: deferred.originalMessages,
        absenceChecks: deferred.absenceChecks,
        query: deferred.query,
        cursor: deferred.cursor,
        seenCursors: new Set(deferred.seenCursors),
      };
      this.ensureQueueRecoveryDeadline();
      this.resumePendingQueueConfirmation();
    } else {
      this.pendingQueueRecovery = {
        request,
        threadId: deferred.threadId,
        message: deferred.message,
        originalMessages: deferred.originalMessages,
        recoveryOutcome: deferred.recoveryOutcome ?? "steer-error",
      };
      this.ensureQueueRecoveryDeadline();
      this.resumePendingQueueRecovery();
    }
  }

  private receiveQueueState(response: DesktopEnvelope, pending: PendingQueueRead) {
    if (pending.operation !== "list" && !this.isActiveQueueMutation(pending.request)) return;
    if (
      response.responseType !== "success" ||
      typeof response.status !== "number" ||
      response.status < 200 ||
      response.status >= 300
    ) {
      if (pending.operation === "restore") {
        this.scheduleQueueRecoveryRetry();
        return;
      }
      this.finishQueueRequest(pending.request, {
        id: pending.request.id,
        error: {
          code: -32002,
          message: "Desktop queue read failed",
        },
      });
      return;
    }
    let state: Record<string, unknown>;
    try {
      const body = typeof response.bodyJsonString === "string"
        ? JSON.parse(response.bodyJsonString)
        : undefined;
      if (!isRecordValue(body) || !isRecordValue(body.value)) {
        throw new Error("desktop-queue-state-shape-invalid");
      }
      state = body.value;
    } catch {
      if (pending.operation === "restore") {
        this.scheduleQueueRecoveryRetry();
        return;
      }
      this.finishQueueRequest(pending.request, {
        id: pending.request.id,
        error: { code: -32700, message: "Desktop queue state was malformed" },
      });
      return;
    }
    const params = asRecord(pending.request.params);
    const threadId = pending.threadId ?? String(params.threadId);
    const messages = sanitizeQueueMessages(state[threadId]);
    if (pending.operation === "restore") {
      if (!pending.message || !pending.originalMessages) {
        this.finishQueueRequest(pending.request, {
          id: pending.request.id,
          error: { code: -32002, message: "Desktop queue restore failed" },
        });
        return;
      }
      const restoredMessages = mergeRestoredQueueMessage(
        messages,
        pending.originalMessages,
        pending.message,
      );
      this.sendQueueWrite(
        pending.request,
        "restore",
        threadId,
        { ...state, [threadId]: restoredMessages },
        restoredMessages,
        pending.message,
        undefined,
        pending.recoveryOutcome ?? "steer-error",
      );
      return;
    }
    if (pending.operation === "list") {
      this.finishQueueRequest(pending.request, {
        id: pending.request.id,
        result: { messages: messages.map(outboundQueueMessage) },
      });
      return;
    }
    if (pending.operation === "steer") {
      const messageId = String(params.messageId);
      const message = messages.find((item) => item.id === messageId);
      if (!message) {
        this.finishQueueRequest(pending.request, {
          id: pending.request.id,
          error: { code: -32004, message: "Queued message not found" },
        });
        return;
      }
      void this.promoteVisibleQueuedMessage(
        pending.request,
        threadId,
        message,
        state,
        messages,
      );
      return;
    }
    const text = typeof params.text === "string" ? params.text.trim() : "";
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
    message: Record<string, unknown>,
    state: Record<string, unknown>,
    messages: Record<string, unknown>[],
  ) {
    if (!this.isActiveQueueMutation(request)) return;
    const remaining = messages.filter((item) => item.id !== message.id);
    const nextState = { ...state };
    if (remaining.length > 0) nextState[threadId] = remaining;
    else delete nextState[threadId];
    this.sendQueueWrite(request, "steer", threadId, nextState, remaining, message, messages);
  }

  private sendQueueWrite(
    request: QueueRequest,
    operation: PendingQueueWrite["operation"],
    threadId: string,
    state: Record<string, unknown>,
    messages: Record<string, unknown>[],
    message: Record<string, unknown>,
    restoreMessages?: Record<string, unknown>[],
    recoveryOutcome?: QueueRecoveryOutcome,
  ) {
    const requestId = randomUUID();
    this.pendingQueueWrites.set(requestId, {
      request,
      operation,
      threadId,
      messages,
      message,
      restoreMessages,
      recoveryOutcome,
    });
    this.trackQueueRequestTimeout(`fetch:${requestId}`, request, () => {
      const pending = this.pendingQueueWrites.get(requestId);
      if (!pending) return;
      this.pendingQueueWrites.delete(requestId);
      if (operation === "restore") {
        this.scheduleQueueRecoveryRetry();
        return;
      }
      this.sendQueueRestoreRead(
        request,
        threadId,
        message,
        operation === "add" ? messages : (restoreMessages ?? messages),
        operation === "add" ? "add-pending" : "steer-error",
      );
    });
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
    if (!this.isActiveQueueMutation(pending.request)) return;
    if (
      response.responseType !== "success" ||
      typeof response.status !== "number" ||
      response.status < 200 ||
      response.status >= 300
    ) {
      if (pending.operation === "restore") {
        this.scheduleQueueRecoveryRetry();
        return;
      }
      this.finishQueueRequest(pending.request, {
        id: pending.request.id,
        error: {
          code: -32002,
          message: "Desktop queue update failed",
        },
      });
      return;
    }
    if (pending.operation !== "restore") this.persistedQueueMutation = pending;
    if (pending.operation === "restore") {
      try {
        await this.options.client.broadcastQueuedFollowUps(pending.threadId, pending.messages);
      } catch {
        // The authoritative global state was restored even if the visible Desktop owner disappeared.
      }
      this.finishQueueRequest(pending.request, pending.recoveryOutcome === "add-pending" ? {
        id: pending.request.id,
        result: { message: outboundQueueMessage(pending.message), pendingConfirmation: true },
      } : {
        id: pending.request.id,
        error: {
          code: -32003,
          message: "Desktop could not confirm the promotion; the message was kept queued",
        },
      });
      return;
    }
    try {
      await this.options.client.broadcastQueuedFollowUps(pending.threadId, pending.messages);
    } catch {
      if (!this.isActiveQueueMutation(pending.request)) return;
      if (pending.operation === "add") {
        this.finishQueueRequest(pending.request, {
          id: pending.request.id,
          result: { message: outboundQueueMessage(pending.message), pendingConfirmation: true },
        });
        return;
      }
      await this.promoteQueuedMessage(
        pending.request,
        pending.threadId,
        pending.message,
        pending.restoreMessages,
      );
      return;
    }
    if (!this.isActiveQueueMutation(pending.request)) return;
    if (pending.operation === "add") {
      this.finishQueueRequest(pending.request, {
        id: pending.request.id,
        result: { message: outboundQueueMessage(pending.message) },
      });
      return;
    }
    await this.promoteQueuedMessage(
      pending.request,
      pending.threadId,
      pending.message,
      pending.restoreMessages,
    );
  }

  private async promoteQueuedMessage(
    request: QueueRequest,
    threadId: string,
    message: Record<string, unknown>,
    restoreMessages?: Record<string, unknown>[],
  ) {
    const text = typeof message.text === "string" ? message.text : "";
    const context = asRecord(message.context);
    const imageInput = Array.isArray(context.imageAttachments)
      ? context.imageAttachments.flatMap((attachment) => {
          const record = asRecord(attachment);
          return typeof record.src === "string" ? [{ type: "localImage", path: record.src }] : [];
        })
      : [];
    const params = asRecord(request.params);
    const expectedTurnId = typeof params.expectedTurnId === "string" && params.expectedTurnId
      ? params.expectedTurnId
      : undefined;
    this.dispatchQueuePromotion({
      request,
      threadId,
      message,
      restoreMessages,
      phase: expectedTurnId ? "steer" : "start",
    }, [
      ...(text ? [{ type: "text", text }] : []),
      ...imageInput,
    ]);
  }

  private dispatchQueuePromotion(
    pending: PendingQueuePromotion,
    input?: Array<Record<string, unknown>>,
  ) {
    if (!this.isActiveQueueMutation(pending.request)) return;
    const requestId = `${QUEUE_PROMOTION_PREFIX}${randomUUID()}`;
    const key = rpcKey(requestId);
    this.pendingQueuePromotions.set(key, pending);
    this.trackQueueRequestTimeout(`rpc:${key}`, pending.request, () => {
      if (!this.pendingQueuePromotions.delete(key)) return;
      if (pending.restoreMessages) {
        this.sendQueueConfirmationRead(
          pending.request,
          pending.threadId,
          pending.message,
          pending.restoreMessages,
        );
      } else {
        this.finishQueueRequest(pending.request, {
          id: pending.request.id,
          error: { code: -32003, message: "Desktop queue promotion failed" },
        });
      }
    });
    const messageContext = asRecord(pending.message.context);
    const workspaceRoots = Array.isArray(messageContext.workspaceRoots)
      ? messageContext.workspaceRoots
      : [];
    const cwd = typeof pending.message.cwd === "string"
      ? pending.message.cwd
      : workspaceRoots.find((value): value is string => typeof value === "string");
    const sourceParams = asRecord(pending.request.params);
    const expectedTurnId = typeof sourceParams.expectedTurnId === "string"
      ? sourceParams.expectedTurnId
      : undefined;
    const promotionInput = input ?? queuedMessageInput(pending.message);
    this.dispatch({
      type: "mcp-request",
      request: {
        id: requestId,
        method: pending.phase === "steer" ? "turn/steer" : "turn/start",
        params: {
          threadId: pending.threadId,
          input: promotionInput,
          ...(cwd ? { cwd } : {}),
          ...(pending.phase === "steer" && expectedTurnId ? { expectedTurnId } : {}),
          clientMessageId: typeof pending.message.id === "string"
            ? pending.message.id
            : randomUUID(),
        },
      },
      hostId: this.hostId,
      priority: "interactive",
      source: "remote_control",
    });
  }

  private receiveQueuePromotion(response: RpcResponse, pending: PendingQueuePromotion) {
    if (!this.isActiveQueueMutation(pending.request)) return;
    if (response.error) {
      if (pending.phase === "steer" && isInactiveQueueSteerError(response.error)) {
        this.dispatchQueuePromotion({ ...pending, phase: "start" });
        return;
      }
      if (pending.restoreMessages) {
        this.sendQueueRestoreRead(
          pending.request,
          pending.threadId,
          pending.message,
          pending.restoreMessages,
        );
      } else {
        this.finishQueueRequest(pending.request, {
          id: pending.request.id,
          error: { code: -32003, message: "Desktop queue promotion failed" },
        });
      }
      return;
    }
    this.finishQueueRequest(pending.request, {
      id: pending.request.id,
      result: { messageId: pending.message.id },
    });
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
      this.failPendingQueueOperations();
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

  private failPendingQueueOperations() {
    this.clearQueueRecoveryRetry();
    for (const pending of this.queueRequestTimeouts.values()) clearTimeout(pending.timeout);
    this.queueRequestTimeouts.clear();
    const activeRequest = this.activeQueueMutation?.request;
    const activeKey = activeRequest ? rpcKey(activeRequest.id) : undefined;
    const uncertainPromotion = activeKey
      ? [...this.pendingQueuePromotions.values()].find((pending) => (
          rpcKey(pending.request.id) === activeKey
        ))
      : undefined;
    if (!this.pendingQueueConfirmation && uncertainPromotion?.restoreMessages) {
      this.pendingQueueConfirmation = {
        request: uncertainPromotion.request,
        threadId: uncertainPromotion.threadId,
        message: uncertainPromotion.message,
        originalMessages: uncertainPromotion.restoreMessages,
        absenceChecks: 0,
        query: "thread/read",
        seenCursors: new Set<string>(),
      };
      this.ensureQueueRecoveryDeadline();
    }
    const uncertainWrite = activeKey
      ? [...this.pendingQueueWrites.values()].find((pending) => (
          rpcKey(pending.request.id) === activeKey && pending.operation !== "restore"
        ))
      : undefined;
    if (!this.pendingQueueRecovery && uncertainWrite) {
      this.pendingQueueRecovery = {
        request: uncertainWrite.request,
        threadId: uncertainWrite.threadId,
        message: uncertainWrite.message,
        originalMessages: uncertainWrite.operation === "add"
          ? uncertainWrite.messages
          : (uncertainWrite.restoreMessages ?? uncertainWrite.messages),
        recoveryOutcome: uncertainWrite.operation === "add" ? "add-pending" : "steer-error",
      };
      this.ensureQueueRecoveryDeadline();
    }
    const persisted = this.persistedQueueMutation &&
      rpcKey(this.persistedQueueMutation.request.id) === activeKey
      ? this.persistedQueueMutation
      : undefined;
    const recovery = this.pendingQueueRecovery &&
      rpcKey(this.pendingQueueRecovery.request.id) === activeKey
      ? this.pendingQueueRecovery
      : undefined;
    const confirmation = this.pendingQueueConfirmation &&
      rpcKey(this.pendingQueueConfirmation.request.id) === activeKey
      ? this.pendingQueueConfirmation
      : undefined;
    const preserveMutation = (
      this.activeQueueMutation?.operation === "steer" &&
      Boolean(persisted || recovery || confirmation)
    ) || recovery?.recoveryOutcome === "add-pending";
    const requests = [
      ...[...this.pendingQueueReads.values()].map((pending) => pending.request),
      ...[...this.pendingQueueWrites.values()].map((pending) => pending.request),
      ...(!preserveMutation && activeRequest ? [activeRequest] : []),
      ...this.queuedQueueMutations.map((pending) => pending.request),
    ];
    this.pendingQueueReads.clear();
    this.pendingQueueWrites.clear();
    this.pendingQueueConfirmationRequests.clear();
    this.pendingQueuePromotions.clear();
    this.queuedQueueMutations = [];
    if (persisted?.operation === "add" && activeRequest) {
      this.onMessage?.({
        id: activeRequest.id,
        result: { message: outboundQueueMessage(persisted.message), pendingConfirmation: true },
      });
      this.clearQueueRequestState(activeRequest);
      this.activeQueueMutation = undefined;
    } else if (!preserveMutation) {
      if (activeRequest) this.clearQueueRequestState(activeRequest);
      this.activeQueueMutation = undefined;
    }
    const failed = new Set<string>();
    for (const request of requests) {
      const key = rpcKey(request.id);
      if (preserveMutation && key === activeKey) continue;
      if (persisted?.operation === "add" && key === activeKey) continue;
      if (failed.has(key)) continue;
      failed.add(key);
      this.onMessage?.({
        id: request.id,
        error: { code: -32005, message: "Desktop queue operation interrupted by disconnect" },
      });
    }
  }

  private markConnected() {
    this.clearAppServerDisconnectVerification();
    if (this.bridgeState !== "read-only" || !this.capabilities.compatible) return;
    this.clearAppServerProbe();
    this.bridgeState = "live";
    this.onDiagnostic?.({ category: "protocol", message: "Desktop bridge reconnected" });
    if (this.pendingQueueConfirmation) this.resumePendingQueueConfirmation();
    else this.resumePendingQueueRecovery();
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
    if (this.pendingQueueConfirmation) this.resumePendingQueueConfirmation();
    else this.resumePendingQueueRecovery();
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

function isInactiveQueueSteerError(cause: unknown) {
  const record = asRecord(cause);
  const message = cause instanceof Error
    ? cause.message
    : typeof record.message === "string" ? record.message : String(cause);
  return message.includes("no active turn to steer") ||
    message.includes("turn is not active") ||
    message.includes("turn already completed");
}

function queuedMessageInput(message: Record<string, unknown>): Array<Record<string, unknown>> {
  const text = typeof message.text === "string" ? message.text : "";
  const context = asRecord(message.context);
  const images = Array.isArray(context.imageAttachments)
    ? context.imageAttachments.flatMap((attachment) => {
        const record = asRecord(attachment);
        return typeof record.src === "string"
          ? [{ type: "localImage", path: record.src }]
          : [];
      })
    : [];
  return [
    ...(text ? [{ type: "text", text }] : []),
    ...images,
  ];
}

function outboundQueueMessage(message: Record<string, unknown>): Record<string, unknown> {
  const context = asRecord(message.context);
  const imageIds = Array.isArray(context.imageAttachments)
    ? context.imageAttachments.flatMap((attachment) => {
        const source = asRecord(attachment).src;
        if (typeof source !== "string") return [];
        const match = basename(source).match(
          /^([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\.(?:png|jpg|gif|webp)$/i,
        );
        return match ? [match[1]] : [];
      })
    : [];
  return {
    id: message.id,
    text: message.text,
    ...(typeof message.createdAt === "number" ? { createdAt: message.createdAt } : {}),
    ...(typeof message.cwd === "string" ? { cwd: message.cwd } : {}),
    ...(imageIds.length > 0 ? { imageIds: [...new Set(imageIds)] } : {}),
  };
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

function isRecordValue(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> {
  return isRecordValue(value) ? value : {};
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

function inspectQueueConfirmation(
  value: unknown,
  query: PendingQueueConfirmation["query"],
  threadId: string,
  messageId: string,
): {
  status: "accepted" | "absent" | "fallback" | "invalid";
  nextCursor?: string;
} {
  const result = asRecord(value);
  let turns: unknown[];
  let nextCursor: string | undefined;
  if (query === "thread/read") {
    const thread = asRecord(result.thread);
    if (thread.id !== threadId) return { status: "invalid" };
    if (thread.historyMode === "paginated") return { status: "fallback" };
    if (!Array.isArray(thread.turns)) return { status: "invalid" };
    turns = thread.turns;
  } else {
    if (!Array.isArray(result.data)) return { status: "invalid" };
    if (
      result.nextCursor !== undefined &&
      result.nextCursor !== null &&
      typeof result.nextCursor !== "string"
    ) return { status: "invalid" };
    nextCursor = typeof result.nextCursor === "string" && result.nextCursor
      ? result.nextCursor
      : undefined;
    turns = result.data;
  }

  for (const turnValue of turns) {
    const turn = asRecord(turnValue);
    if (!Array.isArray(turn.items)) return { status: "invalid" };
    for (const itemValue of turn.items) {
      const item = asRecord(itemValue);
      if (Object.keys(item).length === 0) return { status: "invalid" };
      if (item.type !== "userMessage") continue;
      if (
        item.clientId === messageId ||
        item.clientMessageId === messageId ||
        item.clientUserMessageId === messageId ||
        item.client_message_id === messageId ||
        item.client_user_message_id === messageId
      ) return { status: "accepted" };
    }
  }
  return { status: "absent", nextCursor };
}

function mergeRestoredQueueMessage(
  currentMessages: Record<string, unknown>[],
  originalMessages: Record<string, unknown>[],
  message: Record<string, unknown>,
) {
  const messageId = typeof message.id === "string" ? message.id : undefined;
  if (messageId && currentMessages.some((item) => item.id === messageId)) return currentMessages;
  const originalIndex = messageId
    ? originalMessages.findIndex((item) => item.id === messageId)
    : -1;
  if (originalIndex < 0) return [...currentMessages, message];

  for (const successor of originalMessages.slice(originalIndex + 1)) {
    const successorIndex = currentMessages.findIndex((item) => item.id === successor.id);
    if (successorIndex >= 0) {
      return [
        ...currentMessages.slice(0, successorIndex),
        message,
        ...currentMessages.slice(successorIndex),
      ];
    }
  }
  for (const predecessor of originalMessages.slice(0, originalIndex).reverse()) {
    const predecessorIndex = currentMessages.findIndex((item) => item.id === predecessor.id);
    if (predecessorIndex >= 0) {
      return [
        ...currentMessages.slice(0, predecessorIndex + 1),
        message,
        ...currentMessages.slice(predecessorIndex + 1),
      ];
    }
  }
  return [...currentMessages, message];
}

function rpcKey(id: string | number) {
  return `${typeof id}:${String(id)}`;
}
