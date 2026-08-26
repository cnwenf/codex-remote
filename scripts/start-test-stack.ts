import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { AppServerTransport } from "../src/gateway/app-server-transport";
import { createGateway } from "../src/gateway/server";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const desktopMirrorFixture = process.env.CODEX_REMOTE_E2E_DESKTOP_MIRROR === "1";
const port = Number(process.env.CODEX_REMOTE_E2E_PORT ?? 4318);
const transport = new AppServerTransport({
  binary: process.execPath,
  argsPrefix: [resolve(root, "tests/fixtures/fake-codex.mjs")],
}) as AppServerTransport & {
  getSessionInfo?: () => { transport: "desktop-cold"; readOnly: true };
};
if (desktopMirrorFixture) {
  transport.getSessionInfo = () => ({ transport: "desktop-cold", readOnly: true });
}
const gateway = createGateway({
  host: "127.0.0.1",
  port,
  token: "e2e-token",
  allowedOrigins: ["http://127.0.0.1:4318"],
  staticDir: resolve(root, "dist"),
  defaultCwd: "/tmp/direct-conversation",
  transport,
  ...(desktopMirrorFixture ? {
    restartConfirmationToken: () => "e2e-restart-confirmation",
    restartDesktop: async () => undefined,
    desktopState: {
      request(method: string) {
        if (method === "desktopState/listThreads") {
          return { data: [{
            id: "desktop-restart-fixture",
            title: "Desktop restart fixture",
            cwd: "/tmp/codex-fixture",
            updatedAt: Date.now(),
          }] };
        }
        if (method === "desktopState/readThread") {
          return {
            desktopMirror: true,
            thread: {
              id: "desktop-restart-fixture",
              name: "Desktop restart fixture",
              cwd: "/tmp/codex-fixture",
              status: { type: "active" },
              turns: [{
                id: "desktop-turn",
                status: "inProgress",
                items: [{ id: "agent-1", type: "agentMessage", text: "Desktop snapshot" }],
              }],
            },
          };
        }
        throw new Error(`Unsupported Desktop fixture method: ${method}`);
      },
      close() {},
    },
  } : {}),
});

await gateway.start();
process.stdout.write(`Codex Remote test stack ready on 127.0.0.1:${port}\n`);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await gateway.stop();
  process.exitCode = 0;
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
