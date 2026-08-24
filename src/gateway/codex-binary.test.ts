// @vitest-environment node

import { describe, expect, it } from "vitest";
import { resolveCodexBinary } from "./codex-binary";

describe("resolveCodexBinary", () => {
  it("prefers an explicit CODEX_BIN", () => {
    expect(
      resolveCodexBinary(
        { CODEX_BIN: "/tmp/codex", PATH: "/usr/bin" },
        (path) => path === "/tmp/codex",
      ),
    ).toBe("/tmp/codex");
  });

  it("rejects a missing explicit binary instead of silently changing it", () => {
    expect(() =>
      resolveCodexBinary({ CODEX_BIN: "/missing/codex" }, () => false),
    ).toThrow("configured-codex-binary-not-found");
  });

  it("finds codex on PATH before the bundled application binary", () => {
    expect(
      resolveCodexBinary({ PATH: "/one:/two" }, (path) => path === "/two/codex"),
    ).toBe("/two/codex");
  });
});
