import { describe, expect, it } from "vitest";
import { summarizeBridgeEvidence } from "./verify-desktop-bridge";

describe("summarizeBridgeEvidence", () => {
  it("records counts and exact active thread/turn identifiers without content", () => {
    expect(summarizeBridgeEvidence(
      {
        data: [
          {
            id: "thread-active",
            status: { type: "active" },
            turns: [
              { id: "turn-old", status: "completed" },
              { id: "turn-live", status: "inProgress" },
            ],
          },
          { id: "thread-idle", status: { type: "idle" }, turns: [] },
        ],
      },
      { threadIds: ["thread-active", "thread-idle"] },
      "0.148.0-alpha.15",
    )).toEqual({
      ok: true,
      transport: "desktop-live",
      appServerVersion: "0.148.0-alpha.15",
      threadCount: 2,
      pinnedThreadCount: 2,
      active: [{ threadId: "thread-active", turnId: "turn-live" }],
    });
  });
});
