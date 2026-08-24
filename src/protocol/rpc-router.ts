import {
  isRpcRequest,
  isRpcResponse,
  type RpcId,
  type RpcMessage,
  type RpcNotification,
  type RpcRequest,
  type RpcResponse,
} from "./types";

type BrowserRequest = {
  clientId: string;
  browserId: RpcId;
};

export type ServerRoute =
  | { clientId: string; message: RpcMessage }
  | { broadcast: RpcMessage };

export class RpcRouter {
  private nextServerId = 1;
  private nextBrowserRequestId = 1;
  private readonly browserRequests = new Map<RpcId, BrowserRequest>();
  private readonly serverRequests = new Map<RpcId, RpcId>();

  fromBrowser(clientId: string, message: RpcRequest): RpcRequest;
  fromBrowser(clientId: string, message: RpcResponse): RpcResponse | undefined;
  fromBrowser(clientId: string, message: RpcNotification): RpcNotification;
  fromBrowser(clientId: string, message: RpcMessage): RpcMessage | undefined;
  fromBrowser(clientId: string, message: RpcMessage): RpcMessage | undefined {
    if (isRpcRequest(message)) {
      const serverId = this.nextServerId++;
      this.browserRequests.set(serverId, {
        clientId,
        browserId: message.id,
      });
      return { ...message, id: serverId };
    }

    if (isRpcResponse(message)) {
      const serverId = this.serverRequests.get(message.id);
      if (serverId === undefined) {
        return undefined;
      }
      this.serverRequests.delete(message.id);
      return { ...message, id: serverId };
    }

    return message;
  }

  dropClient(clientId: string) {
    for (const [serverId, pending] of this.browserRequests) {
      if (pending.clientId === clientId) this.browserRequests.delete(serverId);
    }
  }

  fromServer(message: RpcResponse): { clientId: string; message: RpcResponse };
  fromServer(message: RpcRequest): { broadcast: RpcRequest };
  fromServer(message: RpcNotification): { broadcast: RpcNotification };
  fromServer(message: RpcMessage): ServerRoute;
  fromServer(message: RpcMessage): ServerRoute {
    if (isRpcResponse(message)) {
      const pending = this.browserRequests.get(message.id);
      if (!pending) {
        throw new Error("unmapped-server-response");
      }
      this.browserRequests.delete(message.id);
      return {
        clientId: pending.clientId,
        message: { ...message, id: pending.browserId },
      };
    }

    if (isRpcRequest(message)) {
      const browserId = `server-${this.nextBrowserRequestId++}`;
      this.serverRequests.set(browserId, message.id);
      return { broadcast: { ...message, id: browserId } };
    }

    return { broadcast: message };
  }
}
