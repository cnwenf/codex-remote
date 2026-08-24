import { mkdirSync, writeFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { DesktopBridgeTransport } from "../src/gateway/desktop-bridge-transport";
import { DesktopCdpClient } from "../src/gateway/desktop-cdp-client";
import type { RpcId, RpcMessage } from "../src/protocol/types";

type Evidence = {
  ok: true;
  transport: "desktop-live";
  appServerVersion: string;
  threadCount: number;
  pinnedThreadCount: number;
  active: Array<{ threadId: string; turnId?: string }>;
};

export function summarizeBridgeEvidence(
  threadListValue: unknown,
  pinnedValue: unknown,
  appServerVersion: string,
): Evidence {
  const threads = arrayValue(recordValue(threadListValue).data);
  const pinnedThreadIds = arrayValue(recordValue(pinnedValue).threadIds)
    .filter((value): value is string => typeof value === "string");
  const active = threads.flatMap((value) => {
    const thread = recordValue(value);
    const threadId = stringValue(thread.id);
    const status = stringValue(thread.status) ?? stringValue(recordValue(thread.status).type);
    if (!threadId || (status !== "active" && status !== "running")) return [];
    const turns = arrayValue(thread.turns).map(recordValue);
    const liveTurn = [...turns].reverse().find((turn) => stringValue(turn.status) === "inProgress");
    const turnId = stringValue(liveTurn?.id);
    return [{ threadId, ...(turnId ? { turnId } : {}) }];
  });
  return {
    ok: true,
    transport: "desktop-live",
    appServerVersion,
    threadCount: threads.length,
    pinnedThreadCount: pinnedThreadIds.length,
    active,
  };
}

async function verifyOnce(endpoint: string, appServerVersion: string): Promise<Evidence> {
  const pending = new Map<RpcId, {
    resolve: (value: unknown) => void;
    reject: (error: Error) => void;
  }>();
  const transport = new DesktopBridgeTransport({
    client: new DesktopCdpClient({ endpoint, timeoutMs: 3_000 }),
    appServerVersion,
  });
  await transport.start((message) => {
    if (!("id" in message) || "method" in message) return;
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  }, () => undefined);

  const request = (id: RpcId, method: string, params: unknown) => new Promise<unknown>(
    (resolveRequest, rejectRequest) => {
      pending.set(id, { resolve: resolveRequest, reject: rejectRequest });
      transport.send({ id, method, params });
    },
  );

  try {
    const [threads, pins] = await withTimeout(Promise.all([
      request("verify-threads", "thread/list", {
        limit: 500,
        sortKey: "updated_at",
        includeTurns: true,
      }),
      request("verify-pins", "desktop/listPinnedThreads", {}),
    ]), 5_000, "desktop-bridge-verification-timeout");
    return summarizeBridgeEvidence(threads, pins, appServerVersion);
  } finally {
    await transport.stop();
  }
}

async function run() {
  const args = parseArgs(process.argv.slice(2));
  const deadline = Date.now() + args.timeoutMs;
  let lastError = "Desktop bridge was not reachable";
  while (Date.now() < deadline) {
    try {
      const evidence = await verifyOnce(args.endpoint, args.appServerVersion);
      writeEvidence(args.output, { ...evidence, verifiedAt: new Date().toISOString() });
      return;
    } catch (cause) {
      lastError = cause instanceof Error ? cause.message : "Desktop bridge verification failed";
      await new Promise((resolveDelay) => setTimeout(resolveDelay, 1_000));
    }
  }
  writeEvidence(args.output, {
    ok: false,
    error: lastError,
    verifiedAt: new Date().toISOString(),
  });
  process.exitCode = 1;
}

function parseArgs(args: string[]) {
  const values = new Map<string, string>();
  for (let index = 0; index < args.length; index += 2) {
    const key = args[index];
    const value = args[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error("invalid-verifier-arguments");
    values.set(key, value);
  }
  const endpoint = values.get("--endpoint") ?? "http://127.0.0.1:9229";
  const appServerVersion = values.get("--app-server-version");
  const output = values.get("--output");
  if (!appServerVersion || !output) throw new Error("verifier-version-and-output-required");
  const timeoutMs = Number.parseInt(values.get("--timeout-ms") ?? "90000", 10);
  if (!Number.isInteger(timeoutMs) || timeoutMs < 1_000 || timeoutMs > 300_000) {
    throw new Error("invalid-verifier-timeout");
  }
  return { endpoint, appServerVersion, output: resolve(output), timeoutMs };
}

function writeEvidence(path: string, value: unknown) {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, { mode: 0o600 });
}

function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string) {
  return new Promise<T>((resolvePromise, rejectPromise) => {
    const timeout = setTimeout(() => rejectPromise(new Error(message)), timeoutMs);
    promise.then(
      (value) => { clearTimeout(timeout); resolvePromise(value); },
      (error) => { clearTimeout(timeout); rejectPromise(error); },
    );
  });
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" ? value as Record<string, unknown> : {};
}

function arrayValue(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

function stringValue(value: unknown) {
  return typeof value === "string" ? value : undefined;
}

if (process.argv[1] && import.meta.url === pathToFileURL(resolve(process.argv[1])).href) {
  void run();
}
