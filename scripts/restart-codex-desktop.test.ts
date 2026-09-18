// @vitest-environment node

import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFile, execFileSync, spawn } from "node:child_process";
import { once } from "node:events";
import { promisify } from "node:util";
import { describe, expect, it } from "vitest";

const run = promisify(execFile);
const script = join(import.meta.dirname, "restart-codex-desktop.sh");

describe.skipIf(process.platform !== "darwin")("confirmed Desktop force restart", () => {
  it.each(["--execute", "--recover"])("%s restarts only the exact Desktop executable and reopens without a quit dialog", async (mode) => {
    const directory = mkdtempSync(join(tmpdir(), "codex-restart-test-"));
    const app = join(directory, "Desktop [QA].app");
    const executable = join(app, "Contents/MacOS/ChatGPT");
    const unrelatedExecutable = join(directory, "Other.app/Contents/MacOS/ChatGPT");
    const opened = join(directory, "opened");
    const curl = join(directory, "curl");
    const open = join(directory, "open");
    for (const file of [executable, unrelatedExecutable]) {
      mkdirSync(join(file, ".."), { recursive: true });
    }
    // Relocated Apple platform binaries can get stuck in macOS code validation.
    // Use a locally compiled process that also accepts Chromium-style arguments.
    execFileSync("clang", ["-x", "c", "-", "-o", executable], {
      input: "#include <unistd.h>\nint main(void) { for (;;) pause(); }\n",
    });
    copyFileSync(executable, unrelatedExecutable);
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
      await run(script, mode === "--recover" ? [mode, String(desktop.pid)] : [mode], { env, timeout: 8_000 });
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

  it("does not automatically restart a debug-enabled process or a different process", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-recovery-test-"));
    const app = join(directory, "Desktop.app");
    const executable = join(app, "Contents/MacOS/ChatGPT");
    const opened = join(directory, "opened");
    const open = join(directory, "open");
    mkdirSync(join(executable, ".."), { recursive: true });
    execFileSync("clang", ["-x", "c", "-", "-o", executable], {
      input: "#include <unistd.h>\nint main(void) { for (;;) pause(); }\n",
    });
    writeFileSync(open, '#!/bin/sh\ntouch "$CODEX_REMOTE_TEST_OPENED"\n', { mode: 0o755 });
    const desktop = spawn(executable, ["--remote-debugging-port=9229"]);
    const stopped = once(desktop, "exit");
    try {
      await once(desktop, "spawn");
      const env = {
        ...process.env, CODEX_DESKTOP_APP_PATH: app, CODEX_REMOTE_CURL_BIN: "/usr/bin/false",
        CODEX_REMOTE_OPEN_BIN: open, CODEX_REMOTE_TEST_OPENED: opened,
      };
      await run(script, ["--recover", String(desktop.pid)], { env, timeout: 2_000 });
      await run(script, ["--recover", String(process.pid)], { env, timeout: 2_000 });
      expect(desktop.signalCode).toBeNull();
      expect(() => readFileSync(opened)).toThrow();
    } finally {
      desktop.kill("SIGKILL");
      await stopped;
      rmSync(directory, { recursive: true, force: true });
    }
  }, 15_000);

  it("does not reopen Desktop if it exits between recovery validation and stopping", async () => {
    const directory = mkdtempSync(join(tmpdir(), "codex-recovery-exit-"));
    const app = join(directory, "Desktop.app");
    const executable = join(app, "Contents/MacOS/ChatGPT");
    const ps = join(directory, "ps");
    const curl = join(directory, "curl");
    const open = join(directory, "open");
    const opened = join(directory, "opened");
    mkdirSync(join(executable, ".."), { recursive: true });
    writeFileSync(executable, "#!/bin/sh\nexit 0\n", { mode: 0o755 });
    writeFileSync(ps, `#!/bin/sh
if test "$1" = "-ww"; then printf '%s\\n' "$CODEX_TEST_EXECUTABLE"; exit 0; fi
if ! test -f "$CODEX_TEST_SEEN"; then
  touch "$CODEX_TEST_SEEN"
  printf '%s 2147483647 %s\\n' "$(id -u)" "$CODEX_TEST_EXECUTABLE"
fi
`, { mode: 0o755 });
    writeFileSync(curl, '#!/bin/sh\ntest -f "$CODEX_TEST_OPENED"\n', { mode: 0o755 });
    writeFileSync(open, '#!/bin/sh\ntouch "$CODEX_TEST_OPENED"\n', { mode: 0o755 });
    try {
      await run(script, ["--recover", "2147483647"], {
        timeout: 2_000,
        env: { ...process.env, CODEX_DESKTOP_APP_PATH: app, CODEX_REMOTE_PS_BIN: ps,
          CODEX_REMOTE_CURL_BIN: curl, CODEX_REMOTE_OPEN_BIN: open,
          CODEX_TEST_EXECUTABLE: executable, CODEX_TEST_SEEN: join(directory, "seen"), CODEX_TEST_OPENED: opened },
      });
      expect(() => readFileSync(opened)).toThrow();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
