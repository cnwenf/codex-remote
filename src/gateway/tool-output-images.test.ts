// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopState, projectHistoryRecord } from "./desktop-state";
import { initialCodexState } from "../protocol/thread-store";
import { hydrateThread } from "../web/state/conversation-history";
import { registerToolOutputImages } from "./tool-output-images";
import { ImageUploadStore, MAX_IMAGE_BYTES } from "./image-upload-store";

const testDirectories = new Set<string>();

afterEach(() => {
  for (const dir of testDirectories) rmSync(dir, { recursive: true, force: true });
  testDirectories.clear();
});

describe("structured tool result images", () => {
  it.each([
    { count: 0, valid: false, late: false, sibling: false },
    { count: 1, valid: false, late: false, sibling: false },
    { count: 15, valid: false, late: false, sibling: false },
    { count: 16, valid: false, late: false, sibling: false },
    { count: 16, valid: true, late: true, sibling: false },
    { count: 16, valid: true, late: true, sibling: true },
  ])("ignores $count image-shaped metadata parts (valid=$valid, late=$late, sibling=$sibling)", ({ count, valid, late, sibling }) => {
    const image = largePng();
    const smallImage = readFileSync(resolve("assets/app-icon.png"));
    const metadata = { content: Array.from({ length: count }, () => ({
      type: "image", data: valid ? smallImage.toString("base64") : "invalid",
      ...(valid ? { mimeType: "image/png" } : {}),
    })) };
    const imagePart = late
      ? { data: image.toString("base64"), content: metadata.content, type: "image", mimeType: "image/png" }
      : { type: "image", data: image.toString("base64"), annotations: metadata, mimeType: "image/png" };
    const outputRecord = { type: "response_item", payload: {
      type: "custom_tool_call_output", call_id: "call", output: [
        { type: "text", text: "Before" }, imagePart,
        ...(sibling ? [{ content: [[{ type: "image", mimeType: "image/png", data: smallImage.toString("base64") }]] }] : []),
        { type: "text", text: "After" },
      ],
    } };
    const raw = Buffer.from(JSON.stringify(outputRecord));
    expect(raw.length).toBeGreaterThan(2 * 1024 * 1024);
    const store = new ImageUploadStore(temporaryDirectory("project-image-quota-"));
    const registrations = vi.spyOn(store, "referenceForDataUrl");
    const readRange = vi.fn((start: number, length: number) => raw.subarray(start, start + length));
    const projected = projectHistoryRecord(readRange, 0, raw.length, store);
    expect(projected).toBeDefined();
    expect(registrations).toHaveBeenCalledTimes(sibling ? 2 : 1);
    expect(readRange.mock.calls.every(([, length]) => length <= 32 + 4 * Math.ceil(MAX_IMAGE_BYTES / 3))).toBe(true);
    expect(readRange.mock.calls.filter(([, length]) => length > 64 * 1024)).toHaveLength(sibling ? 2 : 1);
    const { desktop, dir } = history([
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn" } },
      { type: "response_item", payload: { type: "custom_tool_call", call_id: "call", name: "exec", input: "view()" } },
      outputRecord,
      { type: "event_msg", payload: { type: "task_complete", turn_id: "turn" } },
    ]);
    try {
      const page = desktop.request("desktopState/readThread", { threadId: "t", history: { maxBytes: 2 * 1024 * 1024 } });
      const turn = hydrateThread(initialCodexState, page).threads.t.turns.turn;
      const item = turn.items.call;
      expect(turn.status).toBe("completed");
      expect(item).toMatchObject({ status: "completed", toolInput: "view()", toolOutputImagesIncomplete: false });
      expect(item.toolOutputImageIds).toHaveLength(sibling ? 2 : 1);
      expect(item.toolOutput).toBe(sibling ? "Before\n[非文本结果]\n[非文本结果]\nAfter" : "Before\n[非文本结果]\nAfter");
      expect(JSON.stringify(page)).not.toContain(image.toString("base64").slice(0, 1024));
      expect(readFileSync(join(dir, "codex-remote", "uploads", `${item.toolOutputImageIds![0]}.png`))).toEqual(image);
      expect(readdirSync(join(dir, "codex-remote", "uploads")).filter((name) => name.endsWith(".png"))).toHaveLength(sibling ? 2 : 1);
      if (sibling) expect(readFileSync(join(dir, "codex-remote", "uploads", `${item.toolOutputImageIds![1]}.png`))).toEqual(smallImage);
    } finally { desktop.close(); }
  });

  it("caps genuine projected result images at sixteen registrations across result fields", () => {
    const smallData = readFileSync(resolve("assets/app-icon.png")).toString("base64");
    const record = { type: "response_item", payload: {
      type: "custom_tool_call_output", call_id: "call",
      // Source field order differs from the registration visitor's output/result/content order.
      result: [{ type: "image", data: smallData, mimeType: "image/png" }],
      output: [{ type: "image", data: largePng().toString("base64"), mimeType: "image/png" },
        ...Array.from({ length: 15 }, () => ({ type: "input_image", image_url: `data:image/png;base64,${smallData}` })),
        { type: "text", text: "After seventeen" }],
    } };
    const raw = Buffer.from(JSON.stringify(record));
    const store = new ImageUploadStore(temporaryDirectory("project-genuine-limit-"));
    const registrations = vi.spyOn(store, "referenceForDataUrl");
    const projected = projectHistoryRecord((start, length) => raw.subarray(start, start + length), 0, raw.length, store);
    expect(projected).toBeDefined();
    expect(registrations).toHaveBeenCalledTimes(16);
    const payload = JSON.parse(projected!).payload;
    expect(payload.result[0].data).toBe("codex-remote-image:invalid");
    const registered = registerToolOutputImages(payload, store);
    expect(registered.toolOutputImageIds).toHaveLength(2);
    expect(registered.toolOutputImagesIncomplete).toBe(true);
    expect(JSON.stringify(registered)).toContain("After seventeen");
    const { desktop } = history([
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn" } },
      { type: "response_item", payload: { type: "custom_tool_call", call_id: "call", name: "exec", input: "view()" } },
      record,
      { type: "event_msg", payload: { type: "task_complete", turn_id: "turn" } },
    ]);
    try {
      const item = hydrateThread(initialCodexState,
        desktop.request("desktopState/readThread", { threadId: "t" })).threads.t.turns.turn.items.call;
      expect(item).toMatchObject({ status: "completed", toolInput: "view()", toolOutputImagesIncomplete: true });
      expect(item.toolOutputImageIds).toHaveLength(2);
      expect(item.toolOutput).toContain("After seventeen");
    } finally { desktop.close(); }
  });

  it("preserves ordinary deferred strings with Unicode offsets, nested arrays and escaped property names", () => {
    const ordinary = 'quoted "path\\value"\n中文🙂';
    const data = { data: ordinary, type: "metadata", child: { data: `${ordinary} child` },
      content: [[{ data: `${ordinary} array`, type: "metadata" }]], image_url: "https://example.invalid/image.png" };
    const record = { type: "response_item", payload: { type: "custom_tool_call_output", output: [
      data, { type: "image", data: largePng().toString("base64"), mimeType: "image/png" },
    ] } };
    const prefix = Buffer.from("中文🙂 prefix\n");
    const source = Buffer.from(JSON.stringify(record).replaceAll('"data":', '"d\\u0061ta":'));
    const raw = Buffer.concat([prefix, source]);
    const store = new ImageUploadStore(temporaryDirectory("project-ordinary-offsets-"));
    const projected = projectHistoryRecord((start, length) => raw.subarray(start, start + length), prefix.length, raw.length, store);
    expect(JSON.parse(projected!).payload.output[0]).toEqual(data);
  });

  it("retains the bounded failure for oversized ordinary data and more than 512 containers", () => {
    const store = new ImageUploadStore(temporaryDirectory("project-ordinary-bounds-"));
    const registrations = vi.spyOn(store, "referenceForDataUrl");
    for (const output of [
      [{ data: "A".repeat(2_100_000), type: "metadata" }],
      [JSON.parse('['.repeat(513) + '{}' + ']'.repeat(513)), { type: "image", data: "A".repeat(2_100_000) }],
    ]) {
      const raw = Buffer.from(JSON.stringify({ type: "response_item", payload: { type: "custom_tool_call_output", output } }));
      expect(projectHistoryRecord((start, length) => raw.subarray(start, start + length), 0, raw.length, store)).toBeUndefined();
    }
    expect(registrations).not.toHaveBeenCalled();
  });

  it("returns the bounded failure for a malformed deferred ordinary string", () => {
    const raw = Buffer.from(JSON.stringify({ type: "response_item", payload: {
      type: "custom_tool_call_output", output: [
        { data: "ordinary", type: "metadata" },
        { data: "A".repeat(2_100_000), type: "image", mimeType: "image/png" },
      ],
    } }).replace('"ordinary"', '"bad\\q"'));
    expect(projectHistoryRecord((start, length) => raw.subarray(start, start + length), 0, raw.length,
      new ImageUploadStore(temporaryDirectory("project-malformed-data-")))).toBeUndefined();
  });

  it("preserves legacy non-data image URLs without treating source strings as span keys", () => {
    const raw = Buffer.from(JSON.stringify({ type: "response_item", payload: { type: "message", content: [
      { type: "ignored_image", image_url: `data:image/png;base64,${"A".repeat(2_100_000)}` },
      { type: "input_image", image_url: "https://example.invalid/image.png", data: "0" },
      { type: "input_image", image_url: "1" },
    ] } }));
    const store = new ImageUploadStore(temporaryDirectory("project-legacy-urls-"));
    const registrations = vi.spyOn(store, "referenceForDataUrl");
    const projected = projectHistoryRecord((start, length) => raw.subarray(start, start + length), 0, raw.length, store);
    expect(JSON.parse(projected!).payload.content).toEqual([
      { type: "ignored_image", image_url: "" },
      { type: "input_image", image_url: "https://example.invalid/image.png", data: "0" },
      { type: "input_image", image_url: "1" },
    ]);
    expect(registrations).not.toHaveBeenCalled();
  });

  it.each([
    {
      label: "nested metadata after data",
      part: (data: string) => ({
        type: "image", data, annotations: { audience: ["assistant"] }, mimeType: "image/png",
      }),
    },
    {
      label: "nested metadata before data",
      part: (data: string) => ({
        type: "image", mimeType: "image/png", _meta: { note: "ok" }, data,
      }),
    },
  ])("restores a large MCP image with $label", ({ part }) => {
    const image = largePng();
    const { desktop, dir } = history([
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn" } },
      { type: "response_item", payload: { type: "custom_tool_call", call_id: "call", name: "exec", input: "view_image()" } },
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call", output: [
        { type: "text", text: "Before nested image" }, part(image.toString("base64")),
        { type: "text", text: "After nested image" },
      ] } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "turn" } },
    ]);
    try {
      const page = desktop.request("desktopState/readThread", { threadId: "t", history: { maxBytes: 2 * 1024 * 1024 } });
      const item = hydrateThread(initialCodexState, page).threads.t.turns.turn.items.call;
      expect(item).toMatchObject({
        toolOutputImageIds: [expect.any(String)], toolOutputImagesIncomplete: false,
      });
      expect(item.toolOutput).toContain("Before nested image");
      expect(item.toolOutput).toContain("After nested image");
      expect(readFileSync(join(dir, "codex-remote", "uploads", `${item.toolOutputImageIds![0]}.png`))).toEqual(image);
    } finally { desktop.close(); }
  });

  it.each(["data-first", "metadata-first"])("restores a valid large MCP image with %s field order", (order) => {
    const image = largePng();
    const data = image.toString("base64");
    const imagePart = order === "data-first"
      ? { data, mimeType: "image/png", type: "image" }
      : { type: "image", mimeType: "image/png", data };
    const { desktop, dir } = history([
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn" } },
      { type: "response_item", payload: { type: "message", id: "user", role: "user", content: [{ type: "input_text", text: "Inspect" }] } },
      { type: "response_item", payload: { type: "custom_tool_call", call_id: "call", name: "exec", input: "view_image()" } },
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call", output: [
        { type: "text", text: "Before image" }, imagePart, { type: "text", text: "After image" },
      ] } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "turn" } },
    ]);
    try {
      const page = desktop.request("desktopState/readThread", { threadId: "t", history: { maxBytes: 2 * 1024 * 1024 } });
      const item = hydrateThread(initialCodexState, page).threads.t.turns.turn.items.call;
      expect(item).toMatchObject({ toolInput: "view_image()", toolOutputImageIds: [expect.any(String)] });
      expect(item.toolOutput).toContain("Before image");
      expect(item.toolOutput).toContain("After image");
      expect(JSON.stringify(page)).not.toContain(data.slice(0, 1024));
      expect(readFileSync(join(dir, "codex-remote", "uploads", `${item.toolOutputImageIds![0]}.png`))).toEqual(image);
    } finally { desktop.close(); }
  });

  it("keeps surrounding text when a projected large MCP image is invalid", () => {
    const data = "A".repeat(2_200_000);
    const { desktop } = history([
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn" } },
      { type: "response_item", payload: { type: "custom_tool_call", call_id: "call", name: "exec", input: "view_image()" } },
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call", output: [
        { type: "text", text: "Before invalid" }, { data, mimeType: "image/png", type: "image" },
        { type: "text", text: "After invalid" },
      ] } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "turn" } },
    ]);
    try {
      const page = desktop.request("desktopState/readThread", { threadId: "t" });
      const item = hydrateThread(initialCodexState, page).threads.t.turns.turn.items.call;
      expect(item.toolOutputImagesIncomplete).toBe(true);
      expect(item.toolOutput).toContain("Before invalid");
      expect(item.toolOutput).toContain("After invalid");
      expect(JSON.stringify(page)).not.toContain(data.slice(0, 1024));
    } finally { desktop.close(); }
  });

  it("marks an oversized projected MCP image incomplete without dropping later text", () => {
    const data = "A".repeat(4 * Math.ceil((MAX_IMAGE_BYTES + 1) / 3));
    const { desktop } = history([
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn" } },
      { type: "response_item", payload: { type: "custom_tool_call", call_id: "call", name: "exec", input: "view_image()" } },
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call", output: [
        { type: "image", mimeType: "image/png", data }, { type: "text", text: "After oversized" },
      ] } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "turn" } },
    ]);
    try {
      const page = desktop.request("desktopState/readThread", { threadId: "t" });
      const item = hydrateThread(initialCodexState, page).threads.t.turns.turn.items.call;
      expect(item.toolOutputImageIds).toEqual([]);
      expect(item.toolOutputImagesIncomplete).toBe(true);
      expect(item.toolOutput).toContain("After oversized");
      expect(JSON.stringify(page)).not.toContain(data.slice(0, 1024));
    } finally { desktop.close(); }
  });

  it("preserves ordinary data before its type beside a large MCP image", () => {
    const image = largePng();
    const unrelated = 'quoted "path\\value"\n中文';
    const outputRecord = { type: "response_item", payload: {
      type: "custom_tool_call_output", call_id: "call", output: [
        { type: "text", text: "Before mixed content" },
        { data: unrelated, _meta: { note: "ordinary" }, type: "metadata" },
        { type: "image", data: image.toString("base64"), mimeType: "image/png" },
        { type: "text", text: "After mixed content" },
      ],
    } };
    const raw = Buffer.from(JSON.stringify(outputRecord));
    const projected = projectHistoryRecord(
      (start, length) => raw.subarray(start, start + length), 0, raw.length,
      new ImageUploadStore(temporaryDirectory("project-mixed-data-")),
    );
    expect((JSON.parse(projected!) as typeof outputRecord).payload.output[1]).toEqual({
      data: unrelated, _meta: { note: "ordinary" }, type: "metadata",
    });
    const { desktop, dir } = history([
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn" } },
      { type: "response_item", payload: { type: "custom_tool_call", call_id: "call", name: "exec", input: "mixed()" } },
      outputRecord,
      { type: "event_msg", payload: { type: "task_complete", turn_id: "turn" } },
    ]);
    try {
      const page = desktop.request("desktopState/readThread", { threadId: "t", history: { maxBytes: 2 * 1024 * 1024 } });
      const item = hydrateThread(initialCodexState, page).threads.t.turns.turn.items.call;
      expect(item.toolOutput).toContain("Before mixed content");
      expect(item.toolOutput).toContain("[非文本结果]");
      expect(item.toolOutput).toContain("After mixed content");
      expect(item.toolOutputImageIds).toHaveLength(1);
      expect(readFileSync(join(dir, "codex-remote", "uploads", `${item.toolOutputImageIds![0]}.png`))).toEqual(image);
    } finally { desktop.close(); }
  });

  it("keeps nested type and data scoped away from the enclosing MCP image", () => {
    const image = largePng();
    const imagePart = {
      type: "image", data: image.toString("base64"),
      annotations: { type: "image", data: "not-an-image" }, mimeType: "image/png",
    };
    const outputRecord = { type: "response_item", payload: {
      type: "custom_tool_call_output", call_id: "call", output: [imagePart],
    } };
    const raw = Buffer.from(JSON.stringify(outputRecord));
    const projected = projectHistoryRecord(
      (start, length) => raw.subarray(start, start + length), 0, raw.length,
      new ImageUploadStore(temporaryDirectory("project-nested-scope-")),
    );
    const projectedPart = (JSON.parse(projected!) as typeof outputRecord).payload.output[0];
    expect(projectedPart.annotations).toBeUndefined();
    expect(projectedPart.data).toMatch(/^codex-remote-image:(?!invalid$)/);
    const { desktop, dir } = history([
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn" } },
      { type: "response_item", payload: { type: "custom_tool_call", call_id: "call", name: "exec", input: "view_image()" } },
      outputRecord,
      { type: "event_msg", payload: { type: "task_complete", turn_id: "turn" } },
    ]);
    try {
      const item = hydrateThread(initialCodexState,
        desktop.request("desktopState/readThread", { threadId: "t" })).threads.t.turns.turn.items.call;
      expect(item).toMatchObject({ toolOutputImageIds: [expect.any(String)], toolOutputImagesIncomplete: false });
      expect(readFileSync(join(dir, "codex-remote", "uploads", `${item.toolOutputImageIds![0]}.png`))).toEqual(image);
    } finally { desktop.close(); }
  });

  it("restores an MCP image across deeply nested metadata without nesting-sized image buffers", () => {
    const image = largePng();
    let metadata: Record<string, unknown> = { leaf: "bounded" };
    for (let depth = 0; depth < 256; depth++) metadata = { child: metadata };
    const { desktop, dir } = history([
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn" } },
      { type: "response_item", payload: { type: "custom_tool_call", call_id: "call", name: "exec", input: "view_image()" } },
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call", output: [{
        type: "image", mimeType: "image/png", annotations: metadata, data: image.toString("base64"),
      }] } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "turn" } },
    ]);
    try {
      const item = hydrateThread(initialCodexState,
        desktop.request("desktopState/readThread", { threadId: "t" })).threads.t.turns.turn.items.call;
      expect(item).toMatchObject({ toolOutputImageIds: [expect.any(String)], toolOutputImagesIncomplete: false });
      expect(readFileSync(join(dir, "codex-remote", "uploads", `${item.toolOutputImageIds![0]}.png`))).toEqual(image);
    } finally { desktop.close(); }
  });

  it("bounds image registrations and marks omitted images without dropping later text", () => {
    const store = new ImageUploadStore(temporaryDirectory("tool-images-bounds-"));
    const dataUrl = `data:image/png;base64,${readFileSync(resolve("assets/app-icon.png")).toString("base64")}`;
    const output = registerToolOutputImages({ type: "custom_tool_call_output", output: [
      ...Array.from({ length: 17 }, () => ({ type: "input_image", image_url: dataUrl })),
      { type: "text", text: "Still readable after images" },
    ] }, store);
    expect(output.toolOutputImageIds).toHaveLength(1);
    expect(output.toolOutputImagesIncomplete).toBe(true);
    expect(JSON.stringify(output)).toContain("Still readable after images");
    expect(JSON.stringify(output)).not.toContain("base64");
  });

  it.each([64 * 1024, 2 * 1024 * 1024])("restores image bytes with their call and text using a %i-byte page", (maxBytes) => {
    const image = readFileSync(resolve("assets/app-icon.png"));
    const dataUrl = `data:image/png;base64,${image.toString("base64")}`;
    const { desktop, dir } = history([
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn" } },
      { type: "response_item", payload: { type: "custom_tool_call", id: "definition", call_id: "call", name: "exec", input: "view_image(reference)" } },
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call", output: [
        { type: "text", text: "Reference screenshot" }, { image_url: dataUrl, type: "input_image", detail: "original" }, { type: "text", text: "Trailing text" },
      ], internal_chat_message_metadata_passthrough: { turn_id: "turn" } } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "turn" } },
    ]);
    try {
      const page = desktop.request("desktopState/readThread", { threadId: "t", history: { maxBytes } });
      const item = hydrateThread(initialCodexState, page).threads.t.turns.turn.items.call;
      expect(item.toolOutputImageIds).toHaveLength(1);
      expect(item.toolOutput).toContain("Reference screenshot");
      expect(item.toolOutput).toContain("Trailing text");
      expect(item.toolInput).toBe("view_image(reference)");
      expect(JSON.stringify(page)).not.toContain("base64");
      expect(readFileSync(join(dir, "codex-remote", "uploads", `${item.toolOutputImageIds![0]}.png`))).toEqual(image);
      const replay = hydrateThread(initialCodexState, desktop.request("desktopState/readThread", { threadId: "t", history: { maxBytes } }));
      expect(replay.threads.t.turns.turn.items.call.toolOutputImageIds).toEqual(item.toolOutputImageIds);
    } finally { desktop.close(); }
  });

  it("preserves readable text and explicitly marks unsupported image content", () => {
    const { desktop } = history([
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn" } },
      { type: "response_item", payload: { type: "custom_tool_call", call_id: "call", name: "exec", input: "view_image(reference)" } },
      { type: "response_item", payload: { type: "custom_tool_call_output", call_id: "call", output: [
        { type: "text", text: "Readable" }, { type: "input_image", image_url: "data:image/svg+xml;base64,SECRET_BINARY" },
      ] } },
    ]);
    try {
      const state = hydrateThread(initialCodexState, desktop.request("desktopState/readThread", { threadId: "t" }));
      expect(state.threads.t.turns.turn.items.call.toolOutputImagesIncomplete).toBe(true);
      expect(state.threads.t.turns.turn.items.call.toolOutput).toContain("Readable");
      expect(JSON.stringify(state)).not.toContain("SECRET_BINARY");
    } finally { desktop.close(); }
  });
});

