import assert from "node:assert/strict";
import { mkdtemp, open, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { monitorEventLoopDelay, performance } from "node:perf_hooks";
import { build } from "esbuild";

// Isolated generated data only. No Desktop process, SQLite or real session is touched.
const directory = await mkdtemp(join(tmpdir(), "codex-question-benchmark-"));
const rollout = join(directory, "rollout.jsonl");
const bundle = join(directory, "index.mjs");
const block = Buffer.alloc(64 * 1024, "a");
const scalarBytes = Number(process.env.QUESTION_BENCHMARK_SCALAR_MIB ?? 1024) * 1024 * 1024;
assert(Number.isSafeInteger(scalarBytes) && scalarBytes >= block.length);
let index;
let handle;
let sampleTimer;
let originalRead;
let handlePrototype;
const delay = monitorEventLoopDelay({ resolution: 10 });
try {
  await build({ entryPoints: ["src/gateway/question-index.ts"], outfile: bundle,
    bundle: true, platform: "node", format: "esm", logLevel: "silent" });
  const { QuestionIndex } = await import(pathToFileURL(bundle).href);
  handle = await open(rollout, "w");
  async function text(value) { await handle.write(value); }
  async function scalar() {
    for (let bytes = 0; bytes < scalarBytes; bytes += block.length) {
      await handle.write(block.subarray(0, Math.min(block.length, scalarBytes - bytes)));
    }
  }
  await text('{"type":"event_msg","payload":{"type":"task_started","turn_id":"long"}}\n');
  await text('{"type":"response_item","payload":{"type":"message","role":"user","content":[{"type":"input_image","image_url":"data:image/png;base64,');
  await scalar();
  await text('"},{"type":"input_text","text":"Original question outside the final history page"}],"id":"user-long","internal_chat_message_metadata_passthrough":{"turn_id":"long"}}}\n');
  await text('{"type":"response_item","payload":{"type":"function_call","call_id":"tool-long","arguments":"{}"}}\n');
  await text('{"type":"response_item","payload":{"type":"function_call_output","call_id":"tool-long","output":"');
  await scalar();
  await text('"}}\n');
  await text('{"type":"response_item","payload":{"type":"message","role":"assistant","content":[{"type":"output_text","text":"');
  await scalar();
  await text('"}],"id":"answer-long"}}\n');
  await text('{"type":"event_msg","payload":{"type":"task_complete","turn_id":"long"}}\n');
  const tail = (turn, user, answer) => [
    { type: "event_msg", payload: { type: "task_started", turn_id: turn } },
    { type: "response_item", payload: { id: user, type: "message", role: "user", content: [{ type: "input_text", text: "Tail question" }] } },
    { type: "response_item", payload: { id: answer, type: "message", role: "assistant", content: [{ type: "output_text", text: "Tail answer" }] } },
  ].map(value => JSON.stringify(value)).join("\n") + "\n";
  // Only this real task_started boundary makes the suffix authoritative. A
  // repeated turn_context below must not reset the original answer association.
  await text(tail("tail", "user-tail", "answer-tail"));
  await text([
    { type: "turn_context", payload: { turn_id: "tail" } },
    { type: "response_item", payload: { id: "user-steer", type: "message", role: "user", content: [{ type: "input_text", text: "Steering question" }] } },
    { type: "response_item", payload: { id: "answer-tail", type: "message", role: "assistant", content: [{ type: "output_text", text: "Original answer replay" }] } },
    { type: "response_item", payload: { id: "answer-steer", type: "message", role: "assistant", content: [{ type: "output_text", text: "Steering answer" }] } },
  ].map(value => JSON.stringify(value)).join("\n") + "\n");
  const fileBytes = (await handle.stat()).size;
  await handle.close(); handle = undefined;

  // Count actual async scan bytes, not inferred reads from elapsed time.
  const probe = await open(rollout, "r");
  handlePrototype = Object.getPrototypeOf(probe);
  originalRead = handlePrototype.read;
  let scanBytes = 0;
  handlePrototype.read = async function (...args) {
    const result = await originalRead.apply(this, args);
    scanBytes += result.bytesRead;
    return result;
  };
  await probe.close();
  index = new QuestionIndex(join(directory, "questions.sqlite"));
  const baselineRss = process.memoryUsage().rss;
  let peakRss = baselineRss;
  let timerTicks = 0;
  sampleTimer = setInterval(() => { timerTicks++; peakRss = Math.max(peakRss, process.memoryUsage().rss); }, 10);
  delay.enable();
  const request = { threadId: "benchmark", turnId: "tail", anchorItemId: "answer-steer" };
  const coldStarted = performance.now();
  assert.equal(index.read(rollout, request).state, "pending");
  async function waitReady(query) {
    const started = performance.now();
    for (;;) {
      const result = index.read(rollout, query);
      if (result.state === "ready") return result;
      assert.equal(result.state, "pending", JSON.stringify(result));
      assert(performance.now() - started < 120_000, "index did not complete within 120 seconds");
      await new Promise(resolve => setTimeout(resolve, 25));
    }
  }
  const ready = await waitReady(request);
  assert.equal(ready.question.id, "user-steer");
  assert.equal((await waitReady({ threadId: "benchmark", turnId: "tail" })).question?.id, "user-steer");
  assert.equal(index.read(rollout, { ...request, anchorItemId: "answer-tail" }).question?.id, "user-tail");
  const coldMs = performance.now() - coldStarted;
  const coldReadBytes = scanBytes;
  assert(coldReadBytes <= 1024 * 1024, "recent question lookup exceeded the bounded tail budget");
  const warmStarted = performance.now();
  for (let n = 0; n < 100; n++) assert.equal(index.read(rollout, request).state, "ready");
  const warm100Ms = performance.now() - warmStarted;
  const warmReadBytes = scanBytes - coldReadBytes;
  assert.equal(warmReadBytes, 0, "warm lookups rescanned the session");

  index.close();
  const reopenStarted = performance.now();
  index = new QuestionIndex(join(directory, "questions.sqlite"));
  assert.equal(index.read(rollout, request).question?.id, "user-steer");
  assert.equal(index.read(rollout, { threadId: "benchmark", turnId: "tail" }).question?.id, "user-steer");
  assert.equal(index.read(rollout, { ...request, anchorItemId: "answer-tail" }).question?.id, "user-tail");
  const reopenMs = performance.now() - reopenStarted;
  const reopenReadBytes = scanBytes - coldReadBytes;
  assert.equal(reopenReadBytes, 0, "reopening discarded the persisted recent question");

  const appended = tail("append", "user-append", "answer-append");
  handle = await open(rollout, "a"); await handle.write(appended); await handle.close(); handle = undefined;
  const appendStarted = performance.now();
  const next = await waitReady({ threadId: "benchmark", turnId: "append", anchorItemId: "answer-append" });
  assert.equal(next.question?.id, "user-append");
  await waitReady({ threadId: "benchmark", turnId: "append" });
  const appendMs = performance.now() - appendStarted;
  const appendReadBytes = scanBytes - coldReadBytes;
  assert.equal(appendReadBytes, Buffer.byteLength(appended));

  // History outside the suffix requires its own scan, never the latest question as a substitute.
  const oldRequest = { threadId: "benchmark", turnId: "long", anchorItemId: "answer-long" };
  const historicalStartBytes = scanBytes;
  const historicalStarted = performance.now();
  assert.equal(index.read(rollout, oldRequest).state, "pending");
  const old = await waitReady(oldRequest);
  assert.equal(old.question?.text, "Original question outside the final history page");
  assert.equal(old.question?.imageCount, 1);
  assert.equal(old.question?.id, "user-long");
  const originalAfterBackfill = index.read(rollout, { ...request, anchorItemId: "answer-tail" });
  assert.equal(originalAfterBackfill.question?.id, "user-tail");
  assert.equal(originalAfterBackfill.revision, ready.revision);
  assert.equal(index.read(rollout, request).question?.id, "user-steer");
  const historicalMs = performance.now() - historicalStarted;
  const historicalReadBytes = scanBytes - historicalStartBytes;
  assert(historicalReadBytes <= fileBytes + Buffer.byteLength(appended), "historical lookup rescanned bytes");
  assert(timerTicks > 0, "index scan blocked the event loop throughout");
  assert(peakRss - baselineRss < 128 * 1024 * 1024, "index RSS increased by more than 128 MiB");
  const ms = (value) => Math.round(value * 100) / 100;
  console.log(JSON.stringify({ fileBytes, coldReadBytes, coldMs: ms(coldMs), warmReadBytes, warm100Ms: ms(warm100Ms),
    reopenReadBytes, reopenMs: ms(reopenMs), appendReadBytes, appendMs: ms(appendMs),
    historicalReadBytes, historicalMs: ms(historicalMs), baselineRss, peakRss, rssIncreaseBytes: peakRss - baselineRss, timerTicks,
    eventLoopDelayMaxMs: Math.round(delay.max / 1e6), eventLoopDelayP99Ms: Math.round(delay.percentile(99) / 1e6) }, null, 2));
} finally {
  clearInterval(sampleTimer);
  delay.disable();
  index?.close();
  if (handle) await handle.close();
  if (originalRead) handlePrototype.read = originalRead;
  await rm(directory, { recursive: true, force: true });
}
