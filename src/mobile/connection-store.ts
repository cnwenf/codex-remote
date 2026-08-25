import type { RemoteConnection, RemoteConnectionInput } from "./types";

export interface ConnectionPersistence {
  readConnections(): Promise<RemoteConnection[]>;
  writeConnections(connections: RemoteConnection[]): Promise<void>;
  readSelectedId(): Promise<string | undefined>;
  writeSelectedId(id: string | undefined): Promise<void>;
  readSecret(id: string): Promise<string | undefined>;
  writeSecret(id: string, token: string): Promise<void>;
  removeSecret(id: string): Promise<void>;
}

export class ConnectionStore {
  constructor(
    private readonly persistence: ConnectionPersistence,
    private readonly makeId: () => string = () => crypto.randomUUID(),
    private readonly now: () => number = () => Date.now(),
  ) {}

  async list() {
    return (await this.persistence.readConnections())
      .slice()
      .sort((left, right) => right.lastUsedAt - left.lastUsedAt);
  }

  async save(input: RemoteConnectionInput) {
    const name = input.name.trim();
    const token = input.token?.trim();
    if (!name) throw new Error("remote-name-required");
    if (!input.id && !token) throw new Error("remote-token-required");
    const connections = await this.persistence.readConnections();
    const id = input.id ?? this.makeId();
    const existing = connections.find((connection) => connection.id === id);
    const connection: RemoteConnection = {
      id,
      name,
      baseUrl: normalizeRemoteUrl(input.baseUrl),
      lastUsedAt: existing?.lastUsedAt ?? this.now(),
      pairingStatus: "ready",
    };
    const next = [connection, ...connections.filter((value) => value.id !== id)];
    if (token) await this.persistence.writeSecret(id, token);
    await this.persistence.writeConnections(next);
    await this.persistence.writeSelectedId(id);
    return connection;
  }

  async savePendingPairing(input: Pick<RemoteConnectionInput, "name" | "baseUrl">) {
    const name = input.name.trim();
    if (!name) throw new Error("remote-name-required");
    const connections = await this.persistence.readConnections();
    const connection: RemoteConnection = {
      id: this.makeId(),
      name,
      baseUrl: normalizeRemoteUrl(input.baseUrl),
      lastUsedAt: this.now(),
      pairingStatus: "pending",
    };
    await this.persistence.writeConnections([connection, ...connections]);
    await this.persistence.writeSelectedId(connection.id);
    return connection;
  }

  async completePairing(id: string, token: string) {
    const value = token.trim();
    if (!value) throw new Error("remote-token-required");
    await this.persistence.writeSecret(id, value);
    return this.setPairingStatus(id, "ready");
  }

  async failPairing(id: string) {
    return this.setPairingStatus(id, "error");
  }

  async select(id: string) {
    const connections = await this.persistence.readConnections();
    const existing = connections.find((connection) => connection.id === id);
    if (!existing) throw new Error("remote-not-found");
    const selected = { ...existing, lastUsedAt: this.now() };
    await this.persistence.writeConnections([
      selected,
      ...connections.filter((connection) => connection.id !== id),
    ]);
    await this.persistence.writeSelectedId(id);
    return selected;
  }

  async getSelected() {
    const [connections, selectedId] = await Promise.all([
      this.persistence.readConnections(),
      this.persistence.readSelectedId(),
    ]);
    return connections.find((connection) => connection.id === selectedId) ?? connections[0];
  }

  async credentials(id: string) {
    const connection = (await this.persistence.readConnections())
      .find((value) => value.id === id);
    if (!connection) throw new Error("remote-not-found");
    const token = await this.persistence.readSecret(id);
    if (!token) throw new Error("remote-token-not-found");
    return { connection, token };
  }

  async remove(id: string) {
    const [connections, selectedId] = await Promise.all([
      this.persistence.readConnections(),
      this.persistence.readSelectedId(),
    ]);
    const next = connections.filter((connection) => connection.id !== id);
    await this.persistence.removeSecret(id);
    await this.persistence.writeConnections(next);
    if (selectedId === id) await this.persistence.writeSelectedId(next[0]?.id);
  }

  private async setPairingStatus(id: string, pairingStatus: NonNullable<RemoteConnection["pairingStatus"]>) {
    const connections = await this.persistence.readConnections();
    const existing = connections.find((connection) => connection.id === id);
    if (!existing) throw new Error("remote-not-found");
    const updated = { ...existing, pairingStatus };
    await this.persistence.writeConnections([
      updated,
      ...connections.filter((connection) => connection.id !== id),
    ]);
    return updated;
  }
}

export class InMemoryConnectionPersistence implements ConnectionPersistence {
  private connections: RemoteConnection[] = [];
  private selectedId?: string;
  private readonly secrets = new Map<string, string>();

  async readConnections() { return structuredClone(this.connections); }
  async writeConnections(connections: RemoteConnection[]) {
    this.connections = structuredClone(connections);
  }
  async readSelectedId() { return this.selectedId; }
  async writeSelectedId(id: string | undefined) { this.selectedId = id; }
  async readSecret(id: string) { return this.secrets.get(id); }
  async writeSecret(id: string, token: string) { this.secrets.set(id, token); }
  async removeSecret(id: string) { this.secrets.delete(id); }
}

export function normalizeRemoteUrl(value: string) {
  let url: URL;
  try {
    url = new URL(value.trim());
  } catch {
    throw new Error("remote-url-invalid");
  }
  if (url.protocol !== "http:" && url.protocol !== "https:") {
    throw new Error("remote-url-protocol");
  }
  if (url.username || url.password) throw new Error("remote-url-credentials");
  if (url.search) throw new Error("remote-url-query");
  if (url.hash) throw new Error("remote-url-fragment");
  if (url.protocol === "http:" && !isLocalNetworkHost(url.hostname)) {
    throw new Error("remote-url-insecure-public-host");
  }
  url.pathname = url.pathname.replace(/\/+$/, "");
  return url.toString().replace(/\/$/, "");
}

function isLocalNetworkHost(hostname: string) {
  const host = hostname.replace(/^\[|\]$/g, "").toLocaleLowerCase();
  if (host === "localhost" || host.endsWith(".local")) return true;
  if (/^\d{1,3}(?:\.\d{1,3}){3}$/.test(host)) {
    return host.split(".").every((part) => Number(part) <= 255);
  }
  return host === "::1" || host.startsWith("fc") || host.startsWith("fd") || host.startsWith("fe80:");
}
