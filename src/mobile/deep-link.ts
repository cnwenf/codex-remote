export type MobileThreadTarget = { connectionId: string; threadId: string };

export function mobileThreadUrl(connectionId: string, threadId: string) {
  return `codex-remote://connection/${encodeURIComponent(connectionId)}/thread/${encodeURIComponent(threadId)}`;
}

export function parseMobileDeepLink(value: string): MobileThreadTarget | undefined {
  try {
    const url = new URL(value);
    if (url.protocol !== "codex-remote:" || url.hostname !== "connection") return undefined;
    const match = url.pathname.match(/^\/([^/]+)\/thread\/([^/]+)$/);
    if (!match) return undefined;
    const connectionId = decodeURIComponent(match[1]);
    const threadId = decodeURIComponent(match[2]);
    if (!connectionId || !threadId) return undefined;
    return { connectionId, threadId };
  } catch {
    return undefined;
  }
}
