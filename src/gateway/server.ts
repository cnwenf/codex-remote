import { createHash } from "node:crypto";
import { createReadStream, existsSync, readFileSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { extname, join, resolve, sep } from "node:path";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { RpcRouter } from "../protocol/rpc-router";
import {
  isRpcRequest,
  isRpcResponse,
  type CodexTransport,
  type GatewayEnvelope,
  type RpcMessage,
} from "../protocol/types";
import {
  createSessionCredential,
  decodeTokenProtocol,
  isAllowedOrigin,
  isAuthorized,
  readCookie,
  SESSION_COOKIE_NAME,
} from "./auth";
import {
  ImageUploadError,
  ImageUploadStore,
  MAX_IMAGE_BYTES,
} from "./image-upload-store";
import { projectMobileStatus } from "./mobile-status";
import { PairingStore } from "./pairing-store";

const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_AUTH_BODY_BYTES = 4 * 1024;
const SESSION_MAX_AGE_SECONDS = 30 * 24 * 60 * 60;
const INITIALIZE_ID = "gateway-initialize";
const KNOWN_SERVER_REQUESTS = new Set([
  "item/commandExecution/requestApproval",
  "item/fileChange/requestApproval",
  "item/permissions/requestApproval",
  "item/tool/requestUserInput",
]);
const MOBILE_STATUS_RATE_WINDOW_MS = 60_000;
const MOBILE_STATUS_RATE_LIMIT = 120;
const DEFAULT_MOBILE_STATUS_SYNC_INTERVAL_MS = 5_000;
const MOBILE_STATUS_SYNC_TIMEOUT_MS = 3_000;
const LIVE_EVENT_GRACE_MS = 20_000;
const NATIVE_WEBVIEW_ORIGINS = new Set([
  "capacitor://localhost",
  "http://localhost",
  "https://localhost",
]);

type GatewayOptions = {
  host?: string;
  additionalHosts?: string[];
  port?: number;
  token: string;
  allowedOrigins?: string[];
  allowTryCloudflareOrigin?: boolean;
  staticDir?: string;
  uploadDir?: string;
  defaultCwd?: string;
  heartbeatIntervalMs?: number;
  mobileStatusSyncIntervalMs?: number;
  transport: CodexTransport;
  desktopState?: {
    request(method: string, params: unknown): unknown;
    close(): void;
  };
};

export function createGateway(options: GatewayOptions) {
  if (!options.token) throw new Error("gateway-token-required");

  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 4321;
  const router = new RpcRouter();
  const controllers = new Map<string, WebSocket>();
  let nextControllerId = 1;
  const sessionCredential = createSessionCredential(options.token);
  const appVersion = staticAppVersion(options.staticDir);
  const imageStore = new ImageUploadStore(
    options.uploadDir ?? join(homedir(), ".codex", "codex-remote", "uploads"),
  );
  const mobileStatusRate = new Map<string, { startedAt: number; count: number }>();
  const liveThreadActivity = new Map<string, {
    status: "running" | "idle" | "error";
    turnId?: string;
    source: "event" | "sync";
    updatedAt: number;
  }>();
  const pendingInternalRequests = new Map<string, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
    timeout: ReturnType<typeof setTimeout>;
  }>();
  let nextInternalRequestId = 1;
  let mobileStatusSyncTimer: ReturnType<typeof setInterval> | undefined;
  const pairingStore = new PairingStore();
  let allowedOrigins = new Set([
    ...(options.allowedOrigins ?? []),
    ...NATIVE_WEBVIEW_ORIGINS,
  ]);
  let initializeResolve: (() => void) | undefined;
  let initializeReject: ((error: Error) => void) | undefined;

  const handleHttpRequest = (request: IncomingMessage, response: ServerResponse) => {
    setSecurityHeaders(response);
    const pathname = new URL(request.url ?? "/", "http://gateway.local").pathname;
    if (isMobileApiPath(pathname) && applyNativeCors(request, response)) return;
    if (pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end('{"ok":true}');
      return;
    }
    if (pathname === "/app-version") {
      response.writeHead(200, {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      });
      response.end(JSON.stringify({ version: appVersion }));
      return;
    }
    if (pathname === "/auth/session") {
      void handleSessionRequest(request, response);
      return;
    }
    if (pathname === "/api/mobile/status") {
      void handleMobileStatus(request, response);
      return;
    }
    if (pathname === "/api/mobile/pairing") {
      void handlePairingCreate(request, response);
      return;
    }
    if (pathname === "/api/mobile/pair") {
      void handlePairingExchange(request, response);
      return;
    }
    if (pathname === "/api/images") {
      void handleImageUpload(request, response);
      return;
    }
    const imageMatch = pathname.match(/^\/api\/images\/([0-9a-f-]+)$/i);
    if (imageMatch) {
      void handleImageDownload(request, response, imageMatch[1]);
      return;
    }
    serveStatic(request, response, options.staticDir);
  };

  function applyNativeCors(request: IncomingMessage, response: ServerResponse) {
    const origin = request.headers.origin;
    if (!origin || !NATIVE_WEBVIEW_ORIGINS.has(origin)) return false;
    response.setHeader("Access-Control-Allow-Origin", origin);
    response.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    response.setHeader("Access-Control-Allow-Headers", "Authorization, Content-Type, X-File-Name");
    response.setHeader("Vary", "Origin");
    if (request.method !== "OPTIONS") return false;
    response.writeHead(204).end();
    return true;
  }
  const httpServer = createServer(handleHttpRequest);
  const additionalHttpServers: ReturnType<typeof createServer>[] = [];

  const websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
    handleProtocols(protocols) {
      return protocols.has("codex-local") ? "codex-local" : false;
    },
  });
  const controllerAlive = new WeakMap<WebSocket, boolean>();
  const heartbeatIntervalMs = options.heartbeatIntervalMs ?? 20_000;
  const heartbeatTimer = setInterval(() => {
    for (const controller of controllers.values()) {
      if (controllerAlive.get(controller) === false) {
        controller.terminate();
        continue;
      }
      controllerAlive.set(controller, false);
      controller.ping();
    }
  }, heartbeatIntervalMs);
  heartbeatTimer.unref();

  const handleUpgrade = (request: IncomingMessage, socket: Duplex, head: Buffer) => {
    if (new URL(request.url ?? "/", "http://gateway.local").pathname !== "/rpc") {
      rejectUpgrade(socket, 404, "Not Found");
      return;
    }

    const protocols = new Set(
      (request.headers["sec-websocket-protocol"] ?? "")
        .split(",")
        .map((value) => value.trim())
        .filter(Boolean),
    );
    const providedToken = decodeTokenProtocol(protocols);
    const providedSession = readCookie(request.headers.cookie, SESSION_COOKIE_NAME);
    const authorized =
      (providedToken !== undefined && isAuthorized(providedToken, options.token)) ||
      (providedSession !== undefined && isAuthorized(providedSession, sessionCredential));
    if (!authorized) {
      rejectUpgrade(socket, 401, "Unauthorized");
      return;
    }
    if (!isConfiguredOrigin(request.headers.origin)) {
      rejectUpgrade(socket, 403, "Forbidden");
      return;
    }
    websocketServer.handleUpgrade(request, socket, head, (websocket) => {
      websocketServer.emit("connection", websocket, request);
    });
  };
  httpServer.on("upgrade", handleUpgrade);

  websocketServer.on("connection", (socket) => {
    const clientId = `controller-${nextControllerId++}`;
    controllers.set(clientId, socket);
    controllerAlive.set(socket, true);
    socket.on("pong", () => controllerAlive.set(socket, true));
    setImmediate(() => sendEnvelope(socket, {
      type: "session",
      state: "ready",
      ...(options.defaultCwd ? { defaultCwd: options.defaultCwd } : {}),
      ...options.transport.getSessionInfo?.(),
    }));

    socket.on("message", (data, isBinary) => {
      if (isBinary || rawDataLength(data) > MAX_FRAME_BYTES) {
        socket.close(1008, "invalid-message");
        return;
      }
      try {
        const envelope = JSON.parse(rawDataToBuffer(data).toString("utf8")) as unknown;
        if (!isRpcEnvelope(envelope)) throw new Error("invalid-envelope");
        if (isRpcRequest(envelope.payload) && envelope.payload.method.startsWith("desktopState/")) {
          void handleDesktopStateRequest(socket, envelope.payload);
          return;
        }
        let browserMessage: RpcMessage;
        try {
          browserMessage = resolveRemoteImages(envelope.payload, imageStore);
        } catch (cause) {
          if (isRpcRequest(envelope.payload)) {
            sendEnvelope(socket, {
              type: "rpc",
              payload: {
                id: envelope.payload.id,
                error: {
                  code: -32602,
                  message: cause instanceof Error ? cause.message : "Invalid image attachment",
                },
              },
            });
            return;
          }
          throw cause;
        }
        const routed = router.fromBrowser(clientId, browserMessage);
        if (!routed) return;
        try {
          options.transport.send(routed);
        } catch (cause) {
          if (!isRpcRequest(routed)) throw cause;
          const response = router.fromServer({
            id: routed.id,
            error: transportRpcError(cause),
          });
          if (!("message" in response)) throw cause;
          const target = controllers.get(response.clientId);
          if (target) sendEnvelope(target, { type: "rpc", payload: response.message });
        }
      } catch {
        sendEnvelope(socket, {
          type: "session",
          state: "disconnected",
          message: "Invalid RPC message",
        });
      }
    });

    socket.once("close", () => {
      controllers.delete(clientId);
      router.dropClient(clientId);
    });
  });

  return {
    async start(): Promise<AddressInfo> {
      await options.transport.start(
        (message) => routeTransportMessage(message),
        (diagnostic) => {
          if (controllers.size === 0) return;
          broadcastEnvelope({
            type: "diagnostic",
            category: diagnostic.category,
            message: diagnostic.message,
          });
          const sessionInfo = options.transport.getSessionInfo?.();
          if (sessionInfo) {
            broadcastEnvelope({
              type: "session",
              state: "ready",
              ...(options.defaultCwd ? { defaultCwd: options.defaultCwd } : {}),
              ...sessionInfo,
            });
          }
        },
      );

      if (options.transport.requiresInitialize !== false) {
        try {
          await initializeTransport();
        } catch (error) {
          await options.transport.stop();
          throw error;
        }
      }
      void refreshLiveThreadActivity();
      mobileStatusSyncTimer = setInterval(
        () => { void refreshLiveThreadActivity(); },
        options.mobileStatusSyncIntervalMs ?? DEFAULT_MOBILE_STATUS_SYNC_INTERVAL_MS,
      );
      mobileStatusSyncTimer.unref();

      await new Promise<void>((resolveListen, rejectListen) => {
        httpServer.once("error", rejectListen);
        httpServer.listen(port, host, () => {
          httpServer.off("error", rejectListen);
          resolveListen();
        });
      });
      const address = httpServer.address();
      if (!address || typeof address === "string") throw new Error("invalid-listen-address");
      const additionalHosts = [...new Set(options.additionalHosts ?? [])].filter(
        (additionalHost) => additionalHost !== host,
      );
      try {
        for (const additionalHost of additionalHosts) {
          const additionalServer = createServer(handleHttpRequest);
          additionalServer.on("upgrade", handleUpgrade);
          await listen(additionalServer, address.port, additionalHost);
          additionalHttpServers.push(additionalServer);
        }
      } catch (error) {
        await closeHttpServers([httpServer, ...additionalHttpServers]);
        await options.transport.stop();
        throw error;
      }
      if (!options.allowedOrigins || options.allowedOrigins.length === 0) {
        allowedOrigins = new Set([
          ...allowedOrigins,
          `http://${host}:${address.port}`,
          ...additionalHosts.map((additionalHost) => `http://${additionalHost}:${address.port}`),
          `http://localhost:${address.port}`,
        ]);
      }
      return address;
    },

    async stop() {
      clearInterval(heartbeatTimer);
      if (mobileStatusSyncTimer) clearInterval(mobileStatusSyncTimer);
      for (const pending of pendingInternalRequests.values()) {
        clearTimeout(pending.timeout);
        pending.reject(new Error("gateway-stopping"));
      }
      pendingInternalRequests.clear();
      for (const controller of controllers.values()) {
        controller.close(1001, "gateway-stopping");
      }
      controllers.clear();
      await new Promise<void>((resolveClose) => {
        websocketServer.close(() => resolveClose());
      });
      await closeHttpServers([httpServer, ...additionalHttpServers]);
      await options.transport.stop();
      options.desktopState?.close();
    },
  };

  function routeTransportMessage(message: RpcMessage) {
    if ("id" in message && !("method" in message) && message.id === INITIALIZE_ID) {
      if (message.error) initializeReject?.(new Error("app-server-initialize-failed"));
      else initializeResolve?.();
      initializeResolve = undefined;
      initializeReject = undefined;
      return;
    }
    if (isRpcResponse(message) && typeof message.id === "string") {
      const pending = pendingInternalRequests.get(message.id);
      if (pending) {
        pendingInternalRequests.delete(message.id);
        clearTimeout(pending.timeout);
        if (message.error) pending.reject(new Error(message.error.message));
        else pending.resolve(message.result);
        return;
      }
    }
    updateLiveThreadActivity(message);
    if (isRpcRequest(message) && !KNOWN_SERVER_REQUESTS.has(message.method)) {
      options.transport.send({
        id: message.id,
        error: { code: -32601, message: "Unsupported server request" },
      });
      return;
    }
    if (controllers.size === 0) return;
    try {
      const route = router.fromServer(message);
      if ("clientId" in route) {
        const target = controllers.get(route.clientId);
        if (target) sendEnvelope(target, { type: "rpc", payload: route.message });
        return;
      }
      broadcastEnvelope({ type: "rpc", payload: route.broadcast });
    } catch {
      broadcastEnvelope({
        type: "diagnostic",
        category: "protocol",
        message: "Ignored an unmapped App Server response",
      });
    }
  }

  function updateLiveThreadActivity(message: RpcMessage) {
    if (!("method" in message)) return;
    const params = recordValue(message.params);
    const threadId = optionalString(params.threadId);
    if (!threadId) return;
    if (message.method === "turn/started") {
      const turn = recordValue(params.turn);
      liveThreadActivity.set(threadId, {
        status: "running",
        turnId: optionalString(turn.id) ?? optionalString(params.turnId),
        source: "event",
        updatedAt: Date.now(),
      });
      return;
    }
    if (message.method === "turn/completed") {
      const turn = recordValue(params.turn);
      const completedTurnId = optionalString(turn.id) ?? optionalString(params.turnId);
      const active = liveThreadActivity.get(threadId);
      if (!active?.turnId || !completedTurnId || active.turnId === completedTurnId) {
        liveThreadActivity.set(threadId, {
          status: optionalString(turn.status) === "failed" ? "error" : "idle",
          source: "event",
          updatedAt: Date.now(),
        });
      }
      return;
    }
    if (message.method !== "thread/status/changed") return;
    const rawStatus = params.status;
    const status = typeof rawStatus === "string"
      ? rawStatus
      : optionalString(recordValue(rawStatus).type);
    if (status === "active" || status === "running") {
      liveThreadActivity.set(threadId, {
        status: "running",
        turnId: liveThreadActivity.get(threadId)?.turnId,
        source: "event",
        updatedAt: Date.now(),
      });
    } else if (status === "error" || status === "failed" || status === "systemError") {
      liveThreadActivity.set(threadId, { status: "error", source: "event", updatedAt: Date.now() });
    } else if (status === "idle" || status === "completed" || status === "notLoaded") {
      liveThreadActivity.set(threadId, { status: "idle", source: "event", updatedAt: Date.now() });
    }
  }

  async function refreshLiveThreadActivity() {
    try {
      const value = await requestTransport("thread/list", { limit: 100, sortKey: "updated_at" });
      const now = Date.now();
      for (const thread of projectMobileStatus(value, now).threads) {
        if (thread.status === "unknown") continue;
        const current = liveThreadActivity.get(thread.id);
        if (
          current?.source === "event" &&
          current.status !== thread.status &&
          now - current.updatedAt < LIVE_EVENT_GRACE_MS
        ) continue;
        liveThreadActivity.set(thread.id, {
          status: thread.status,
          source: "sync",
          updatedAt: now,
        });
      }
    } catch {
      // The Desktop bridge can briefly be unavailable; the next interval retries.
    }
  }

  function requestTransport(method: string, params: unknown) {
    return new Promise<unknown>((resolveRequest, rejectRequest) => {
      const id = `gateway-internal-${nextInternalRequestId++}`;
      const timeout = setTimeout(() => {
        pendingInternalRequests.delete(id);
        rejectRequest(new Error("gateway-internal-request-timeout"));
      }, MOBILE_STATUS_SYNC_TIMEOUT_MS);
      timeout.unref();
      pendingInternalRequests.set(id, { resolve: resolveRequest, reject: rejectRequest, timeout });
      try {
        options.transport.send({ id, method, params });
      } catch (cause) {
        pendingInternalRequests.delete(id);
        clearTimeout(timeout);
        rejectRequest(cause instanceof Error ? cause : new Error("gateway-internal-request-failed"));
      }
    });
  }

  function broadcastEnvelope(envelope: GatewayEnvelope) {
    for (const controller of controllers.values()) sendEnvelope(controller, envelope);
  }

  async function handleSessionRequest(request: IncomingMessage, response: ServerResponse) {
    response.setHeader("Cache-Control", "no-store");
    if (request.method !== "POST") {
      response.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    if (!isConfiguredOrigin(request.headers.origin)) {
      response.writeHead(403).end();
      return;
    }
    if (!request.headers["content-type"]?.toLowerCase().startsWith("application/json")) {
      response.writeHead(415).end();
      return;
    }
    try {
      const body = await readJsonBody(request);
      const token = typeof body.token === "string" ? body.token : undefined;
      if (!token || !isAuthorized(token, options.token)) {
        response.writeHead(401).end();
        return;
      }
      response.setHeader("Set-Cookie", [
        `${SESSION_COOKIE_NAME}=${sessionCredential}`,
        "Path=/",
        `Max-Age=${SESSION_MAX_AGE_SECONDS}`,
        "HttpOnly",
        "SameSite=Strict",
      ].join("; "));
      response.writeHead(204).end();
    } catch (cause) {
      response.writeHead(cause instanceof AuthBodyTooLargeError ? 413 : 400).end();
    }
  }

  async function handleImageUpload(request: IncomingMessage, response: ServerResponse) {
    response.setHeader("Cache-Control", "no-store");
    if (request.method !== "POST") {
      response.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    if (request.headers.origin && !isConfiguredOrigin(request.headers.origin)) {
      response.writeHead(403).end();
      return;
    }
    const providedSession = readCookie(request.headers.cookie, SESSION_COOKIE_NAME);
    const providedBearer = singleHeader(request.headers.authorization)?.match(/^Bearer ([^\s]+)$/i)?.[1];
    if (
      !(providedSession && isAuthorized(providedSession, sessionCredential)) &&
      !(providedBearer && isAuthorized(providedBearer, options.token))
    ) {
      response.writeHead(401).end();
      return;
    }
    const mimeType = request.headers["content-type"]?.split(";", 1)[0]?.trim().toLowerCase();
    if (!mimeType?.startsWith("image/")) {
      response.writeHead(415).end();
      return;
    }
    try {
      const body = await readRawBody(request, MAX_IMAGE_BYTES);
      const originalName = singleHeader(request.headers["x-file-name"]);
      const stored = await imageStore.save(body, mimeType, originalName);
      response.writeHead(201, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify({
        id: stored.id,
        name: stored.name,
        mimeType: stored.mimeType,
        size: stored.size,
      }));
    } catch (cause) {
      const status = cause instanceof ImageUploadError ? cause.status : 400;
      response.writeHead(status).end();
    }
  }

  function isConfiguredOrigin(origin: string | undefined) {
    if (isAllowedOrigin(origin, allowedOrigins)) return true;
    if (!options.allowTryCloudflareOrigin || !origin) return false;
    try {
      const url = new URL(origin);
      return url.protocol === "https:" && url.port === "" &&
        /^[a-z0-9-]+\.trycloudflare\.com$/.test(url.hostname);
    } catch {
      return false;
    }
  }

  async function handleMobileStatus(request: IncomingMessage, response: ServerResponse) {
    response.setHeader("Cache-Control", "no-store");
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET" }).end();
      return;
    }
    const authorization = singleHeader(request.headers.authorization);
    const bearer = authorization?.match(/^Bearer ([^\s]+)$/i)?.[1];
    const session = readCookie(request.headers.cookie, SESSION_COOKIE_NAME);
    const authorized =
      (bearer !== undefined && isAuthorized(bearer, options.token)) ||
      (session !== undefined && isAuthorized(session, sessionCredential));
    if (!authorized) {
      response.writeHead(401).end();
      return;
    }
    const remoteAddress = request.socket.remoteAddress ?? "unknown";
    if (!consumeMobileStatusRate(remoteAddress)) {
      response.writeHead(429, { "Retry-After": "60" }).end();
      return;
    }
    if (!options.desktopState) {
      response.writeHead(503).end();
      return;
    }
    try {
      const value = await options.desktopState.request("desktopState/listThreads", {});
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(projectMobileStatus(
        value,
        Date.now(),
        new Map([...liveThreadActivity].map(([threadId, activity]) => [threadId, activity.status])),
      )));
    } catch {
      response.writeHead(503).end();
    }
  }

  async function handlePairingCreate(request: IncomingMessage, response: ServerResponse) {
    response.setHeader("Cache-Control", "no-store");
    if (request.method !== "POST") {
      response.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    if (!isRequestAuthorized(request, options.token, sessionCredential)) {
      response.writeHead(401).end();
      return;
    }
    try {
      const body = await readJsonBody(request);
      const baseUrl = normalizePairingBaseUrl(body.baseUrl);
      const pairing = pairingStore.create(baseUrl, options.token);
      response.writeHead(201, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(pairing));
    } catch {
      response.writeHead(400).end();
    }
  }

  async function handlePairingExchange(request: IncomingMessage, response: ServerResponse) {
    response.setHeader("Cache-Control", "no-store");
    if (request.method !== "POST") {
      response.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    const remoteAddress = request.socket.remoteAddress ?? "unknown";
    if (!consumeMobileStatusRate(`pair:${remoteAddress}`)) {
      response.writeHead(429, { "Retry-After": "60" }).end();
      return;
    }
    try {
      const body = await readJsonBody(request);
      const code = typeof body.code === "string" ? body.code : "";
      const pairing = code.length <= 256 ? pairingStore.consume(code) : undefined;
      if (!pairing) {
        response.writeHead(404).end();
        return;
      }
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end(JSON.stringify(pairing));
    } catch {
      response.writeHead(400).end();
    }
  }

  function consumeMobileStatusRate(remoteAddress: string) {
    const now = Date.now();
    const current = mobileStatusRate.get(remoteAddress);
    if (!current || now - current.startedAt >= MOBILE_STATUS_RATE_WINDOW_MS) {
      mobileStatusRate.set(remoteAddress, { startedAt: now, count: 1 });
      return true;
    }
    current.count += 1;
    return current.count <= MOBILE_STATUS_RATE_LIMIT;
  }

  async function handleImageDownload(
    request: IncomingMessage,
    response: ServerResponse,
    imageId: string,
  ) {
    response.setHeader("Cache-Control", "private, max-age=86400");
    if (request.method !== "GET") {
      response.writeHead(405, { Allow: "GET" }).end();
      return;
    }
    const providedSession = readCookie(request.headers.cookie, SESSION_COOKIE_NAME);
    const providedBearer = singleHeader(request.headers.authorization)?.match(/^Bearer ([^\s]+)$/i)?.[1];
    if (
      !(providedSession && isAuthorized(providedSession, sessionCredential)) &&
      !(providedBearer && isAuthorized(providedBearer, options.token))
    ) {
      response.writeHead(401).end();
      return;
    }
    try {
      const image = await imageStore.open(imageId);
      response.writeHead(200, {
        "content-type": image.mimeType,
        "content-length": String(image.size),
      });
      createReadStream(image.path).pipe(response);
    } catch (cause) {
      const status = cause instanceof ImageUploadError ? cause.status : 404;
      response.writeHead(status).end();
    }
  }

  function initializeTransport() {
    return new Promise<void>((resolveInitialize, rejectInitialize) => {
      const timeout = setTimeout(() => {
        initializeResolve = undefined;
        initializeReject = undefined;
        rejectInitialize(new Error("app-server-initialize-timeout"));
      }, 10_000);
      initializeResolve = () => {
        clearTimeout(timeout);
        resolveInitialize();
      };
      initializeReject = (error) => {
        clearTimeout(timeout);
        rejectInitialize(error);
      };
      options.transport.send({
        id: INITIALIZE_ID,
        method: "initialize",
        params: {
          clientInfo: {
            name: "codex-remote",
            title: "Codex Remote",
            version: "0.1.0",
          },
          capabilities: { experimentalApi: true },
        },
      });
    });
  }

  async function handleDesktopStateRequest(socket: WebSocket, request: import("../protocol/types").RpcRequest) {
    try {
      if (!options.desktopState) throw new Error("Desktop state is unavailable");
      const result = await options.desktopState.request(request.method, request.params);
      sendEnvelope(socket, { type: "rpc", payload: { id: request.id, result } });
    } catch (cause) {
      sendEnvelope(socket, {
        type: "rpc",
        payload: {
          id: request.id,
          error: { code: -32001, message: cause instanceof Error ? cause.message : "Desktop state failed" },
        },
      });
    }
  }
}

function listen(
  server: ReturnType<typeof createServer>,
  port: number,
  host: string,
) {
  return new Promise<void>((resolveListen, rejectListen) => {
    server.once("error", rejectListen);
    server.listen(port, host, () => {
      server.off("error", rejectListen);
      resolveListen();
    });
  });
}

function closeHttpServers(servers: ReturnType<typeof createServer>[]) {
  return Promise.all(
    servers.map(
      (server) =>
        new Promise<void>((resolveClose, rejectClose) => {
          if (!server.listening) {
            resolveClose();
            return;
          }
          server.close((error) => (error ? rejectClose(error) : resolveClose()));
        }),
    ),
  ).then(() => undefined);
}

function isRpcEnvelope(value: unknown): value is { type: "rpc"; payload: RpcMessage } {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  if (record.type !== "rpc" || !record.payload || typeof record.payload !== "object") {
    return false;
  }
  const payload = record.payload as Record<string, unknown>;
  const hasId = Object.prototype.hasOwnProperty.call(payload, "id");
  if (hasId && typeof payload.id !== "number" && typeof payload.id !== "string") {
    return false;
  }
  if ("method" in payload && typeof payload.method !== "string") return false;
  return "method" in payload || hasId;
}

function sendEnvelope(socket: WebSocket, envelope: GatewayEnvelope) {
  if (socket.readyState === WebSocket.OPEN) socket.send(JSON.stringify(envelope));
}

function rejectUpgrade(socket: Duplex, status: number, reason: string) {
  socket.end(
    `HTTP/1.1 ${status} ${reason}\r\nConnection: close\r\nContent-Length: 0\r\n\r\n`,
  );
}

function rawDataLength(data: RawData) {
  if (Array.isArray(data)) return data.reduce((total, part) => total + part.byteLength, 0);
  return data.byteLength;
}

function rawDataToBuffer(data: RawData) {
  if (Array.isArray(data)) return Buffer.concat(data);
  if (data instanceof ArrayBuffer) return Buffer.from(data);
  return Buffer.from(data.buffer, data.byteOffset, data.byteLength);
}

function setSecurityHeaders(response: ServerResponse) {
  response.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data: blob:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
}

function isMobileApiPath(pathname: string) {
  return pathname === "/api/mobile/status" ||
    pathname === "/api/mobile/pairing" ||
    pathname === "/api/mobile/pair" ||
    pathname === "/api/images" ||
    /^\/api\/images\/[0-9a-f-]+$/i.test(pathname);
}

function isRequestAuthorized(request: IncomingMessage, token: string, sessionCredential: string) {
  const bearer = singleHeader(request.headers.authorization)?.match(/^Bearer ([^\s]+)$/i)?.[1];
  const session = readCookie(request.headers.cookie, SESSION_COOKIE_NAME);
  return (bearer !== undefined && isAuthorized(bearer, token)) ||
    (session !== undefined && isAuthorized(session, sessionCredential));
}

function normalizePairingBaseUrl(value: unknown) {
  if (typeof value !== "string") throw new Error("pairing-base-url-required");
  const url = new URL(value.trim());
  if (url.username || url.password || url.search || url.hash || url.pathname !== "/") {
    throw new Error("pairing-base-url-invalid");
  }
  if (url.protocol === "https:") return url.origin;
  if (url.protocol !== "http:" || !isPrivatePairingHost(url.hostname)) {
    throw new Error("pairing-base-url-insecure");
  }
  return url.origin;
}

function isPrivatePairingHost(hostname: string) {
  const host = hostname.toLowerCase();
  return host === "localhost" || host.endsWith(".local") ||
    /^\d{1,3}(?:\.\d{1,3}){3}$/.test(host) || host === "[::1]";
}

function serveStatic(
  request: IncomingMessage,
  response: ServerResponse,
  staticDir: string | undefined,
) {
  if (request.method !== "GET" || !staticDir) {
    response.writeHead(404).end();
    return;
  }
  const root = resolve(staticDir);
  const pathname = decodeURIComponent(new URL(request.url ?? "/", "http://gateway.local").pathname);
  const requested = resolve(root, `.${pathname === "/" ? "/index.html" : pathname}`);
  const safePath = requested === root || requested.startsWith(`${root}${sep}`);
  const file = safePath && existsSync(requested) && statSync(requested).isFile()
    ? requested
    : resolve(root, "index.html");
  if (!file.startsWith(`${root}${sep}`) || !existsSync(file)) {
    response.writeHead(404).end();
    return;
  }
  response.writeHead(200, {
    "content-type": contentType(file),
    "cache-control": extname(file) === ".html"
      ? "no-store"
      : "public, max-age=31536000, immutable",
  });
  createReadStream(file).pipe(response);
}

function staticAppVersion(staticDir: string | undefined) {
  if (!staticDir) return "0000000000000000";
  const indexPath = resolve(staticDir, "index.html");
  if (!existsSync(indexPath)) return "0000000000000000";
  return createHash("sha256").update(readFileSync(indexPath)).digest("hex").slice(0, 16);
}

function contentType(path: string) {
  switch (extname(path)) {
    case ".html": return "text/html; charset=utf-8";
    case ".js": return "text/javascript; charset=utf-8";
    case ".css": return "text/css; charset=utf-8";
    case ".svg": return "image/svg+xml";
    default: return "application/octet-stream";
  }
}

class AuthBodyTooLargeError extends Error {}

function readJsonBody(request: IncomingMessage) {
  return new Promise<Record<string, unknown>>((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let size = 0;
    request.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > MAX_AUTH_BODY_BYTES) {
        rejectBody(new AuthBodyTooLargeError());
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.once("error", rejectBody);
    request.once("end", () => {
      if (size > MAX_AUTH_BODY_BYTES) return;
      try {
        const value = JSON.parse(Buffer.concat(chunks).toString("utf8")) as unknown;
        if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error();
        resolveBody(value as Record<string, unknown>);
      } catch {
        rejectBody(new Error("invalid-auth-body"));
      }
    });
  });
}

function readRawBody(request: IncomingMessage, maxBytes: number) {
  const declaredLength = Number.parseInt(request.headers["content-length"] ?? "0", 10);
  if (Number.isFinite(declaredLength) && declaredLength > maxBytes) {
    request.resume();
    return Promise.reject(new ImageUploadError("image-too-large", 413));
  }
  return new Promise<Buffer>((resolveBody, rejectBody) => {
    const chunks: Buffer[] = [];
    let size = 0;
    let rejected = false;
    request.on("data", (chunk: Buffer) => {
      size += chunk.byteLength;
      if (size > maxBytes) {
        rejected = true;
        rejectBody(new ImageUploadError("image-too-large", 413));
        request.resume();
        return;
      }
      chunks.push(chunk);
    });
    request.once("error", rejectBody);
    request.once("end", () => {
      if (!rejected) resolveBody(Buffer.concat(chunks));
    });
  });
}

function singleHeader(value: string | string[] | undefined) {
  return Array.isArray(value) ? value[0] : value;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function optionalString(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

function resolveRemoteImages(message: RpcMessage, store: ImageUploadStore): RpcMessage {
  if (!isRpcRequest(message) || (message.method !== "turn/start" && message.method !== "turn/steer")) {
    return message;
  }
  if (!message.params || typeof message.params !== "object") return message;
  const params = message.params as Record<string, unknown>;
  if (!Array.isArray(params.input)) return message;
  const input = params.input.map((item) => {
    if (!item || typeof item !== "object") return item;
    const record = item as Record<string, unknown>;
    if (record.type !== "remoteImage") return item;
    if (typeof record.id !== "string" || Object.keys(record).some((key) => key !== "type" && key !== "id")) {
      throw new ImageUploadError("image-attachment-invalid", 400);
    }
    return { type: "localImage", path: store.resolve(record.id) };
  });
  return { ...message, params: { ...params, input } };
}

function transportRpcError(cause: unknown) {
  const message = cause instanceof Error ? cause.message : "desktop-transport-failed";
  if (message === "desktop-bridge-read-only") {
    return { code: -32001, message: "Desktop bridge is read-only" };
  }
  if (message === "desktop-method-not-supported") {
    return { code: -32601, message: "Desktop method is not supported" };
  }
  return { code: -32000, message: "Desktop request failed" };
}
