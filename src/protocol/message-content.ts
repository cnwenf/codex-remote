import type { CodexItem } from "./thread-store";

/** Normalize protocol spelling at the boundary, not with substring guesses in views. */
export function messageKind(type: string): "user" | "agent" | "activity" | "plan" {
  switch (type.replace(/[_-]/g, "").toLowerCase()) {
    case "usermessage": return "user";
    case "agentmessage":
    case "assistantmessage": return "agent";
    case "todolist": return "plan";
    default: return "activity";
  }
}

export function itemText(item: Record<string, unknown>): string {
  for (const key of ["text", "command", "query"]) {
    if (typeof item[key] === "string" && item[key]) return item[key];
  }
  const content = item.content ?? item.summary ?? item.summary_text;
  if (typeof content === "string") return content;
  if (Array.isArray(content)) {
    return content.map((part: unknown) => typeof part === "string" ? part
      : part && typeof part === "object" && "text" in part && typeof part.text === "string" ? part.text : "")
      .filter(Boolean).join("\n");
  }
  if (typeof item.tool === "string") return item.server ? `${item.server} / ${item.tool}` : item.tool;
  if (Array.isArray(item.changes)) return item.changes.map((change) => change.path ?? change.filePath ?? "").filter(Boolean).join("\n");
  return "";
}

/** DOM observations strip Markdown and links; they are a fallback, not authoritative text. */
export function visibleAssistantText(previous: CodexItem, text: string): string {
  if (previous.textSource === "completed" || previous.textSource === "snapshot") return previous.text;
  if (!previous.text || text.startsWith(previous.text)) return text;
  return previous.text;
}

export function appendAssistantText(previous: CodexItem, delta: string): Pick<CodexItem, "text" | "streamedText"> {
  const priorStream = previous.streamedText ?? (previous.visibleText === undefined ? previous.text : "");
  const streamedText = priorStream + delta;
  // Snapshots/DOM may be ahead of the stream after reconnect. Consume overlap,
  // but never rebuild displayed text from an older, shorter stream prefix.
  if (previous.text === priorStream || (previous.visibleText && streamedText.includes(previous.visibleText))) {
    return { text: streamedText, streamedText };
  }
  if (previous.text.startsWith(streamedText) || (previous.visibleText && previous.visibleText.includes(streamedText.trim()))) {
    return { text: previous.text, streamedText };
  }
  if (streamedText.includes(previous.text)) return { text: streamedText, streamedText };
  if (priorStream && previous.text.startsWith(priorStream)) {
    const text = previous.text + delta;
    return { text, streamedText: previous.visibleText === undefined ? text : streamedText };
  }
  // Unaligned DOM text and Markdown are different representations. Never
  // concatenate them; retain a fallback until enough raw text has arrived.
  return { text: streamedText.length >= previous.text.length ? streamedText : previous.text, streamedText };
}

export function mergeMessageItem(snapshot: CodexItem | undefined, live: CodexItem, terminal: boolean): CodexItem {
  if (!snapshot) return live;
  let text = live.text;
  let textSource = live.textSource;
  const snapshotComplete = snapshot.textSource === "completed";
  const useSnapshot = snapshotComplete
    ? live.textSource !== "completed" || !live.text.startsWith(snapshot.text)
    : live.textSource !== "completed" && (
      !live.text || snapshot.text.startsWith(live.text) ||
      (!live.text.startsWith(snapshot.text) && terminal)
    );
  // An item may finish before the turn's tools do. Adopt its canonical body
  // and completion together; never freeze a live fragment as completed.
  if (snapshot.text && useSnapshot) {
    text = snapshot.text;
    textSource = snapshot.textSource;
  }
  const imageIds = [...new Set([...(snapshot.imageIds ?? []), ...(live.imageIds ?? [])])];
  return {
    ...snapshot, ...live, text, textSource,
    phase: live.phase ?? snapshot.phase,
    ...(imageIds.length > 0 ? { imageIds } : {}),
    status: terminal ? snapshot.status ?? "completed" : live.status ?? snapshot.status,
  };
}