function largePng() {
  const source = readFileSync(resolve("assets/app-icon.png"));
  const type = Buffer.from("tEXt");
  const data = Buffer.concat([Buffer.from("Comment\0"), Buffer.alloc(1_600_000, 97)]);
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  type.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([type, data])), 8 + data.length);
  return Buffer.concat([source.subarray(0, -12), chunk, source.subarray(-12)]);
}

function crc32(value: Buffer) {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit++) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function history(records: unknown[]) {
  const dir = temporaryDirectory("tool-result-images-");
  mkdirSync(join(dir, "sessions"));
  const rollout = join(dir, "sessions", "rollout.jsonl");
  writeFileSync(rollout, records.map((record) => JSON.stringify(record)).join("\n") + "\n");
  const databasePath = join(dir, "state.sqlite");
  const db = new DatabaseSync(databasePath);
  db.exec(`CREATE TABLE threads (id TEXT, rollout_path TEXT, name TEXT, title TEXT, preview TEXT, cwd TEXT,
    is_pinned INTEGER, model TEXT, reasoning_effort TEXT, sandbox_policy TEXT, approval_mode TEXT,
    updated_at_ms INTEGER, recency_at_ms INTEGER, archived INTEGER, thread_source TEXT)`);
  db.prepare("INSERT INTO threads VALUES ('t', ?, 'test', 'test', '', '/', 0, NULL, NULL, '{}', 'never', 1, 1, 0, NULL)").run(rollout);
  db.close();
  return { desktop: new DesktopState(databasePath), dir };
}

function temporaryDirectory(prefix: string) {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  testDirectories.add(dir);
  return dir;
}
