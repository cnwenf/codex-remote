// @vitest-environment node

import { describe, expect, it } from "vitest";
import { projectMobileStatus } from "./mobile-status";

describe("mobile status projection", () => {
  it("returns bounded task metadata and drops content, paths, settings, and unknown records", () => {
    const result = projectMobileStatus({
      data: [
        {
          id: "running",
          title: "Build mobile app",
          status: "running",
          updatedAt: 20,
          cwd: "/private/project",
          model: "secret-provider-model",
          turns: [{ items: [{ text: "private prompt" }] }],
        },
        { id: "idle", name: "Finished", status: { type: "idle" }, updated_at: 10 },
        { title: "Missing id", status: "running" },
      ],
    }, 123);

    expect(result).toEqual({
      version: 1,
      generatedAt: 123,
      threads: [
        { id: "running", title: "Build mobile app", status: "running", updatedAt: 20 },
        { id: "idle", title: "Finished", status: "idle", updatedAt: 10 },
      ],
    });
    expect(JSON.stringify(result)).not.toMatch(/private|secret-provider|turns|cwd/);
  });
});
