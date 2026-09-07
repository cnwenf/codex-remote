// @vitest-environment node
import { appendFileSync, mkdtempSync, renameSync, rmSync, writeFileSync, readdirSync, statSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { open } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { QuestionIndex } from "./question-index";
import type { QuestionContextRequest } from "../protocol/question-context";

const resources: Array<{ index: QuestionIndex; dir: string }> = [];
afterEach(() => { for (const r of resources.splice(0)) { r.index.close(); rmSync(r.dir, { recursive: true, force: true }); } });
const context = { type: "turn_context", payload: { turn_id: "turn-1" } };
const message = (id: string, role: string, text: string) => ({ type: "response_item", payload: { type: "message", id, role, content: [{ type: role === "user" ? "input_text" : "output_text", text }] } });
const lines = (items: unknown[]) => items.map((item) => JSON.stringify(item)).join("\n") + "\n";
function fixture(items: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), "question-index-"));
  const path = join(dir, "rollout.jsonl");
  writeFileSync(path, lines(items));
  const index = new QuestionIndex(join(dir, "questions.sqlite"));
  resources.push({ index, dir });
  return { index, path, dir };
}
const request = { threadId: "t", turnId: "turn-1", anchorItemId: "a1" };
async function ready(index: QuestionIndex, path: string, req: QuestionContextRequest = request) {
  await vi.waitFor(() => expect(index.read(path, req).state).toBe("ready"));
  return index.read(path, req);
}

