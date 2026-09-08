import { describe, expect, it } from "vitest";
import { addHistoryRange, latestHistoryGap } from "./history-coverage";

const page = (start: number, end: number, turnId = String(start)) => ({
  historyRange: { start, end }, thread: { turns: [{ id: turnId, items: [{ id: `item-${start}` }] }] },
});
describe("history coverage", () => {
  it("only identifies holes between read ranges, never the unread prefix", () => {
    let ranges = addHistoryRange([], page(100, 200));
    expect(latestHistoryGap(ranges)).toBeUndefined();
    ranges = addHistoryRange(ranges, page(300, 400, "right"));
    expect(latestHistoryGap(ranges)).toEqual({ beforeCursor: "300", anchor: { turnId: "right", itemId: "item-300" }, afterAnchor: { turnId: "100", itemId: "item-100" } });
    ranges = addHistoryRange(ranges, page(180, 300));
    expect(latestHistoryGap(ranges)).toBeUndefined();
    expect(ranges).toHaveLength(1);
    expect(ranges[0]).toMatchObject({ start: 100, end: 400 });
  });
  it("keeps disjoint gaps and processes the newest gap first", () => {
    const ranges = [page(0, 100), page(200, 300), page(400, 500)].reduce((ranges, value) => addHistoryRange(ranges, value), [] as ReturnType<typeof addHistoryRange>);
    expect(latestHistoryGap(ranges)?.beforeCursor).toBe("400");
    expect(latestHistoryGap(addHistoryRange(ranges, page(250, 400)))?.beforeCursor).toBe("200");
  });
  it("retains the right-hand message anchor through a tool-output-only page", () => {
    const ranges = addHistoryRange(addHistoryRange([], page(0, 100)), page(300, 400, "right"));
    const next = addHistoryRange(ranges, { historyRange: { start: 200, end: 300 }, thread: { turns: [] } });
    expect(latestHistoryGap(next)).toEqual({ beforeCursor: "200", anchor: { turnId: "right", itemId: "item-300" }, afterAnchor: { turnId: "0", itemId: "item-0" } });
  });
  it("keeps the last left-hand message when the newest range has no visible turns", () => {
    const left = addHistoryRange([], page(0, 100, "old"));
    const ranges = addHistoryRange(left, { historyRange: { start: 300, end: 400 }, thread: { turns: [] } });
    expect(latestHistoryGap(ranges)).toMatchObject({ beforeCursor: "300", afterAnchor: { turnId: "old", itemId: "item-0" } });
  });
  it("does not move a range boundary backwards for an explicitly historical tool fragment", () => {
    const left = addHistoryRange([], page(0, 100, "left"));
    const lateTool = { id: "older", status: "unknown", completeFromTurnStart: false, items: [{ id: "late-tool" }] };
    const updated = addHistoryRange(left, { historyRange: { start: 50, end: 150 }, thread: { turns: [lateTool] } });
    expect(updated[0].endAnchor).toEqual({ turnId: "left", itemId: "item-0" });
    const right = addHistoryRange(updated, { historyRange: { start: 300, end: 400 }, thread: { turns: [lateTool, { id: "right", items: [{ id: "right-item" }] }] } });
    expect(latestHistoryGap(right)).toEqual({ beforeCursor: "300", anchor: { turnId: "right", itemId: "right-item" }, afterAnchor: { turnId: "left", itemId: "item-0" } });
  });
  it("ignores missing or invalid metadata without treating a late cutoff as a file reset", () => {
    const ranges = addHistoryRange([], page(100, 200));
    for (const value of [{}, page(-1, 200), page(300, 200), page(0, Infinity)]) expect(addHistoryRange(ranges, value)).toBe(ranges);
    const newer = addHistoryRange(ranges, page(300, 400));
    const late = addHistoryRange(newer, page(300, 350));
    expect(latestHistoryGap(late)?.beforeCursor).toBe("300");
    expect(late.at(-1)?.end).toBe(400);
    expect(addHistoryRange(ranges, page(0, 100))[0]).toMatchObject({ start: 0, end: 200 });
  });
});
