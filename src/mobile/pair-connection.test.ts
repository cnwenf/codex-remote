import { describe, expect, it, vi } from "vitest";
import { ConnectionStore, InMemoryConnectionPersistence } from "./connection-store";
import { beginScannedPairing } from "./pair-connection";

const payload = "codex-remote://pair?url=http%3A%2F%2F192.168.1.20%3A4321&code=abc123";

describe("beginScannedPairing", () => {
  it("returns a saved connection before the network exchange finishes", async () => {
    const store = new ConnectionStore(new InMemoryConnectionPersistence(), () => "scanned-mac", () => 1);
    let resolveExchange: ((value: { baseUrl: string; token: string }) => void) | undefined;
    const exchange = vi.fn(() => new Promise<{ baseUrl: string; token: string }>((resolve) => {
      resolveExchange = resolve;
    }));
    const onChanged = vi.fn();

    const pairing = await beginScannedPairing(payload, store, onChanged, exchange);

    expect(pairing.connection).toMatchObject({
      id: "scanned-mac",
      baseUrl: "http://192.168.1.20:4321",
      pairingStatus: "pending",
    });
    expect(await store.list()).toHaveLength(1);
    expect(onChanged).toHaveBeenCalledOnce();

    resolveExchange?.({ baseUrl: "http://192.168.1.20:4321", token: "paired-token" });
    await pairing.completion;
    expect((await store.list())[0]?.pairingStatus).toBe("ready");
    expect(onChanged).toHaveBeenCalledTimes(2);
  });

  it("keeps the saved connection and marks it unavailable when pairing fails", async () => {
    const store = new ConnectionStore(new InMemoryConnectionPersistence(), () => "offline-mac", () => 1);
    const onChanged = vi.fn();

    const pairing = await beginScannedPairing(
      payload,
      store,
      onChanged,
      vi.fn().mockRejectedValue(new Error("pairing-exchange-timeout")),
    );
    await pairing.completion;

    expect(await store.list()).toEqual([
      expect.objectContaining({ id: "offline-mac", pairingStatus: "error" }),
    ]);
    expect(onChanged).toHaveBeenCalledTimes(2);
  });
});
