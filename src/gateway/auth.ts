import { createHash, createHmac, timingSafeEqual } from "node:crypto";

export const SESSION_COOKIE_NAME = "codex_local_session";

export function isAuthorized(provided: string, expected: string): boolean {
  const providedHash = createHash("sha256").update(provided).digest();
  const expectedHash = createHash("sha256").update(expected).digest();
  return timingSafeEqual(providedHash, expectedHash);
}

export function decodeTokenProtocol(protocols: Iterable<string>): string | undefined {
  for (const protocol of protocols) {
    if (!protocol.startsWith("token.")) continue;
    const encoded = protocol.slice("token.".length);
    if (!encoded || !/^[A-Za-z0-9_-]+$/.test(encoded)) return undefined;
    try {
      return Buffer.from(encoded, "base64url").toString("utf8");
    } catch {
      return undefined;
    }
  }
  return undefined;
}

export function isAllowedOrigin(origin: string | undefined, allowed: Set<string>) {
  return typeof origin === "string" && allowed.has(origin);
}

export function createSessionCredential(token: string) {
  return createHmac("sha256", token)
    .update("codex-local-web-session-v1")
    .digest("base64url");
}

export function readCookie(header: string | undefined, name: string) {
  if (!header) return undefined;
  for (const part of header.split(";")) {
    const separator = part.indexOf("=");
    if (separator < 0 || part.slice(0, separator).trim() !== name) continue;
    const value = part.slice(separator + 1).trim();
    return value || undefined;
  }
  return undefined;
}
