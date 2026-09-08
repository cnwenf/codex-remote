export type HistoryAnchor = { turnId: string; itemId?: string };
export type HistoryRange = { start: number; end: number; anchor?: HistoryAnchor; endAnchor?: HistoryAnchor };

// Byte ranges describe what was actually read, not what live events happened
// to render. Keep only merged intervals; no message bodies are retained here.
export function addHistoryRange(ranges: HistoryRange[], value: unknown): HistoryRange[] {
  const outer = record(value);
  const { start, end } = record(outer.historyRange);
  if (typeof start !== "number" || typeof end !== "number" ||
    !Number.isSafeInteger(start) || !Number.isSafeInteger(end) || start < 0 || end < start) return ranges;
  const turns = record(outer.thread).turns;
  const anchor = pageAnchor(turns, false);
  const endAnchor = pageAnchor(turns, true);
  const result: HistoryRange[] = [];
  // A late response can have an earlier cutoff; it is not evidence that the
  // append-only rollout was truncated. Union coverage instead of resetting it.
  for (const range of [...ranges, { start, end, anchor, endAnchor }].sort((a, b) => a.start - b.start)) {
    const last = result.at(-1);
    if (last && range.start <= last.end) {
      if (range.end >= last.end) last.endAnchor = range.endAnchor ?? last.endAnchor;
      last.end = Math.max(last.end, range.end);
      last.anchor ??= range.anchor;
    }
    else result.push({ ...range });
  }
  return result;
}

export function latestHistoryGap(ranges: HistoryRange[]) {
  const right = ranges.at(-1);
  return ranges.length > 1 && right ? { beforeCursor: String(right.start), anchor: right.anchor, afterAnchor: ranges.at(-2)?.endAnchor } : undefined;
}

function pageAnchor(turns: unknown, last: boolean): HistoryAnchor | undefined {
  const ordered = (Array.isArray(turns) ? turns : []).map(record).filter(turn =>
    !(turn.status === "unknown" && turn.completeFromTurnStart === false));
  const turn = record(ordered.at(last ? -1 : 0));
  const item = record(Array.isArray(turn.items) ? turn.items.at(last ? -1 : 0) : undefined);
  return typeof turn.id === "string" ? { turnId: turn.id, itemId: typeof item.id === "string" ? item.id : undefined } : undefined;
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
}