describe("persistent question index", () => {
  it("returns pending immediately then isolates answers around same-turn identical inputs", async () => {
    const { index, path } = fixture([context, message("u1", "user", "same"), message("a1", "assistant", "answer"), message("u2", "user", "same"), message("a2", "assistant", "second")]);
    expect(index.read(path, request).state).toBe("pending");
    expect(await ready(index, path)).toMatchObject({ question: { id: "u1", text: "same", source: "user" } });
    expect(await ready(index, path, { ...request, anchorItemId: "a2" })).toMatchObject({ question: { id: "u2" } });
    expect(index.read(path, { ...request, turnId: "other" }).state).toBe("not_found");
  });
  it("retains only small identity rows for giant tool and assistant output", async () => {
    const { index, path } = fixture([context, message("u1", "user", "question"),
      { type: "response_item", payload: { type: "function_call", call_id: "tool", id: "call", arguments: "x".repeat(2 ** 22) } },
      { type: "response_item", payload: { type: "function_call_output", call_id: "tool", output: "x".repeat(2 ** 22) } }, message("a1", "assistant", "answer")]);
    expect(await ready(index, path, { ...request, anchorItemId: "tool" })).toMatchObject({ question: { id: "u1" } });
  });
  it("resumes append after a half-record and persists progress across reopen", async () => {
    const { index, path, dir } = fixture([context, message("u1", "user", "first"), message("a1", "assistant", "answer")]);
    await ready(index, path);
    const partial = JSON.stringify(message("u2", "user", "second"));
    appendFileSync(path, partial.slice(0, -2));
    expect(index.read(path, { ...request, anchorItemId: "a2" }).state).toBe("pending");
    await vi.waitFor(() => expect(index.read(path, { ...request, anchorItemId: "a2" }).state).toBe("not_found"));
    appendFileSync(path, partial.slice(-2) + "\n" + lines([message("a2", "assistant", "answer")]));
    expect(await ready(index, path, { ...request, anchorItemId: "a2" })).toMatchObject({ question: { id: "u2" } });
    index.close();
    const reopened = new QuestionIndex(join(dir, "questions.sqlite"));
    resources.push({ index: reopened, dir });
    expect(reopened.read(path, request)).toMatchObject({ state: "ready", question: { id: "u1" } });
  });
  it.each(["truncate", "replace"])("invalidates old generation after %s", async (operation) => {
    const { index, path } = fixture([context, message("u1", "user", "old"), message("a1", "assistant", "answer")]);
    const old = await ready(index, path);
    if (operation === "replace") renameSync(path, path + ".old");
    writeFileSync(path, lines([context, message("u3", "user", "new"), message("a1", "assistant", "a")]));
    expect(index.read(path, request).state).toBe("pending");
    const next = await ready(index, path);
    expect(next.question?.id).toBe("u3");
    expect(next.revision).not.toBe(old.revision);
  });
  it("returns bounded continuation of exactly the anchored question", async () => {
    const { index, path } = fixture([context, message("u1", "user", "甲".repeat(4096) + "尾页"), message("a1", "assistant", "answer"), message("u2", "user", "newer")]);
    expect(await ready(index, path)).toMatchObject({ question: { text: "甲".repeat(4096), nextTextOffset: 4096, truncated: true } });
    const req = { ...request, textOffset: 4096 };
    expect(await ready(index, path, req)).toMatchObject({ question: { id: "u1", text: "尾页", textOffset: 4096, truncated: false } });
  });
  it("keeps known anchors ready but waits before claiming latest during append", async () => {
    const { index, path } = fixture([context, message("u1", "user", "first"), message("a1", "assistant", "answer")]);
    await ready(index, path);
    appendFileSync(path, lines([message("u2", "user", "second"), message("a2", "assistant", "answer")]));
    expect(index.read(path, { threadId: "t", turnId: "turn-1" }).state).toBe("pending");
    expect(index.read(path, request)).toMatchObject({ state: "ready", question: { id: "u1" } });
    await vi.waitFor(() => expect(index.read(path, { threadId: "t", turnId: "turn-1" })).toMatchObject({ state: "ready", question: { id: "u2" } }));
  });
  it("isolates late delegated replay and duplicate anchor completion from newer steering", async () => {
    const delegated = { type: "function_call_output", id: "d1", namespace: "codex_app", name: "send_message_to_thread",
      output: "<codex_delegation><source_thread_id>00000000-0000-4000-8000-000000000001</source_thread_id><input>delegated</input></codex_delegation>" };
    const { index, path } = fixture([context, { type: "response_item", payload: delegated }, message("a1", "assistant", "answer"),
      message("u2", "user", "second"), { type: "event_msg", payload: { type: "item_completed", turn_id: "turn-1", item: { ...delegated, type: "FunctionCallOutput" } } },
      { type: "event_msg", payload: { type: "item_completed", turn_id: "turn-1", item: { id: "a1", type: "AgentMessage", text: "answer" } } }, message("a2", "assistant", "answer")]);
    expect(await ready(index, path)).toMatchObject({ question: { id: "d1", source: "delegated" } });
    expect(await ready(index, path, { ...request, anchorItemId: "a2" })).toMatchObject({ question: { id: "u2" } });
  });
  it("does not let a completed replay with no canonical input become new steering", async () => {
    const { index, path } = fixture([context, message("u1", "user", "first"),
      { type: "event_msg", payload: { type: "item_completed", turn_id: "turn-1", item: { type: "FunctionCallOutput", id: "replay", namespace: "codex_app", name: "send_message_to_thread", output: "<codex_delegation><source_thread_id>00000000-0000-4000-8000-000000000001</source_thread_id><input>unknown older input</input></codex_delegation>" } } },
      message("a1", "assistant", "answer")]);
    expect(await ready(index, path)).toMatchObject({ question: { id: "u1" } });
  });
  it("rebuilds a corrupt private database and preserves the original for recovery", async () => {
    const { index, path, dir } = fixture([context, message("u1", "user", "first"), message("a1", "assistant", "answer")]);
    index.close();
    writeFileSync(join(dir, "questions.sqlite"), "broken cache");
    const rebuilt = new QuestionIndex(join(dir, "questions.sqlite"));
    resources.push({ index: rebuilt, dir });
    expect(await ready(rebuilt, path)).toMatchObject({ question: { id: "u1" } });
    expect(readdirSync(dir).some((name) => name.startsWith("questions.sqlite.corrupt-"))).toBe(true);
  });
  it("persists only bounded question text and resumes after the last complete byte", async () => {
    const { index, path, dir } = fixture([context, message("u1", "user", "question"), message("a1", "assistant", "x".repeat(2 ** 22))]);
    await ready(index, path);
    const db = new DatabaseSync(join(dir, "questions.sqlite"), { readOnly: true });
    try {
      expect(db.prepare("SELECT scanned FROM question_files").get()).toMatchObject({ scanned: statSync(path).size });
      expect(db.prepare("SELECT text FROM questions").all()).toEqual([{ text: "question" }]);
      expect(statSync(join(dir, "questions.sqlite")).size).toBeLessThan(128 * 1024);
    } finally { db.close(); }
  });
  it("does not infer a new answer across a corrupt possible steering record", async () => {
    const { index, path } = fixture([context, message("u1", "user", "first"), message("a1", "assistant", "answer")]);
    await ready(index, path);
    appendFileSync(path, '{"type":"response_item","payload":{"role":"user","id":"u2"BROKEN}\n' + lines([message("a2", "assistant", "answer")]));
    await vi.waitFor(() => expect(index.read(path, { ...request, anchorItemId: "a2" }).state).toBe("not_found"));
    expect(index.read(path, request)).toMatchObject({ state: "ready", question: { id: "u1" } });
  });
  it("streams a 65 MiB single image record, reads identities after it, and yields to timers", async () => {
    const { index, path } = fixture([context]);
    appendFileSync(path, '{"type":"response_item","payload":{"content":[{"image_url":"data:image/png;base64,');
    const chunk = Buffer.alloc(65536, 97);
    for (let n = 0; n < 1040; n++) appendFileSync(path, chunk);
    appendFileSync(path, '\",\"type\":\"input_image\"}],\"role\":\"user\",\"id\":\"image-user\",\"type\":\"message\",\"internal_chat_message_metadata_passthrough\":{\"turn_id\":\"turn-1\"}}}\n' + lines([message("a1", "assistant", "image answer")]));
    let ticks = 0;
    const timer = setInterval(() => { ticks++; }, 0);
    try {
      expect(index.read(path, request).state).toBe("pending");
      await vi.waitFor(() => expect(index.read(path, request)).toMatchObject({ state: "ready", question: { id: "image-user", text: "", imageCount: 1 } }), { timeout: 10000 });
      expect(ticks).toBeGreaterThan(2);
    } finally { clearInterval(timer); }
  }, 15000);
  it("discards an in-flight old generation after replacement", async () => {
    const { index, path } = fixture([context, message("old-user", "user", "old"), message("a1", "assistant", "x".repeat(2 ** 22))]);
    const oldRevision = index.read(path, request).revision;
    renameSync(path, path + ".old");
    writeFileSync(path, lines([context, message("new-user", "user", "new"), message("a1", "assistant", "answer")]));
    const result = await ready(index, path);
    expect(result.revision).not.toBe(oldRevision);
    expect(result.question?.id).toBe("new-user");
  });
  it("reads only appended bytes after a completed large prefix", async () => {
    const { index, path } = fixture([context, message("u1", "user", "first"), message("a1", "assistant", "x".repeat(2 ** 22))]);
    await ready(index, path);
    const handle = await open(path, "r");
    const reads = vi.spyOn(Object.getPrototypeOf(handle), "read");
    try {
      const appended = lines([message("u2", "user", "second"), message("a2", "assistant", "answer")]);
      appendFileSync(path, appended);
      expect(await ready(index, path, { ...request, anchorItemId: "a2" })).toMatchObject({ question: { id: "u2" } });
      // The spy delegates to real FileHandle reads: this detects a prefix rescan.
      expect(reads.mock.calls.reduce((sum, args) => sum + Number(args[2]), 0)).toBe(Buffer.byteLength(appended));
    } finally { reads.mockRestore(); await handle.close(); }
  });
  it("keeps continuation EIO scoped to its page and clears it with the generation", async () => {
    const { index, path } = fixture([context, message("u1", "user", "x".repeat(5000)), message("a1", "assistant", "answer")]);
    const original = await ready(index, path);
    const handle = await open(path, "r");
    const reads = vi.spyOn(Object.getPrototypeOf(handle), "read").mockRejectedValue(Object.assign(new Error("EIO"), { code: "EIO" }));
    const req = { ...request, textOffset: 4096 };
    try {
      expect(index.read(path, req).state).toBe("pending");
      await vi.waitFor(() => expect(index.read(path, req)).toMatchObject({ state: "error", revision: original.revision }));
      expect(index.read(path, request)).toMatchObject({ state: "ready", question: { id: "u1" } });
      expect(index.read(path, req).state).toBe("error");
    } finally { reads.mockRestore(); await handle.close(); }
    expect(index.read(path, req).state).toBe("error");
    expect(await ready(index, path, { ...request, textOffset: 4000 })).toMatchObject({ question: { text: "x".repeat(1000) } });
    renameSync(path, path + ".old");
    writeFileSync(path, lines([context, message("u1", "user", "y".repeat(5000)), message("a1", "assistant", "answer")]));
    const result = await ready(index, path, req);
    expect(result.revision).not.toBe(original.revision);
    expect(result.question?.text).toBe("y".repeat(904));
  });
});
