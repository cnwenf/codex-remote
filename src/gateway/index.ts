import { existsSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { AppServerTransport } from "./app-server-transport";
import { parseAdditionalBindHosts } from "./bind-hosts";
import { resolveCodexBinary } from "./codex-binary";
import { DesktopBridgeTransport } from "./desktop-bridge-transport";
import { DesktopCdpClient } from "./desktop-cdp-client";
import { DesktopState } from "./desktop-state";
import { createGateway } from "./server";

const token = process.env.CODEX_WEB_TOKEN;
if (!token) throw new Error("CODEX_WEB_TOKEN is required");

const host = process.env.BIND_HOST ?? "127.0.0.1";
const additionalHosts = parseAdditionalBindHosts(process.env.ADDITIONAL_BIND_HOSTS);
const port = Number.parseInt(process.env.PORT ?? "4321", 10);
if (!Number.isInteger(port) || port < 0 || port > 65_535) {
  throw new Error("PORT must be an integer between 0 and 65535");
}
const codexHome = process.env.CODEX_HOME ?? join(homedir(), ".codex");
const desktopCdpEndpoint = process.env.CODEX_DESKTOP_CDP_ENDPOINT;
const desktopAppServerVersion = process.env.CODEX_DESKTOP_APP_SERVER_VERSION;
if (desktopCdpEndpoint && !desktopAppServerVersion) {
  throw new Error("CODEX_DESKTOP_APP_SERVER_VERSION is required with CODEX_DESKTOP_CDP_ENDPOINT");
}

const transport = desktopCdpEndpoint
  ? new DesktopBridgeTransport({
      client: new DesktopCdpClient({ endpoint: desktopCdpEndpoint }),
      appServerVersion: desktopAppServerVersion as string,
    })
  : new AppServerTransport({
      binary: resolveCodexBinary(
        { CODEX_BIN: process.env.CODEX_BIN, PATH: process.env.PATH },
        existsSync,
      ),
      cwd: process.cwd(),
      env: process.env,
    });

const gateway = createGateway({
  host,
  additionalHosts,
  port,
  token,
  allowedOrigins: process.env.ALLOWED_ORIGINS?.split(",").map((value) => value.trim()),
  staticDir: resolve("dist"),
  defaultCwd: process.cwd(),
  desktopState: new DesktopState(join(codexHome, "state_5.sqlite")),
  transport,
});

const address = await gateway.start();
const listeningAddresses = [address.address, ...additionalHosts]
  .map((listeningHost) => `${listeningHost}:${address.port}`)
  .join(", ");
process.stdout.write(`Codex Remote listening on ${listeningAddresses}\n`);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  await gateway.stop();
  process.exitCode = 0;
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);
