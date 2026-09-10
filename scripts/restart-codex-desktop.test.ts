// @vitest-environment node

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const script = join(import.meta.dirname, "restart-codex-desktop.sh");

describe.skipIf(process.platform !== "darwin")("confirmed Desktop force restart", () => {
  it("kills only the exact Desktop executable and reopens without a quit dialog", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-restart-test-"));
    const app = join(directory, "Desktop [QA].app");
    const executable = join(app, "Contents/MacOS/ChatGPT");
    const unrelatedExecutable = join(directory, "Other.app/Contents/MacOS/ChatGPT");
    const opened = join(directory, "opened");
    const curl = join(directory, "curl");
    const open = join(directory, "open");
    for (const file of [executable, unrelatedExecutable]) {
      mkdirSync(join(file, ".."), { recursive: true });
      copyFileSync("/bin/sleep", file);
    }
    writeFileSync(curl, '#!/bin/sh\ntest -f "$CODEX_REMOTE_TEST_OPENED"\n', { mode: 0o755 });
    writeFileSync(open, '#!/bin/sh\nprintf "%s\\n" "$@" > "$CODEX_REMOTE_TEST_OPENED"\n', { mode: 0o755 });
    const desktop = spawn(executable, ["120"]);
    const unrelated = spawn(unrelatedExecutable, ["120"]);
    const stopped = once(desktop, "exit");
    const unrelatedStopped = once(unrelated, "exit");
    try {
      await Promise.all([once(desktop, "spawn"), once(unrelated, "spawn")]);
      const env = {
        ...process.env,
        CODEX_DESKTOP_APP_PATH: app,
        CODEX_REMOTE_CURL_BIN: curl,
        CODEX_REMOTE_OPEN_BIN: open,
        CODEX_REMOTE_TEST_OPENED: opened,
        CODEX_REMOTE_CDP_PORT: "9229",
      };
      // A health check must never stop either process.
      await expect(run(script, ["--check"], { env })).rejects.toMatchObject({ code: 1 });
      expect(desktop.signalCode).toBeNull();
      await run(script, ["--execute"], { env, timeout: 8_000 });
      expect(await Promise.race([
        stopped,
        new Promise((resolve) => { setTimeout(() => resolve("still running"), 1_000).unref(); }),
      ])).toEqual([null, "SIGKILL"]);
      expect(unrelated.signalCode).toBeNull();
      expect(readFileSync(opened, "utf8").trim().split("\n")).toEqual([
        "-na", app, "--args", "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=9229",
      ]);
      expect(readFileSync(script, "utf8")).not.toContain("osascript");
    } finally {
      desktop.kill("SIGKILL");
      unrelated.kill("SIGKILL");
      await Promise.all([stopped, unrelatedStopped]);
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);
});
