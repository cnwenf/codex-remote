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

export type VisibleDesktopSettings = {
  conversationId?: string;
  permissionLabel?: string;
  modelLabel?: string;
  reasoningEffort?: string;
};

export class DesktopCdpClient {
  private socket?: WebSocket;
  private ownerSocket?: WebSocket;
  private nextId = 1;
  private nextOwnerId = 1;
  private pending = new Map<number, PendingCall>();
  private ownerPending = new Map<number, PendingCall>();
  private onDesktopMessage?: (message: unknown) => void;
  private onDisconnect?: (cause?: Error) => void;
  private windowObjectId?: string;
  private ownerWindowObjectId?: string;
  private endpoint?: URL;
  private stopping = false;
  private disconnectNotified = false;
  private threadOwnerRequestTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: DesktopCdpClientOptions) {}

  async start(
    onDesktopMessage: (message: unknown) => void,
    onDisconnect: (cause?: Error) => void,
  ): Promise<void> {
    if (this.socket) throw new Error("desktop-cdp-already-started");
    const endpoint = parseLoopbackUrl(this.options.endpoint, "desktop-cdp-endpoint");
    this.endpoint = endpoint;
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
    socket.on("close", (code, reason) => this.handleDisconnect(
      socket,
      new Error(`desktop-cdp-closed:${code}:${reason.toString() || "no-reason"}`),
    ));
    socket.on("error", (cause) => this.handleDisconnect(
      socket,
      cause instanceof Error ? cause : new Error("desktop-cdp-error"),
    ));

    try {
      await waitForOpen(socket, this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      await this.call("Runtime.enable");
      try {
        await this.call("Runtime.removeBinding", { name: BINDING_NAME });
      } catch {
        // A fresh renderer has no previous binding to remove.
      }
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

  requestThreadOwner(method: string, params: unknown): Promise<unknown> {
    const request = this.threadOwnerRequestTail.then(
      () => this.performThreadOwnerRequest(method, params),
    );
    this.threadOwnerRequestTail = request.then(() => undefined, () => undefined);
    return request;
  }

  async broadcastQueuedFollowUps(conversationId: string, messages: unknown[]): Promise<void> {
    await this.ensureOwnerConnection();
    if (!this.ownerWindowObjectId) throw new Error("desktop-thread-owner-unavailable");
    const response = await this.callOwner("Runtime.callFunctionOn", {
      objectId: this.ownerWindowObjectId,
      functionDeclaration: `async function(conversationId, messages) {
        return this.__codexRemoteBroadcastQueuedFollowUps(conversationId, messages);
      }`,
      arguments: [{ value: conversationId }, { value: messages }],
      awaitPromise: true,
      returnByValue: true,
    }, 15_000);
    throwRuntimeException(response, "desktop-queue-broadcast-failed");
  }

  async promoteQueuedFollowUp(
    conversationId: string,
    messageId: string,
    text: string,
  ): Promise<boolean> {
    if (!this.windowObjectId) throw new Error("desktop-cdp-not-ready");
    const response = await this.call("Runtime.callFunctionOn", {
      objectId: this.windowObjectId,
      functionDeclaration: `function(conversationId, messageId, text) {
        const root = document.querySelector('button[data-composer-navigation-target="permissions"]') ||
          document.querySelector('[data-codex-composer-root]');
        const fiberKey = root && Object.keys(root).find((key) => key.startsWith('__reactFiber$'));
        let fiber = fiberKey ? root[fiberKey] : null;
        let visibleConversationId = null;
        for (let depth = 0; fiber && depth < 100; depth += 1, fiber = fiber.return) {
          if (typeof fiber.memoizedProps?.conversationId === 'string') {
            visibleConversationId = fiber.memoizedProps.conversationId;
            break;
          }
        }
        if (visibleConversationId !== conversationId) return false;
        const actionPattern = /^(调整方向|引导|Steer|Guide now)$/i;
        const findAction = () => {
          const byId = document.querySelector('[data-message-id="' + CSS.escape(messageId) + '"]');
          const candidates = [];
          if (byId) candidates.push(byId);
          const normalizedText = text.trim();
          if (normalizedText) {
            const walker = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT);
            let node;
            while ((node = walker.nextNode())) {
              if ((node.nodeValue || '').trim() === normalizedText && node.parentElement) {
                candidates.push(node.parentElement);
              }
            }
          }
          for (const candidate of candidates) {
            for (let element = candidate, depth = 0; element && depth < 10; element = element.parentElement, depth += 1) {
              const button = Array.from(element.querySelectorAll('button')).find((value) => {
                const label = (value.innerText || value.getAttribute('aria-label') || '').trim();
                return actionPattern.test(label);
              });
              if (button) return button;
            }
          }
          return null;
        };
        const action = findAction();
        if (!action) return false;
        action.click();
        return true;
      }`,
      arguments: [{ value: conversationId }, { value: messageId }, { value: text }],
      awaitPromise: false,
      returnByValue: true,
    }, 5_000);
    throwRuntimeException(response, "desktop-queue-promotion-failed");
    return asRecord(response.result).value === true;
  }

  async inspectVisibleThreadSettings(): Promise<VisibleDesktopSettings> {
    if (!this.windowObjectId) throw new Error("desktop-cdp-not-ready");
    const response = await this.call("Runtime.callFunctionOn", {
      objectId: this.windowObjectId,
      functionDeclaration: `function() {
        const permission = document.querySelector('button[data-composer-navigation-target="permissions"]');
        const intelligence = document.querySelector('button[data-codex-intelligence-trigger="true"]');
        const root = permission || intelligence || document.querySelector('[data-codex-composer-root]');
        const fiberKey = root && Object.keys(root).find((key) => key.startsWith('__reactFiber$'));
        let fiber = fiberKey ? root[fiberKey] : null;
        let conversationId;
        for (let depth = 0; fiber && depth < 100; depth += 1, fiber = fiber.return) {
          if (typeof fiber.memoizedProps?.conversationId === 'string') {
            conversationId = fiber.memoizedProps.conversationId;
            break;
          }
        }
        const firstLine = (element) => (element?.innerText || '').trim().split(/\\r?\\n/, 1)[0] || undefined;
        return {
          conversationId,
          permissionLabel: firstLine(permission),
          modelLabel: firstLine(intelligence),
          reasoningEffort: intelligence?.getAttribute('data-selected-reasoning-effort') || undefined,
        };
      }`,
      awaitPromise: false,
      returnByValue: true,
    });
    throwRuntimeException(response, "desktop-visible-settings-inspection-failed");
    const value = asRecord(asRecord(response.result).value);
    return {
      conversationId: stringValue(value.conversationId),
      permissionLabel: stringValue(value.permissionLabel),
      modelLabel: stringValue(value.modelLabel),
      reasoningEffort: stringValue(value.reasoningEffort),
    };
  }

  async visibleConversationContainsText(text: string): Promise<boolean> {
    if (!this.windowObjectId) throw new Error("desktop-cdp-not-ready");
    const response = await this.call("Runtime.callFunctionOn", {
      objectId: this.windowObjectId,
      functionDeclaration: "function(text) { return document.body.innerText.includes(text); }",
      arguments: [{ value: text }],
      awaitPromise: false,
      returnByValue: true,
    });
    throwRuntimeException(response, "desktop-visible-text-inspection-failed");
    return asRecord(response.result).value === true;
  }

  private async performThreadOwnerRequest(method: string, params: unknown): Promise<unknown> {
    await this.ensureOwnerConnection();
    if (!this.ownerWindowObjectId) throw new Error("desktop-thread-owner-unavailable");
    const response = await this.callOwner("Runtime.callFunctionOn", {
      objectId: this.ownerWindowObjectId,
      functionDeclaration: `async function(method, params) {
        return this.__codexRemoteRequestThreadOwner(method, params);
      }`,
      arguments: [{ value: method }, { value: params }],
      awaitPromise: true,
      returnByValue: true,
    }, 30_000);
    throwRuntimeException(response, "desktop-thread-owner-request-failed");
    const remoteResult = response.result;
    if (!remoteResult || typeof remoteResult !== "object") {
      throw new Error("desktop-thread-owner-response-invalid");
    }
    const record = remoteResult as Record<string, unknown>;
    if (record.subtype === "error") throw new Error("desktop-thread-owner-request-failed");
    if (method === "thread-follower-update-thread-settings") {
      await this.syncVisibleThreadSettings(params);
    }
    return record.value;
  }

  private async syncVisibleThreadSettings(params: unknown): Promise<void> {
    if (!this.windowObjectId) throw new Error("desktop-cdp-not-ready");
    const response = await this.call("Runtime.callFunctionOn", {
      objectId: this.windowObjectId,
      functionDeclaration: `async function(params) {
        return this.__codexRemoteSyncVisibleThreadSettings(params);
      }`,
      arguments: [{ value: params }],
      awaitPromise: true,
      returnByValue: true,
    }, 15_000);
    throwRuntimeException(response, "desktop-visible-settings-sync-failed");
    const remoteResult = response.result;
    const value = remoteResult && typeof remoteResult === "object"
      ? (remoteResult as Record<string, unknown>).value
      : undefined;
    if (!value || typeof value !== "object") {
      throw new Error("desktop-visible-settings-sync-invalid");
    }
    const result = value as Record<string, unknown>;
    if (result.visible === true && result.synced !== true) {
      const failures = Array.isArray(result.failures)
        ? result.failures.filter((failure): failure is string => typeof failure === "string")
        : [];
      throw new Error(`desktop-visible-settings-sync-failed${failures.length ? `:${failures.join(",")}` : ""}`);
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.windowObjectId = undefined;
    this.ownerWindowObjectId = undefined;
    const socket = this.socket;
    const ownerSocket = this.ownerSocket;
    this.socket = undefined;
    this.ownerSocket = undefined;
    for (const pending of this.pending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("desktop-cdp-stopped"));
    }
    this.pending.clear();
    for (const pending of this.ownerPending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("desktop-cdp-stopped"));
    }
    this.ownerPending.clear();
    await Promise.all([socket, ownerSocket].map((candidate) => closeSocket(candidate)));
  }

  private async discoverTarget(endpoint: URL): Promise<CdpTarget> {
    const targets = await this.discoverTargets(endpoint);
    const target = targets.find(isCodexRenderer);
    if (!target) throw new Error("desktop-cdp-renderer-not-found");
    return target;
  }

  private async discoverTargets(endpoint: URL): Promise<CdpTarget[]> {
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
      return body as CdpTarget[];
    } finally {
      clearTimeout(timeout);
    }
  }

  private async ensureOwnerConnection() {
    if (this.ownerSocket?.readyState === WebSocket.OPEN && this.ownerWindowObjectId) return;
    const endpoint = this.endpoint;
    if (!endpoint) throw new Error("desktop-thread-owner-unavailable");
    const targets = await this.discoverTargets(endpoint);
    // The avatar overlay renderer can be suspended by Electron while the main
    // window remains active. Use a second CDP connection to the main renderer
    // for app-host RPC so owner calls cannot hang behind a frozen overlay.
    const target = targets.find(isCodexRenderer);
    if (!target) throw new Error("desktop-thread-owner-unavailable");
    const websocketUrl = parseLoopbackUrl(
      String(target.webSocketDebuggerUrl),
      "desktop-cdp-owner-websocket",
      ["ws:", "wss:"],
    );
    const socket = new WebSocket(websocketUrl, { maxPayload: 8 * 1024 * 1024 });
    this.ownerSocket = socket;
    socket.on("message", (raw) => this.handleOwnerFrame(raw.toString()));
    socket.on("close", () => this.handleOwnerDisconnect(socket));
    socket.on("error", () => this.handleOwnerDisconnect(socket));
    try {
      await waitForOpen(socket, this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS);
      await this.callOwner("Runtime.enable");
      const installed = await this.callOwner("Runtime.evaluate", {
        expression: ownerHelperExpression(),
        returnByValue: false,
        awaitPromise: false,
      });
      throwRuntimeException(installed, "desktop-cdp-owner-helper-failed");
      const runtimeResult = installed.result;
      const objectId = runtimeResult && typeof runtimeResult === "object"
        ? (runtimeResult as Record<string, unknown>).objectId
        : undefined;
      if (typeof objectId !== "string") throw new Error("desktop-cdp-owner-window-missing");
      this.ownerWindowObjectId = objectId;
    } catch (cause) {
      this.handleOwnerDisconnect(socket);
      socket.terminate();
      throw cause;
    }
  }

  private call(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  ) {
    const socket = this.socket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("desktop-cdp-not-connected"));
    }
    const id = this.nextId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error("desktop-cdp-call-timeout"));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timeout });
      socket.send(JSON.stringify({ id, method, ...(params ? { params } : {}) }));
    });
  }

  private callOwner(
    method: string,
    params?: Record<string, unknown>,
    timeoutMs = this.options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
  ) {
    const socket = this.ownerSocket;
    if (!socket || socket.readyState !== WebSocket.OPEN) {
      return Promise.reject(new Error("desktop-cdp-owner-not-connected"));
    }
    const id = this.nextOwnerId++;
    return new Promise<Record<string, unknown>>((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.ownerPending.delete(id);
        reject(new Error("desktop-cdp-owner-call-timeout"));
      }, timeoutMs);
      this.ownerPending.set(id, { resolve, reject, timeout });
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

  private handleOwnerFrame(raw: string) {
    let frame: CdpResponse;
    try {
      frame = JSON.parse(raw) as CdpResponse;
    } catch {
      return;
    }
    if (!("id" in frame)) return;
    const pending = this.ownerPending.get(frame.id);
    if (!pending) return;
    this.ownerPending.delete(frame.id);
    clearTimeout(pending.timeout);
    if (frame.error) {
      pending.reject(new Error(`desktop-cdp-owner-call-failed:${frame.error.code ?? "unknown"}`));
    } else {
      pending.resolve(frame.result ?? {});
    }
  }

  private handleDisconnect(socket: WebSocket, cause?: Error) {
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
    this.onDisconnect?.(cause);
  }

  private handleOwnerDisconnect(socket: WebSocket) {
    if (this.ownerSocket !== socket) return;
    this.ownerSocket = undefined;
    this.ownerWindowObjectId = undefined;
    for (const pending of this.ownerPending.values()) {
      clearTimeout(pending.timeout);
      pending.reject(new Error("desktop-thread-owner-unavailable"));
    }
    this.ownerPending.clear();
  }
}

