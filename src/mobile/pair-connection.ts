import { ConnectionStore } from "./connection-store";
import { exchangePairing, parsePairingPayload } from "./pairing";

type PairingExchange = (payload: string) => Promise<{ baseUrl: string; token: string }>;

export async function beginScannedPairing(
  payload: string,
  store: ConnectionStore,
  onConnectionsChanged: () => void | Promise<void>,
  exchange: PairingExchange = exchangePairing,
) {
  const parsed = parsePairingPayload(payload);
  const connection = await store.savePendingPairing({
    name: new URL(parsed.baseUrl).hostname,
    baseUrl: parsed.baseUrl,
  });
  await onConnectionsChanged();

  const completion = exchange(payload).then(async (paired) => {
    if (paired.baseUrl !== connection.baseUrl) throw new Error("pairing-response-invalid");
    await store.completePairing(connection.id, paired.token);
    await onConnectionsChanged();
  }).catch(async () => {
    await store.failPairing(connection.id);
    await onConnectionsChanged();
  });

  return { connection, completion };
}
