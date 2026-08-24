import { normalizeRemoteUrl } from "./connection-store";

export function parsePairingPayload(value: string) {
  let url: URL;
  try { url = new URL(value.trim()); } catch { throw new Error("pairing-payload-invalid"); }
  if (url.protocol !== "codex-remote:" || url.hostname !== "pair") {
    throw new Error("pairing-payload-invalid");
  }
  const code = url.searchParams.get("code")?.trim();
  const remote = url.searchParams.get("url")?.trim();
  if (!code || !remote || code.length > 256) throw new Error("pairing-payload-invalid");
  return { baseUrl: normalizeRemoteUrl(remote), code };
}

export async function exchangePairing(payload: string, fetcher: typeof fetch = fetch) {
  const { baseUrl, code } = parsePairingPayload(payload);
  const response = await fetcher(`${baseUrl}/api/mobile/pair`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ code }),
  });
  if (!response.ok) throw new Error("pairing-exchange-failed");
  const body = await response.json() as Record<string, unknown>;
  if (body.baseUrl !== baseUrl || typeof body.token !== "string" || !body.token) {
    throw new Error("pairing-response-invalid");
  }
  return { baseUrl, token: body.token };
}
