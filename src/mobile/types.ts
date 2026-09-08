export type RemoteConnection = {
  id: string;
  name: string;
  baseUrl: string;
  lastUsedAt: number;
  pairingStatus?: "pending" | "ready" | "error";
  connectionStatus?: "checking" | "available" | "unavailable";
};

export type RemoteConnectionInput = {
  id?: string;
  name: string;
  baseUrl: string;
  token?: string;
};

export type MobileTaskStatus = "running" | "idle" | "error" | "unknown";

export type MobileTask = {
  id: string;
  title: string;
  status: MobileTaskStatus;
  updatedAt?: number;
  turnId?: string;
};

export type MobileStatusResponse = {
  version: 1;
  generatedAt: number;
  threads: MobileTask[];
  completions?: MobileCompletion[];
};

export type MobileCompletion = {
  id: string;
  threadId: string;
  turnId: string;
  title: string;
  status: "idle" | "error";
  completedAt: number;
};
