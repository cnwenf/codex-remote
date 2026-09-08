import { fileURLToPath } from "node:url";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { AppServerTransport } from "../src/gateway/app-server-transport";
import { createGateway } from "../src/gateway/server";
import type { RpcMessage } from "../src/protocol/types";
import { verifyAndroidTestGateway } from "./verify-android-test-gateway";

const root = resolve(fileURLToPath(new URL("..", import.meta.url)));
const desktopMirrorFixture = process.env.CODEX_REMOTE_E2E_DESKTOP_MIRROR === "1";
const nativeMobileFixture = process.env.CODEX_REMOTE_E2E_NATIVE === "1";
const port = Number(process.env.CODEX_REMOTE_E2E_PORT ?? 4318);
const fixtureLongQuestion = "甲".repeat(4096) + "分页尾页";
const fixtureQuestions = new Map<string, { id: string; text: string; revision: string }>();
let fixtureQuestionRevision = 0;
await verifyAndroidTestGateway({ host: "127.0.0.1", port });
const imageUploadDir = await mkdtemp(join(tmpdir(), "codex-remote-e2e-images-"));
const transport = new AppServerTransport({
  binary: process.execPath,
  argsPrefix: [resolve(root, "tests/fixtures/fake-codex.mjs")],
}) as AppServerTransport & {
  getSessionInfo?: () => { transport: "desktop-cold"; readOnly: true };
};
const sendToAppServer = transport.send.bind(transport);
transport.send = (message) => {
  rememberFixtureQuestion(message);
  sendToAppServer(message);
};
if (desktopMirrorFixture) {
  transport.getSessionInfo = () => ({ transport: "desktop-cold", readOnly: true });
}
const desktopState = {
  request(method: string, params?: unknown) {
    if (method === "desktopState/readQuestionContext") {
      return fixtureQuestionContext(params);
    }
    if (method === "desktopState/listThreads") {
      if (!desktopMirrorFixture && !nativeMobileFixture) throw new Error("Desktop list fixture is disabled");
      return { data: [{
        id: desktopMirrorFixture ? "desktop-restart-fixture" : "fixture-thread",
        title: desktopMirrorFixture ? "Desktop restart fixture" : "Fixture task",
        cwd: "/tmp/codex-fixture",
        status: { type: desktopMirrorFixture ? "active" : "idle" },
        updatedAt: Date.now(),
      }] };
    }
    if (desktopMirrorFixture && method === "desktopState/readThread") {
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
};
const gateway = createGateway({
  host: "127.0.0.1",
  port,
  token: "e2e-token",
  allowedOrigins: [`http://127.0.0.1:${port}`],
  staticDir: resolve(root, "dist"),
  uploadDir: imageUploadDir,
  defaultCwd: "/tmp/direct-conversation",
  transport,
  desktopState,
  ...(desktopMirrorFixture ? {
    restartConfirmationToken: () => "e2e-restart-confirmation",
    restartDesktop: async () => undefined,
  } : {}),
});

await gateway.start();
process.stdout.write(`Codex Remote test stack ready on 127.0.0.1:${port}\n`);

let stopping = false;
async function stop() {
  if (stopping) return;
  stopping = true;
  try {
    await gateway.stop();
  } finally {
    await rm(imageUploadDir, { recursive: true, force: true });
  }
  process.exitCode = 0;
}

process.once("SIGINT", stop);
process.once("SIGTERM", stop);

function fixtureQuestionContext(value: unknown) {
  const request = value && typeof value === "object" ? value as {
    threadId?: string;
    turnId?: string;
    anchorItemId?: string;
    textOffset?: number;
  } : {};
  const anchor = request.anchorItemId ?? "";
  const historyIndex = /^agent-(\d+)$/.exec(anchor)?.[1];
  const liveQuestion = request.threadId && request.turnId
    ? fixtureQuestions.get(`${request.threadId}\u0000${request.turnId}`)
    : undefined;
  const wholeText = request.threadId === "fixture-question-context-thread" && anchor === "fixture-paginated-agent"
    ? fixtureLongQuestion
    : historyIndex !== undefined
    ? `Follow-up instruction ${Number(historyIndex) + 1}`
    : anchor === "history-reason" || anchor === "history-progress" || anchor === "history-command" || anchor === "history-agent"
      ? "Inspect the fixture"
      : liveQuestion?.text;
  if (!wholeText || !request.threadId || !request.turnId) {
    return { ...request, state: "not_found", revision: `fixture:${anchor}:missing` };
  }
  const textOffset = request.textOffset ?? 0;
  const text = wholeText.slice(textOffset, textOffset + 4096);
  const nextTextOffset = textOffset + text.length < wholeText.length ? textOffset + text.length : undefined;
  const id = request.threadId === "fixture-question-context-thread" && anchor === "fixture-paginated-agent"
    ? "fixture-hidden-long-question"
    : historyIndex !== undefined ? `user-${historyIndex}` : anchor.startsWith("history-") ? "history-user" : liveQuestion!.id;
  return {
    threadId: request.threadId,
    turnId: request.turnId,
    ...(request.anchorItemId ? { anchorItemId: request.anchorItemId } : {}),
    state: "ready",
    revision: liveQuestion?.revision ?? `fixture:${anchor}:ready`,
    question: {
      id,
      text,
      imageCount: 0,
      source: "user",
      truncated: nextTextOffset !== undefined,
      textOffset,
      ...(nextTextOffset === undefined ? {} : { nextTextOffset }),
    },
  };
}

function rememberFixtureQuestion(message: RpcMessage) {
  if (!("method" in message) || (message.method !== "turn/start" && message.method !== "turn/steer")) return;
  const params = message.params as {
    threadId?: string;
    input?: Array<{ type?: string; text?: string }>;
  } | undefined;
  const text = params?.input?.find((item) => item.type === "text")?.text;
  if (!params?.threadId || !text) return;
  fixtureQuestionRevision += 1;
  const question = {
    id: message.method === "turn/steer"
      ? "fixture-official-steer"
      : text === "Finish a compact mobile turn"
      ? "fixture-compact-user"
      : text === "Finish a late commentary turn" ? "fixture-late-commentary-user" : "fixture-live-user",
    text,
    revision: `fixture:live:${fixtureQuestionRevision}`,
  };
  fixtureQuestions.set(`${params.threadId}\u0000fixture-live-turn`, question);
  if (message.method === "turn/steer") {
    fixtureQuestions.set(`${params.threadId}\u0000fixture-steer-confirmation`, question);
  }
}
