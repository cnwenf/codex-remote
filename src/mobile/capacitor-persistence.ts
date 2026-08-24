import { Preferences } from "@capacitor/preferences";
import type { ConnectionPersistence } from "./connection-store";
import { CodexRemoteNative } from "./native-bridge";
import type { RemoteConnection } from "./types";

const CONNECTIONS_KEY = "codex-remote.connections.v1";
const SELECTED_KEY = "codex-remote.selected.v1";

export class CapacitorConnectionPersistence implements ConnectionPersistence {
  async readConnections(): Promise<RemoteConnection[]> {
    const { value } = await Preferences.get({ key: CONNECTIONS_KEY });
    if (!value) return [];
    try {
      const parsed = JSON.parse(value) as unknown;
      if (!Array.isArray(parsed)) return [];
      return parsed.filter(isRemoteConnection);
    } catch {
      return [];
    }
  }

  async writeConnections(connections: RemoteConnection[]) {
    await Preferences.set({ key: CONNECTIONS_KEY, value: JSON.stringify(connections) });
  }

  async readSelectedId() {
    const { value } = await Preferences.get({ key: SELECTED_KEY });
    return value ?? undefined;
  }

  async writeSelectedId(id: string | undefined) {
    if (id) await Preferences.set({ key: SELECTED_KEY, value: id });
    else await Preferences.remove({ key: SELECTED_KEY });
  }

  async readSecret(id: string) {
    return (await CodexRemoteNative.readSecret({ id })).value;
  }

  async writeSecret(id: string, value: string) {
    await CodexRemoteNative.writeSecret({ id, value });
  }

  async removeSecret(id: string) {
    await CodexRemoteNative.removeSecret({ id });
  }
}

function isRemoteConnection(value: unknown): value is RemoteConnection {
  if (!value || typeof value !== "object") return false;
  const record = value as Record<string, unknown>;
  return typeof record.id === "string" &&
    typeof record.name === "string" &&
    typeof record.baseUrl === "string" &&
    typeof record.lastUsedAt === "number";
}
