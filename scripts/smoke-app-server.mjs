import { spawn } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { delimiter, join } from "node:path";

const binary = resolveBinary();
const cwd = await mkdtemp(join(tmpdir(), "codex-local-smoke-"));
const child = spawn(binary, ["app-server", "--listen", "stdio://"], {
  cwd,
  env: process.env,
  shell: false,
  stdio: ["pipe", "pipe", "pipe"],
});

let buffer = "";
const pending = new Map();
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  buffer += chunk;
  let newline = buffer.indexOf("\n");
  while (newline >= 0) {
    const line = buffer.slice(0, newline).trim();
    buffer = buffer.slice(newline + 1);
    if (line) {
      const message = JSON.parse(line);
      const waiter = pending.get(message.id);
      if (waiter) {
        pending.delete(message.id);
        waiter(message);
      }
    }
    newline = buffer.indexOf("\n");
  }
});

try {
  const initialized = await request(1, "initialize", {
    clientInfo: { name: "codex-remote-smoke", title: "Codex Remote Smoke", version: "0.1.0" },
    capabilities: { experimentalApi: true },
  });
  if (initialized.error) throw new Error("initialize returned an error");
  const listed = await request(2, "thread/list", { limit: 5, sortKey: "updated_at" });
  if (listed.error || !Array.isArray(listed.result?.data)) {
    throw new Error("thread/list returned an unexpected response");
  }
  process.stdout.write(`Real App Server smoke passed (${listed.result.data.length} threads)\n`);
} finally {
  await stopChild();
}

function request(id, method, params) {
  return new Promise((resolveRequest, rejectRequest) => {
    const timeout = setTimeout(() => {
      pending.delete(id);
      rejectRequest(new Error(`${method} timed out`));
    }, 20_000);
    pending.set(id, (message) => {
      clearTimeout(timeout);
      resolveRequest(message);
    });
    child.stdin.write(`${JSON.stringify({ id, method, params })}\n`);
  });
}

function stopChild() {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve();
  return new Promise((resolveStop) => {
    const force = setTimeout(() => child.kill("SIGKILL"), 2_000);
    child.once("exit", () => {
      clearTimeout(force);
      resolveStop();
    });
    child.kill("SIGTERM");
  });
}

function resolveBinary() {
  if (process.env.CODEX_BIN) {
    if (!existsSync(process.env.CODEX_BIN)) throw new Error("CODEX_BIN does not exist");
    return process.env.CODEX_BIN;
  }
  for (const directory of process.env.PATH?.split(delimiter) ?? []) {
    const candidate = join(directory, "codex");
    if (existsSync(candidate)) return candidate;
  }
  const bundled = "/Applications/ChatGPT.app/Contents/Resources/codex";
  if (existsSync(bundled)) return bundled;
  throw new Error("Codex binary not found");
}
