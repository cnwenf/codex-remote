import { createReadStream, existsSync, statSync } from "node:fs";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, resolve, sep } from "node:path";
import type { Duplex } from "node:stream";
import WebSocket, { WebSocketServer, type RawData } from "ws";
import { RpcRouter } from "../protocol/rpc-router";
import {
  isRpcRequest,
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

type GatewayOptions = {
  host?: string;
  additionalHosts?: string[];
  port?: number;
  token: string;
  allowedOrigins?: string[];
  staticDir?: string;
  defaultCwd?: string;
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
  let allowedOrigins = new Set(options.allowedOrigins ?? []);
  let initializeResolve: (() => void) | undefined;
  let initializeReject: ((error: Error) => void) | undefined;

  const handleHttpRequest = (request: IncomingMessage, response: ServerResponse) => {
    setSecurityHeaders(response);
    const pathname = new URL(request.url ?? "/", "http://gateway.local").pathname;
    if (pathname === "/health") {
      response.writeHead(200, { "content-type": "application/json; charset=utf-8" });
      response.end('{"ok":true}');
      return;
    }
    if (pathname === "/auth/session") {
      void handleSessionRequest(request, response);
      return;
    }
    serveStatic(request, response, options.staticDir);
  };
  const httpServer = createServer(handleHttpRequest);
  const additionalHttpServers: ReturnType<typeof createServer>[] = [];

  const websocketServer = new WebSocketServer({
    noServer: true,
    maxPayload: MAX_FRAME_BYTES,
    handleProtocols(protocols) {
      return protocols.has("codex-local") ? "codex-local" : false;
    },
  });

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
    if (!isAllowedOrigin(request.headers.origin, allowedOrigins)) {
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
        const routed = router.fromBrowser(clientId, envelope.payload);
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
      if (allowedOrigins.size === 0) {
        allowedOrigins = new Set([
          `http://${host}:${address.port}`,
          ...additionalHosts.map((additionalHost) => `http://${additionalHost}:${address.port}`),
          `http://localhost:${address.port}`,
        ]);
      }
      return address;
    },

    async stop() {
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

  function broadcastEnvelope(envelope: GatewayEnvelope) {
    for (const controller of controllers.values()) sendEnvelope(controller, envelope);
  }

  async function handleSessionRequest(request: IncomingMessage, response: ServerResponse) {
    response.setHeader("Cache-Control", "no-store");
    if (request.method !== "POST") {
      response.writeHead(405, { Allow: "POST" }).end();
      return;
    }
    if (!isAllowedOrigin(request.headers.origin, allowedOrigins)) {
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
  response.setHeader("Content-Security-Policy", "default-src 'self'; connect-src 'self' ws: wss:; img-src 'self' data:; style-src 'self'; script-src 'self'; base-uri 'none'; frame-ancestors 'none'");
  response.setHeader("Referrer-Policy", "no-referrer");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
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
  response.writeHead(200, { "content-type": contentType(file) });
  createReadStream(file).pipe(response);
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