function isCodexRenderer(value: unknown): value is CdpTarget {
  if (!value || typeof value !== "object") return false;
  const target = value as CdpTarget;
  if (target.type !== "page" || typeof target.webSocketDebuggerUrl !== "string") {
    return false;
  }
  const url = typeof target.url === "string" ? target.url : "";
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
  if (parsed.protocol !== "app:") return false;
  // Recent Desktop releases title the renderer "ChatGPT" instead of
  // "Codex". The stable discriminator is the main app route itself. Do not
  // attach to auxiliary app:// pages such as the avatar overlay.
  return parsed.hostname === "-" &&
    parsed.pathname === "/index.html" &&
    !parsed.searchParams.has("initialRoute");
}

function isCodexAuxiliaryRenderer(value: unknown): value is CdpTarget {
  if (!value || typeof value !== "object") return false;
  const target = value as CdpTarget;
  if (target.type !== "page" || typeof target.webSocketDebuggerUrl !== "string") return false;
  if (typeof target.url !== "string") return false;
  try {
    const parsed = new URL(target.url);
    return parsed.protocol === "app:" && parsed.searchParams.get("initialRoute") === "/avatar-overlay";
  } catch {
    return false;
  }
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
  const settingsHelper = visibleThreadSettingsHelperExpression();
  const visibleAgentMessageObserver = visibleAgentMessageObserverExpression();
  return `(() => {
    if (window.__codexLocalDesktopListener) {
      window.removeEventListener("message", window.__codexLocalDesktopListener);
    }
    const allowed = new Set(${types});
    window.__codexLocalDesktopListener = (event) => {
      const data = event.data;
      if (data && typeof data === "object" && allowed.has(data.type)) {
        window.${BINDING_NAME}(JSON.stringify(data));
      }
    };
    window.addEventListener("message", window.__codexLocalDesktopListener);
    if (window.__codexLocalDesktopNotificationListener) {
      window.removeEventListener("message", window.__codexLocalDesktopNotificationListener);
    }
    window.__codexLocalDesktopNotificationListener = (event) => {
      const data = event.data;
      if (data && typeof data === "object" && data.type === ${notificationType}) {
        window.${BINDING_NAME}(JSON.stringify(data));
      }
    };
    window.addEventListener("message", window.__codexLocalDesktopNotificationListener);
    ${visibleAgentMessageObserver}
    ${settingsHelper}
    return window;
  })()`;
}

