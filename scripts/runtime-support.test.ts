// @vitest-environment node

import { spawn, spawnSync } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:net";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";

const supportPath = join(dirname(fileURLToPath(import.meta.url)), "runtime-support.sh");

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
});
