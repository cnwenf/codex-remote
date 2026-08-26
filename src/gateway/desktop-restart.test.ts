// @vitest-environment node

import { describe, expect, it, vi } from "vitest";
import { createDesktopRestarter } from "./desktop-restart";

describe("Desktop one-time restart", () => {
  it("executes only the configured script with the one-shot argument", async () => {
    const execFile = vi.fn((_file, _args, _options, callback) => callback(null, "ready", ""));
    const restart = createDesktopRestarter({
      scriptPath: "/Applications/Codex Remote.app/Contents/Resources/restart-codex-desktop.sh",
      execFile,
    });

    await restart();

    expect(execFile).toHaveBeenCalledWith(
      "/Applications/Codex Remote.app/Contents/Resources/restart-codex-desktop.sh",
      ["--execute"],
      expect.objectContaining({ timeout: 90_000 }),
      expect.any(Function),
    );
  });
});
