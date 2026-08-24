export type RpcId = number | string;

export interface RpcRequest {
  id: RpcId;
  method: string;
  params?: unknown;
}

export interface RpcNotification {
  method: string;
  params?: unknown;
}

export interface RpcError {
  code: number;
  message: string;
  data?: unknown;
}

export interface RpcResponse {
  id: RpcId;
  result?: unknown;
  error?: RpcError;
}

export type RpcMessage = RpcRequest | RpcNotification | RpcResponse;

export type GatewayEnvelope =
  | {
      type: "session";
      state: "ready" | "reconnecting" | "disconnected";
      message?: string;
      defaultCwd?: string;
      transport?: "desktop-live" | "desktop-cold" | "web-live";
      readOnly?: boolean;
      appServerVersion?: string;
    }
  | { type: "rpc"; payload: RpcMessage }
  | { type: "diagnostic"; category: string; message: string };

export type TransportDiagnostic = {
  category: "process" | "protocol";
  message: string;
};

export interface CodexTransport {
  readonly requiresInitialize?: boolean;
  start(
    onMessage: (message: RpcMessage) => void,
    onDiagnostic: (diagnostic: TransportDiagnostic) => void,
  ): Promise<void>;
  send(message: RpcMessage): void;
  stop(): Promise<void>;
  getSessionInfo?(): {
    transport: "desktop-live" | "desktop-cold" | "web-live";
    readOnly: boolean;
    appServerVersion?: string;
  };
}

export function hasRpcId(message: RpcMessage): message is RpcRequest | RpcResponse {
  return Object.prototype.hasOwnProperty.call(message, "id");
}

export function isRpcRequest(message: RpcMessage): message is RpcRequest {
  return hasRpcId(message) && "method" in message && typeof message.method === "string";
}

export function isRpcResponse(message: RpcMessage): message is RpcResponse {
  return hasRpcId(message) && !("method" in message);
}
