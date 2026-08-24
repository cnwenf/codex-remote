import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { AppServerTransport } from "../src/gateway/app-server-transport";
import { createGateway } from "../src/gateway/server";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const gateway = createGateway({
  host: "127.0.0.1",
  port: 4318,
  token: "e2e-token",
  allowedOrigins: ["http://127.0.0.1:4318"],
  staticDir: resolve(root, "dist"),
  defaultCwd: "/tmp/direct-conversation",
  transport: new AppServerTransport({
    binary: process.execPath,
    argsPrefix: [resolve(root, "tests/fixtures/fake-codex.mjs")],
  }),
});

await gateway.start();
process.stdout.write("Codex Remote test stack ready on 127.0.0.1:4318\n");

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await gateway.stop();
  process.exitCode = 0;
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
