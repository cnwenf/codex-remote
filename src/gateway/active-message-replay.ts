import { itemText, messageKind } from "../protocol/message-content";
import type { RpcMessage, RpcNotification } from "../protocol/types";

type Entry = { threadId: string; turnId: string; itemId: string; text: string; phase?: string; closed?: boolean };

/** Only raw, unfinished assistant bodies: persisted history remains authoritative. */
export class ActiveMessageReplay {
  private entries = new Map<string, Entry>();
  private completedTurns = new Set<string>();

  observe(message: RpcMessage) {
    if (!("method" in message)) return;
    const params = record(message.params);
    const item = record(params.item);
    const threadId = params.threadId;
    const itemId = params.itemId ?? item.id;
    if (typeof threadId !== "string") return;
    const turnId = params.turnId ?? record(params.turn).id ?? [...this.entries.values()]
      .find((entry) => entry.threadId === threadId && entry.itemId === itemId)?.turnId;
    if (typeof turnId !== "string") return;
    const turnKey = JSON.stringify([threadId, turnId]);
    if (this.completedTurns.has(turnKey)) return;
    const key = JSON.stringify([threadId, turnId, itemId]);
    const previous = this.entries.get(key);
    if (message.method === "turn/completed") {
      this.completedTurns.add(turnKey);
      if (this.completedTurns.size > 64) this.completedTurns.delete(this.completedTurns.values().next().value!);
      for (const entry of this.entries.values()) {
        if (entry.threadId === threadId && entry.turnId === turnId) this.close(entry);
      }
    } else if (message.method === "item/completed" && typeof itemId === "string") {
      this.entries.set(key, { threadId, turnId, itemId, text: "", closed: true });
    } else if (message.method === "item/started" && !previous && typeof itemId === "string" &&
      typeof item.type === "string" && messageKind(item.type) === "agent") {
      this.entries.set(key, {
        threadId, turnId, itemId, text: itemText(item),
        ...(typeof item.phase === "string" ? { phase: item.phase } : {}),
      });
    } else if (message.method === "item/agentMessage/delta" && previous && !previous.closed && typeof params.delta === "string") {
      previous.text += params.delta;
    }
    // ponytail: at most 64 entries / 256K UTF-16 characters; O(64) per event.
    // Evicted or unseen starts never turn later fragments into a full prefix.
    while (this.entries.size > 64 || [...this.entries.values()].reduce((size, entry) => size + entry.text.length, 0) > 256 * 1024) {
      this.entries.delete(this.entries.keys().next().value!);
    }
  }

  snapshots(): RpcNotification[] {
    return [...this.entries.values()].filter((entry) => !entry.closed && entry.text).map((entry) => ({
      method: "gateway/agentMessageSnapshot",
      params: {
        threadId: entry.threadId, turnId: entry.turnId, itemId: entry.itemId,
        text: entry.text, phase: entry.phase,
      },
    }));
  }

  private close(entry: Entry) {
    // Retain a bounded tombstone so a late start/delta cannot reopen this body.
    entry.text = "";
    entry.closed = true;
  }
}

function record(value: unknown): Record<string, unknown> {
  return value !== null && typeof value === "object" ? value as Record<string, unknown> : {};
}