function visibleAgentMessageObserverExpression(): string {
  return `
    if (window.__codexRemoteVisibleAgentMessageObserverVersion !== 1) {
      window.__codexRemoteVisibleAgentMessageObserverVersion = 1;
      window.__codexRemoteVisibleAgentMessageObserver?.disconnect();
      if (window.__codexRemoteVisibleAgentMessageTimer) {
        clearTimeout(window.__codexRemoteVisibleAgentMessageTimer);
      }
      const sentMessages = window.__codexRemoteVisibleAgentMessages instanceof Map
        ? window.__codexRemoteVisibleAgentMessages
        : new Map();
      window.__codexRemoteVisibleAgentMessages = sentMessages;
      const closestAttribute = (element, name) => {
        for (let current = element, depth = 0; current && depth < 16; current = current.parentElement, depth += 1) {
          const value = current.getAttribute?.(name);
          if (value) return value;
        }
        return null;
      };
      const flushVisibleAgentMessages = () => {
        window.__codexRemoteVisibleAgentMessageTimer = null;
        const present = new Set();
        document.querySelectorAll('[data-markdown-text-style="assistant-message"]').forEach((element) => {
          const threadId = closestAttribute(element, 'data-response-annotation-conversation');
          const contentKey = closestAttribute(element, 'data-content-search-unit-key');
          const annotatedItemId = closestAttribute(element, 'data-response-annotation-target');
          const separator = contentKey?.indexOf(':') ?? -1;
          const turnId = separator > 0 ? contentKey.slice(0, separator) : null;
          const itemId = annotatedItemId || (separator > 0 ? contentKey.slice(separator + 1) : null);
          const text = (element.innerText || '').trim();
          if (!threadId || !turnId || !itemId || !text) return;
          const key = threadId + '\\u0000' + turnId + '\\u0000' + itemId;
          present.add(key);
          if (sentMessages.get(key) === text) return;
          sentMessages.set(key, text);
          window.${BINDING_NAME}(JSON.stringify({
            type: 'desktop-visible-agent-message',
            threadId,
            turnId,
            itemId,
            text,
          }));
        });
        for (const key of sentMessages.keys()) {
          if (!present.has(key)) sentMessages.delete(key);
        }
      };
      const scheduleVisibleAgentMessages = () => {
        if (window.__codexRemoteVisibleAgentMessageTimer) return;
        window.__codexRemoteVisibleAgentMessageTimer = setTimeout(flushVisibleAgentMessages, 50);
      };
      const observer = new MutationObserver(scheduleVisibleAgentMessages);
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
        characterData: true,
      });
      window.__codexRemoteVisibleAgentMessageObserver = observer;
      scheduleVisibleAgentMessages();
    }
  `;
}

