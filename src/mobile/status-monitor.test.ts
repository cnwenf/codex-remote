import { describe, expect, it } from "vitest";
import { compareTaskStatus, summarizeRunningTasks } from "./status-monitor";

describe("mobile task status monitor", () => {
  it("reports each running to terminal transition once", () => {
    const previous = [
      { id: "one", title: "First", status: "running" as const, updatedAt: 1 },
      { id: "two", title: "Second", status: "idle" as const, updatedAt: 1 },
    ];
    const current = [
      { id: "one", title: "First", status: "idle" as const, updatedAt: 2 },
      { id: "two", title: "Second", status: "idle" as const, updatedAt: 2 },
    ];

    expect(compareTaskStatus(previous, current)).toEqual([{ ...current[0], completion: "completed" }]);
    expect(compareTaskStatus(current, current)).toEqual([]);
  });

  it("summarizes only running tasks for lock-screen notification content", () => {
    expect(summarizeRunningTasks([
      { id: "one", title: "First", status: "running", updatedAt: 1 },
      { id: "two", title: "Second", status: "running", updatedAt: 1 },
      { id: "three", title: "Done", status: "idle", updatedAt: 1 },
    ])).toEqual({ title: "2 个对话运行中", body: "First、Second", threadIds: ["one", "two"] });
  });
});
