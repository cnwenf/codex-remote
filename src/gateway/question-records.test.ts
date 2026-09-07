// @vitest-environment node
import { describe, expect, it } from "vitest";
import { QuestionRecordReader } from "./question-records";

function parse(value: unknown, offset = 0) {
  const reader = new QuestionRecordReader(offset);
  const raw = Buffer.from(typeof value === "string" ? value : JSON.stringify(value));
  for (let n = 0; n < raw.length; n += 65536) reader.write(raw.subarray(n, n + 65536));
  return reader.finish();
}

describe("bounded question record projection", () => {
  it("skips a long command array without treating the legal record as corrupt", () => {
    const reader = new QuestionRecordReader();
    reader.write(Buffer.from(JSON.stringify({ type: "event_msg", payload: {
      type: "item_completed", turn_id: "turn", item: {
        type: "CommandExecution", id: "exec", command: ["zsh", "-lc", "x".repeat(2000)],
      },
    } })));
    expect(reader.finish()).toBeUndefined();
    expect(reader.valid).toBe(true);
  });

  it("keeps steering metadata array strings bounded", () => {
    const reader = new QuestionRecordReader();
    reader.write(Buffer.from(JSON.stringify({ type: "response_item", payload: {
      type: "message", role: "user", id: "u", content: [{ type: "input_text", text: "question" }],
      internal_chat_message_metadata_passthrough: { content_item_kinds: ["x".repeat(2000)] },
    } })));
    expect(reader.finish()).toBeUndefined();
    expect(reader.valid).toBe(false);
  });

  it("finds user metadata after a giant reversed image field", () => {
    expect(parse({ payload: { content: [{ image_url: "data:image/png;base64," + "a".repeat(2 ** 22), type: "input_image" }],
      role: "user", id: "u", type: "message", internal_chat_message_metadata_passthrough: { turn_id: "turn" } }, type: "response_item" }))
      .toMatchObject({ kind: "question", id: "u", turnId: "turn", text: "", imageCount: 1, source: "user" });
  });
  it("paginates decoded text across content parts without swallowing unicode or escapes", () => {
    const record = { type: "response_item", payload: { type: "message", role: "user", id: "u", content: [
      { type: "input_text", text: "甲".repeat(4094) + "\n乙" }, { type: "input_text", text: "丙\\丁" },
    ] } };
    expect(parse(record)).toMatchObject({ text: "甲".repeat(4094) + "\n乙", textLength: 4100 });
    expect(parse(record, 4096)).toMatchObject({ text: "\n丙\\丁", textLength: 4100 });
  });
  it("rejects malformed JSON and system metadata even after user-looking text", () => {
    expect(parse('{"type":"response_item","payload":{"type":"message","role":"user","id":"u","content":[{"text":"fake"}]} garbage}')).toBeUndefined();
    expect(parse({ type: "response_item", payload: { type: "message", role: "user", id: "u", content: [{ text: "system" }],
      internal_chat_message_metadata_passthrough: { content_item_kinds: ["environment_context"] } } })).toBeUndefined();
  });
  it("recognizes only a complete strict delegation envelope", () => {
    const payload = { type: "function_call_output", id: "d", namespace: "codex_app", name: "send_message_to_thread",
      output: "<codex_delegation><source_thread_id>00000000-0000-4000-8000-000000000001</source_thread_id><input>literal command</input></codex_delegation>" };
    expect(parse({ type: "response_item", payload })).toMatchObject({ kind: "question", text: "literal command", source: "delegated" });
    expect(parse({ type: "response_item", payload: { ...payload, call_id: "c" } })).toBeUndefined();
    expect(parse({ type: "response_item", payload: { ...payload, output: payload.output + " extra" } })).toBeUndefined();
  });
  it("shows My request and strips attachment envelopes while preserving text pagination", () => {
    const value = { type: "response_item", payload: { type: "message", id: "u", role: "user", content: [{ type: "input_text",
      text: "IDE context\n## My request:\n  " + "甲".repeat(4096) + '<image path="/private/image.png">' + "attachment".repeat(10000) + "</image>尾页  " }] } };
    expect(parse(value)).toMatchObject({ text: "甲".repeat(4096), textLength: 4098, imageCount: 1 });
    expect(parse(value, 4096)).toMatchObject({ text: "尾页", textLength: 4098 });
  });
  it("preserves internal whitespace between text parts while trimming only outer edges", () => {
    expect(parse({ type: "response_item", payload: { type: "message", role: "user", id: "u", content: [
      { type: "input_text", text: "  first " }, { type: "input_text", text: " second  " },
    ] } })).toMatchObject({ text: "first \n second", textLength: 14 });
  });
  it.each([
    { parts: ["IDE context", "## My request:\nreal question"], text: "real question" },
    { parts: ['hello<image path="x">', "image content</image>world"], text: "helloworld" },
    { parts: ["IDE context\n##", "My request:", "real question"], text: "real question" },
  ])("normalizes the complete text-part sequence: $text", ({ parts, text }) => {
    const value = { type: "response_item", payload: { type: "message", role: "user", id: "u", content: parts.map((text) => ({ type: "input_text", text })) } };
    expect(parse(value)).toMatchObject({ text, textLength: text.length });
  });
  it("paginates shared normalization after a marker and attachment cross text fields", () => {
    const parts = ["IDE context\n##", "My request:\n" + "甲".repeat(4090) + '<image path="x">', "hidden".repeat(10000) + "</image>" + "乙".repeat(20)];
    const value = { type: "response_item", payload: { type: "message", role: "user", id: "u", content: parts.map((text) => ({ type: "input_text", text })) } };
    expect(parse(value)).toMatchObject({ text: "甲".repeat(4090) + "乙".repeat(6), textLength: 4110, imageCount: 1 });
    expect(parse(value, 4096)).toMatchObject({ text: "乙".repeat(14), textLength: 4110 });
  });
});