function visibleThreadSettingsHelperExpression(): string {
  return `
    if (window.__codexRemoteVisibleSettingsHelperVersion !== 2) {
      window.__codexRemoteVisibleSettingsHelperVersion = 2;
      window.__codexRemoteVisibleSettingsObserver?.disconnect();
      if (window.__codexRemoteVisibleSettingsFocusHandler) {
        window.removeEventListener('focus', window.__codexRemoteVisibleSettingsFocusHandler);
      }
      const pendingSettings = window.__codexRemotePendingThreadSettings instanceof Map
        ? window.__codexRemotePendingThreadSettings
        : new Map();
      window.__codexRemotePendingThreadSettings = pendingSettings;
      const syncingThreads = new Set();
      const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
      const waitFor = async (read, timeoutMs = 2500) => {
        const startedAt = Date.now();
        while (Date.now() - startedAt < timeoutMs) {
          const value = read();
          if (value) return value;
          await pause(40);
        }
        return null;
      };
      const pointerDown = (element) => {
        element.dispatchEvent(new PointerEvent('pointerdown', {
          bubbles: true,
          cancelable: true,
          button: 0,
          buttons: 1,
          pointerId: Math.floor(Math.random() * 100000) + 1,
          isPrimary: true,
          pointerType: 'mouse',
        }));
      };
      const pointerMove = (element) => {
        element.focus();
        element.dispatchEvent(new PointerEvent('pointermove', {
          bubbles: true,
          cancelable: true,
          pointerId: Math.floor(Math.random() * 100000) + 1,
          isPrimary: true,
          pointerType: 'mouse',
          clientX: 500,
          clientY: 500,
        }));
      };
      const closeMenus = async () => {
        for (let index = 0; index < 3; index += 1) {
          if (!document.querySelector('[role="menu"][data-state="open"]')) return;
          document.dispatchEvent(new KeyboardEvent('keydown', {
            key: 'Escape',
            code: 'Escape',
            bubbles: true,
          }));
          await pause(80);
        }
      };
      const reactConversationId = (element) => {
        if (!element) return null;
        const fiberKey = Object.keys(element).find((key) => key.startsWith('__reactFiber$'));
        let fiber = fiberKey ? element[fiberKey] : null;
        for (let depth = 0; fiber && depth < 100; depth += 1, fiber = fiber.return) {
          const conversationId = fiber.memoizedProps?.conversationId;
          if (typeof conversationId === 'string') return conversationId;
        }
        return null;
      };
      const permissionTrigger = () => document.querySelector(
        'button[data-composer-navigation-target="permissions"]',
      );
      const intelligenceTrigger = () => document.querySelector(
        'button[data-codex-intelligence-trigger="true"]',
      );
      const visibleConversationId = () => reactConversationId(
        permissionTrigger() || intelligenceTrigger() || document.querySelector('[data-codex-composer-root]'),
      );
      const menuForTrigger = (trigger) => {
        if (!trigger?.id) return null;
        return Array.from(document.querySelectorAll('[role="menu"][data-state="open"]'))
          .find((menu) => menu.getAttribute('aria-labelledby') === trigger.id) || null;
      };
      const openMenu = async (trigger) => {
        await closeMenus();
        pointerDown(trigger);
        return waitFor(() => menuForTrigger(trigger));
      };
      const openSubmenu = async (item) => {
        pointerMove(item);
        return waitFor(() => {
          const controls = item.getAttribute('aria-controls');
          const menu = controls ? document.getElementById(controls) : null;
          return menu?.getAttribute('data-state') === 'open' ? menu : null;
        });
      };
      const firstLine = (element) => (element?.innerText || '').trim().split(/\\r?\\n/, 1)[0] || '';
      const normalizeLabel = (value) => String(value || '')
        .toLowerCase()
        .replace(/[^\\p{L}\\p{N}]+/gu, '');
      const permissionLabelsMatch = (left, right) => {
        const a = normalizeLabel(left);
        const b = normalizeLabel(right);
        return a.length > 0 && b.length > 0 && (a.startsWith(b) || b.startsWith(a));
      };
      const normalizeModel = (value) => String(value || '')
        .toLowerCase()
        .replace(/^gpt[-_ ]*/, '')
        .replace(/[^a-z0-9]+/g, '');
      const permissionMode = (settings) => {
        const profile = settings.permissions;
        const reviewer = settings.approvalsReviewer;
        if (profile === ':danger-full-access' && settings.approvalPolicy === 'never') return 'full-access';
        if (reviewer === 'guardian_subagent' || reviewer === 'auto_review') return 'guardian-approvals';
        if (profile === ':workspace' || profile === ':read-only') return 'auto';
        return typeof profile === 'string' ? profile : null;
      };
      const syncPermission = async (settings) => {
        const mode = permissionMode(settings);
        if (!mode) return true;
        const trigger = permissionTrigger();
        if (!trigger) return false;
        const menu = await openMenu(trigger);
        if (!menu) return false;
        const items = Array.from(menu.querySelectorAll('[role="menuitem"]'));
        const baseIndex = mode === 'auto' ? 0 : mode === 'guardian-approvals' ? 1 : mode === 'full-access' ? 2 : -1;
        const normalizedProfile = normalizeModel(String(mode).replace(/^:/, ''));
        const item = baseIndex >= 0
          ? items[baseIndex]
          : items.find((candidate) => normalizeModel(firstLine(candidate)) === normalizedProfile);
        if (!item) {
          await closeMenus();
          return false;
        }
        const expectedLabel = firstLine(item);
        if (permissionLabelsMatch(firstLine(trigger), expectedLabel)) {
          await closeMenus();
          return true;
        }
        item.click();
        const dialog = mode === 'full-access'
          ? await waitFor(() => document.querySelector('[role="dialog"]'), 800)
          : null;
        if (dialog) {
          const buttons = Array.from(dialog.querySelectorAll('button:not([disabled])'));
          buttons.at(-1)?.click();
        }
        return Boolean(await waitFor(
          () => permissionLabelsMatch(firstLine(trigger), expectedLabel),
        ));
      };
      const syncModel = async (settings) => {
        if (typeof settings.model !== 'string') return true;
        const trigger = intelligenceTrigger();
        if (!trigger) return false;
        const target = normalizeModel(settings.model);
        if (normalizeModel(firstLine(trigger)) === target) return true;
        const menu = await openMenu(trigger);
        if (!menu) return false;
        const categories = Array.from(menu.querySelectorAll('[role="menuitem"][aria-haspopup="menu"]'));
        const submenu = categories[0] ? await openSubmenu(categories[0]) : null;
        if (!submenu) return false;
        const item = Array.from(submenu.querySelectorAll('[role="menuitem"]'))
          .find((candidate) => normalizeModel(firstLine(candidate)) === target);
        if (!item) {
          await closeMenus();
          return false;
        }
        item.click();
        return Boolean(await waitFor(() => normalizeModel(firstLine(trigger)) === target));
      };
      const effortValuesForCount = (count) => {
        const common = ['low', 'medium', 'high', 'xhigh', 'max'];
        if (count <= common.length) return common.slice(0, count);
        if (count === common.length + 1) return ['minimal', ...common];
        return ['minimal', ...common, 'ultra'].slice(0, count);
      };
      const syncEffort = async (settings) => {
        if (typeof settings.effort !== 'string') return true;
        const trigger = intelligenceTrigger();
        if (!trigger) return false;
        if (trigger.getAttribute('data-selected-reasoning-effort') === settings.effort) return true;
        const menu = await openMenu(trigger);
        if (!menu) return false;
        const categories = Array.from(menu.querySelectorAll('[role="menuitem"][aria-haspopup="menu"]'));
        const submenu = categories[1] ? await openSubmenu(categories[1]) : null;
        if (!submenu) return false;
        const items = Array.from(submenu.querySelectorAll('[role="menuitem"]'));
        const effortValues = effortValuesForCount(items.length);
        const targetIndex = effortValues.indexOf(settings.effort);
        const item = targetIndex >= 0 ? items[targetIndex] : null;
        if (!item) {
          await closeMenus();
          return false;
        }
        item.click();
        return Boolean(await waitFor(
          () => trigger.getAttribute('data-selected-reasoning-effort') === settings.effort,
        ));
      };
      const syncVisible = async (params, queueWhenHidden = true) => {
        const conversationId = params?.conversationId;
        const settings = params?.threadSettings;
        if (typeof conversationId !== 'string' || !settings || typeof settings !== 'object') {
          throw new Error('desktop-visible-settings-invalid');
        }
        if (visibleConversationId() !== conversationId) {
          if (queueWhenHidden) pendingSettings.set(conversationId, params);
          return { visible: false, queued: queueWhenHidden, synced: false, failures: [] };
        }
        if (syncingThreads.has(conversationId)) {
          if (queueWhenHidden) pendingSettings.set(conversationId, params);
          return { visible: true, queued: queueWhenHidden, synced: false, failures: ['busy'] };
        }
        syncingThreads.add(conversationId);
        const failures = [];
        try {
          if (!await syncModel(settings)) failures.push('model');
          if (!await syncEffort(settings)) failures.push('effort');
          if (!await syncPermission(settings)) failures.push('permission');
          if (failures.length === 0) pendingSettings.delete(conversationId);
          return { visible: true, queued: false, synced: failures.length === 0, failures };
        } finally {
          syncingThreads.delete(conversationId);
        }
      };
      window.__codexRemoteSyncVisibleThreadSettings = (params) => syncVisible(params, true);
      let observerTimer = null;
      const flushPending = () => {
        if (pendingSettings.size === 0 || observerTimer != null) return;
        observerTimer = setTimeout(() => {
          observerTimer = null;
          const conversationId = visibleConversationId();
          const params = conversationId ? pendingSettings.get(conversationId) : null;
          if (params) void syncVisible(params, false);
        }, 120);
      };
      const observer = new MutationObserver(flushPending);
      observer.observe(document.documentElement, {
        childList: true,
        subtree: true,
      });
      window.__codexRemoteVisibleSettingsObserver = observer;
      window.__codexRemoteVisibleSettingsFocusHandler = flushPending;
      window.addEventListener('focus', flushPending);
    }
  `;
}

