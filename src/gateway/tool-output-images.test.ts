// @vitest-environment node
import { mkdirSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { DesktopState } from "./desktop-state";
import { initialCodexState } from "../protocol/thread-store";
import { hydrateThread } from "../web/state/conversation-history";
import { registerToolOutputImages } from "./tool-output-images";
import { ImageUploadStore } from "./image-upload-store";

describe("structured tool result images", () => {
  it("bounds image registrations and marks omitted images without dropping later text", () => {
    const store = new ImageUploadStore(mkdtempSync(join(tmpdir(), "tool-images-bounds-")));
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

function history(records: unknown[]) {
  const dir = mkdtempSync(join(tmpdir(), "tool-result-images-"));
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
