// @vitest-environment node

import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { chmodSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const supportPath = join(dirname(fileURLToPath(import.meta.url)), "runtime-support.sh");
const desktopLauncherPath = join(dirname(fileURLToPath(import.meta.url)), "launch-codex-desktop.sh");

describe("Desktop runtime shell support", () => {
  it("uses an explicit executable Node runtime without embedding a user home path", () => {
    const result = spawnSync(
      "/bin/zsh",
      ["-c", `source ${JSON.stringify(supportPath)}; CODEX_NODE_BIN=/bin/sh resolve_node_bin`],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(0);
    expect(result.stdout.trim()).toBe("/bin/sh");
  });

  it("recognizes the Desktop executable when Chromium arguments follow it", () => {
    const result = spawnSync(
      "/bin/zsh",
      [
        "-c",
        `source ${JSON.stringify(supportPath)}; printf '%s\\n' '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT --remote-debugging-port=9229' | desktop_process_is_running '/Applications/ChatGPT.app/Contents/MacOS/ChatGPT'`,
      ],
      { encoding: "utf8" },
    );

    expect(result.status).toBe(0);
  });

  it("waits until a listening TCP port is released", async () => {
    const server = createServer();
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Expected TCP address");

    const child = spawn(
      "/bin/zsh",
      [
        "-c",
        `source ${JSON.stringify(supportPath)}; wait_for_tcp_port_release ${address.port} 40 0.02`,
      ],
      { stdio: "pipe" },
    );
    const exitPromise = once(child, "exit");
    await new Promise((resolve) => setTimeout(resolve, 80));
    server.close();
    await once(server, "close");

    const [status] = await exitPromise;
    expect(status).toBe(0);
  });

  it("waits for an existing Desktop process and launches it only once", () => {
    const root = mkdtempSync(join(tmpdir(), "codex-desktop-launcher-test-"));
    const app = join(root, "ChatGPT.app");
    const desktop = join(app, "Contents", "MacOS", "ChatGPT");
    const ps = join(root, "ps");
    const counter = join(root, "ps-count");
    const invocation = join(root, "desktop-invocation");
    mkdirSync(dirname(desktop), { recursive: true });
    writeFileSync(desktop, `#!/bin/sh\nprintf '%s\\n' "$@" > ${JSON.stringify(invocation)}\n`);
    writeFileSync(ps, `#!/bin/sh
count=0
test -f ${JSON.stringify(counter)} && count=$(cat ${JSON.stringify(counter)})
count=$((count + 1))
printf '%s\\n' "$count" > ${JSON.stringify(counter)}
if test "$count" -lt 3; then
  printf '%s\\n' ${JSON.stringify(desktop)}
fi
`);
    chmodSync(desktop, 0o755);
    chmodSync(ps, 0o755);

    try {
      const result = spawnSync("/bin/zsh", [desktopLauncherPath], {
        encoding: "utf8",
        env: {
          ...process.env,
          CODEX_DESKTOP_APP_PATH: app,
          CODEX_REMOTE_PS_BIN: ps,
          CODEX_REMOTE_DESKTOP_WAIT_SECONDS: "0.01",
          CODEX_REMOTE_CDP_PORT: "9333",
        },
      });
      expect(result.status).toBe(0);
      expect(readFileSync(counter, "utf8").trim()).toBe("3");
      expect(readFileSync(invocation, "utf8").trim().split("\n")).toEqual([
        "--remote-debugging-address=127.0.0.1",
        "--remote-debugging-port=9333",
      ]);
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
});