function ownerHelperExpression(): string {
  return `(() => {
    if (window.__codexRemoteRequestThreadOwnerVersion !== 5) {
      window.__codexRemoteRequestThreadOwnerVersion = 5;
      let coordinationPromise;
      const getCoordination = async () => {
        if (coordinationPromise) return coordinationPromise;
        coordinationPromise = (async () => {
          const urls = [
            ...Array.from(document.querySelectorAll('link[href],script[src]')).map((node) => node.href || node.src),
            ...performance.getEntriesByType('resource').map((entry) => entry.name),
          ];
          const moduleUrl = urls.find((url) => /\\/app-initial-[^/]+\\.js(?:$|\\?)/.test(url));
          if (!moduleUrl) throw new Error('desktop-owner-module-not-found');
          const loaded = await import(moduleUrl);
          const createRemoteMain = Object.values(loaded).find((value) => {
            if (typeof value !== 'function') return false;
            try {
              return String(value).includes('getRemoteMain');
            } catch {
              // Desktop can export callable proxies whose primitive/string
              // conversion intentionally throws. They are not RPC factories.
              return false;
            }
          });
          if (!createRemoteMain) throw new Error('desktop-owner-rpc-factory-not-found');
          const channel = new MessageChannel();
          window.postMessage(
            { type: 'connect-app-host', port: channel.port2 },
            window.location.origin,
            [channel.port2],
          );
          const remoteMain = createRemoteMain(channel.port1, {});
          const services = await remoteMain.services;
          if (!services?.clientCoordination) throw new Error('desktop-owner-coordination-unavailable');
          return services.clientCoordination;
        })();
        return coordinationPromise;
      };
      window.__codexRemoteRequestThreadOwner = async (method, params) => {
        try {
          const coordination = await getCoordination();
          const conversationId = params?.conversationId;
          if (typeof conversationId !== 'string') throw new Error('desktop-thread-id-invalid');
          return coordination.requestThreadFollower({ hostId: 'local', request: { method, params } });
        } catch (error) {
          // Renderer changes can leave the app-host coordination port stale.
          coordinationPromise = undefined;
          throw error;
        }
      };
      window.__codexRemoteBroadcastQueuedFollowUps = async (conversationId, messages) => {
        try {
          const coordination = await getCoordination();
          return coordination.threadQueuedFollowUpsChanged({ conversationId, messages });
        } catch (error) {
          coordinationPromise = undefined;
          throw error;
        }
      };
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

function closeSocket(socket?: WebSocket) {
  if (!socket || socket.readyState === WebSocket.CLOSED) return Promise.resolve();
  return new Promise<void>((resolve) => {
    socket.once("close", () => resolve());
    socket.close();
    const timeout = setTimeout(() => {
      socket.terminate();
      resolve();
    }, 500);
    socket.once("close", () => clearTimeout(timeout));
  });
}

function throwRuntimeException(response: Record<string, unknown>, prefix: string) {
  const details = response.exceptionDetails;
  if (!details || typeof details !== "object") return;
  const record = details as Record<string, unknown>;
  const exception = record.exception;
  const description = exception && typeof exception === "object"
    ? (exception as Record<string, unknown>).description
    : undefined;
  const message = typeof description === "string"
    ? description.split("\n", 1)[0]
    : typeof record.text === "string" ? record.text : "runtime-exception";
  throw new Error(`${prefix}:${message}`);
}

function asRecord(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}
