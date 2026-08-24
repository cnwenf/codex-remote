import { createServer, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import WebSocket, { WebSocketServer } from "ws";

type CdpRequest = {
  id: number;
  method: string;
  params?: Record<string, unknown>;
};

export class FakeCdpServer {
  readonly requests: CdpRequest[] = [];
  readonly ownerRequests: CdpRequest[] = [];
  visibleSettingsSyncDelayMs = 0;
  maxConcurrentVisibleSettingsSyncRequests = 0;
  ownerResponse: unknown = {
    method: "thread-follower-update-thread-settings",
    result: { ok: true },
  };
  private readonly httpServer: Server;
  private readonly websocketServer: WebSocketServer;
  private socket?: WebSocket;
  private ownerSocket?: WebSocket;
  private activeVisibleSettingsSyncRequests = 0;

  constructor() {
    this.httpServer = createServer((request, response) => {
      if (request.url !== "/json/list") {
        response.writeHead(404).end();
        return;
      }
      const address = this.httpServer.address() as AddressInfo;
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify([
        {
          id: "extension",
          type: "page",
          title: "Unrelated extension",
          url: "chrome-extension://example/index.html",
          webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}/devtools/page/extension`,
        },
        {
          id: "spoofed",
          type: "page",
          title: "Codex",
          url: "https://example.invalid/webview/index.html",
          webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}/devtools/page/spoofed`,
        },
        {
          id: "codex",
          type: "page",
          title: "Codex",
          url: "file:///Applications/ChatGPT.app/Contents/Resources/app.asar/webview/index.html",
          webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}/devtools/page/codex`,
        },
        {
          id: "codex-avatar-overlay",
          type: "page",
          title: "Codex",
          url: "app://-/index.html?initialRoute=%2Favatar-overlay",
          webSocketDebuggerUrl: `ws://127.0.0.1:${address.port}/devtools/page/codex-avatar-overlay`,
        },
      ]));
    });
    this.websocketServer = new WebSocketServer({ noServer: true });
    this.httpServer.on("upgrade", (request, socket, head) => {
      if (request.url !== "/devtools/page/codex" && request.url !== "/devtools/page/codex-avatar-overlay") {
        socket.destroy();
        return;
      }
      this.websocketServer.handleUpgrade(request, socket, head, (websocket) => {
        (websocket as WebSocket & { fakeOwner?: boolean }).fakeOwner =
          request.url === "/devtools/page/codex-avatar-overlay";
        this.websocketServer.emit("connection", websocket, request);
      });
    });
    this.websocketServer.on("connection", (socket) => {
      const owner = (socket as WebSocket & { fakeOwner?: boolean }).fakeOwner === true;
      if (owner) this.ownerSocket = socket;
      else this.socket = socket;
      socket.on("message", (raw) => {
        const request = JSON.parse(raw.toString()) as CdpRequest;
        (owner ? this.ownerRequests : this.requests).push(request);
        const visibleSettingsSync = !owner &&
          request.method === "Runtime.callFunctionOn" &&
          String(request.params?.functionDeclaration).includes("__codexRemoteSyncVisibleThreadSettings");
        if (visibleSettingsSync && this.visibleSettingsSyncDelayMs > 0) {
          this.activeVisibleSettingsSyncRequests += 1;
          this.maxConcurrentVisibleSettingsSyncRequests = Math.max(
            this.maxConcurrentVisibleSettingsSyncRequests,
            this.activeVisibleSettingsSyncRequests,
          );
          setTimeout(() => {
            this.activeVisibleSettingsSyncRequests -= 1;
            socket.send(JSON.stringify({
              id: request.id,
              result: { result: { value: { visible: true, synced: true, failures: [] } } },
            }));
          }, this.visibleSettingsSyncDelayMs);
          return;
        }
        const runtimeResult = request.method === "Runtime.evaluate"
          ? { objectId: owner ? "owner-window-1" : "window-1", type: "object" }
          : owner && request.method === "Runtime.callFunctionOn"
            ? { value: this.ownerResponse }
          : visibleSettingsSync
            ? { value: { visible: true, synced: true, failures: [] } }
          : { value: true };
        socket.send(JSON.stringify({ id: request.id, result: { result: runtimeResult } }));
      });
    });
  }

  async start(): Promise<string> {
    await new Promise<void>((resolve) => this.httpServer.listen(0, "127.0.0.1", resolve));
    const address = this.httpServer.address() as AddressInfo;
    return `http://127.0.0.1:${address.port}`;
  }

  emitBinding(payload: unknown) {
    this.socket?.send(JSON.stringify({
      method: "Runtime.bindingCalled",
      params: {
        name: "__codexLocalDesktopEvent",
        payload: JSON.stringify(payload),
      },
    }));
  }

  disconnect() {
    this.socket?.close();
  }

  async stop() {
    this.socket?.terminate();
    this.ownerSocket?.terminate();
    await new Promise<void>((resolve) => this.websocketServer.close(() => resolve()));
    await new Promise<void>((resolve, reject) => {
      this.httpServer.close((error) => error ? reject(error) : resolve());
    });
  }
}
