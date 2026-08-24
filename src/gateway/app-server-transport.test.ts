// @vitest-environment node

import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { AppServerTransport } from "./app-server-transport";

const fixture = fileURLToPath(
  new URL("../../tests/fixtures/fake-codex.mjs", import.meta.url),
);

async function waitFor(check: () => boolean, timeoutMs = 5_000) {
  const deadline = Date.now() + timeoutMs;
  while (!check()) {
    if (Date.now() > deadline) {
      throw new Error("timed-out-waiting-for-fixture");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("AppServerTransport", () => {
  it("emits each complete JSONL frame", async () => {
    const received: unknown[] = [];
    const transport = new AppServerTransport({
      binary: process.execPath,
      argsPrefix: [fixture],
    });

    await transport.start(
      (message) => received.push(message),
      () => undefined,
    );
    transport.send({ id: 1, method: "initialize", params: {} });
    await waitFor(() => received.length === 1);

    expect(received[0]).toMatchObject({ id: 1, result: { ready: true } });
    await transport.stop();
  });

  it("never includes stderr content in diagnostics", async () => {
    const diagnostics: string[] = [];
    const transport = new AppServerTransport({
      binary: process.execPath,
      argsPrefix: ["-e", "process.stderr.write('secret-command')"],
    });

    await transport.start(
      () => undefined,
      (diagnostic) => diagnostics.push(diagnostic.message),
    );
    await waitFor(() => diagnostics.length > 0);

    expect(diagnostics.join(" ")).not.toContain("secret-command");
    await transport.stop();
  });
});
