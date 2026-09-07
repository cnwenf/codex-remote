// @vitest-environment node
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { describe, expect, it } from "vitest";
import { ImageUploadStore } from "./image-upload-store";
import { registerAssistantImages } from "./assistant-images";
import { DesktopState } from "./desktop-state";
import { initialCodexState } from "../protocol/thread-store";
import { hydrateThread } from "../web/state/conversation-history";

const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64");

describe("assistant Markdown local image registration", () => {
  it("registers real image nodes including spaces, file URLs and reference images, without altering Markdown", async () => {
    const dir = mkdtempSync(join(tmpdir(), "assistant-images-"));
    const path = join(dir, "local image.png");
    writeFileSync(path, PNG);
    const store = new ImageUploadStore(join(dir, "uploads"));
    const fileUrl = pathToFileURL(path).href;
    const markdown = `![space](<${path}>)\n![url](${fileUrl})\n![ref][image]\n\n[image]: <${path}>`;
    const mappings = registerAssistantImages(markdown, store);
    expect(Object.keys(mappings)).toEqual([path.replaceAll(" ", "%20"), fileUrl]);
    for (const id of Object.values(mappings)) expect((await store.open(id))?.mimeType).toBe("image/png");
    expect(markdown).toContain(`![space](<${path}>)`);
  });

  it("never registers ordinary links, code examples, remote URLs or non-raster paths", () => {
    const dir = mkdtempSync(join(tmpdir(), "assistant-images-"));
    const path = join(dir, "local.png");
    const fake = join(dir, "not-image.png");
    const svg = join(dir, "vector.svg");
    writeFileSync(path, PNG);
    writeFileSync(fake, "private non-image text");
    writeFileSync(svg, '<svg xmlns="http://www.w3.org/2000/svg"/>');
    const store = new ImageUploadStore(join(dir, "uploads"));
    const markdown = `[ordinary](${path})\n\n\`![inline](${path})\`\n\n\`\`\`md\n![code](${path})\n\`\`\`\n\n![fake](${fake})\n![svg](${svg})\n![remote](https://example.test/image.png)\n![host](file://remote.example/image.png)\n![missing](/missing.png)`;
    expect(registerAssistantImages(markdown, store)).toEqual({});
  });

  it.each(["response_item", "item_completed"])("projects %s image mappings through an actual Desktop history page and hydration", (recordType) => {
    const dir = mkdtempSync(join(tmpdir(), "assistant-history-"));
    const source = join(dir, "result.png");
    writeFileSync(source, PNG);
    mkdirSync(join(dir, "sessions"));
    const rollout = join(dir, "sessions", "rollout.jsonl");
    const text = `![Result](${source})`;
    writeFileSync(rollout, [
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn" } },
      recordType === "response_item"
        ? { type: "response_item", payload: { type: "message", id: "answer", role: "assistant", content: [{ type: "output_text", text }] } }
        : { type: "event_msg", payload: { type: "item_completed", turn_id: "turn", item: { id: "answer", type: "agentMessage", text } } },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "turn" } },
    ].map((value) => JSON.stringify(value)).join("\n") + "\n");
    const databasePath = join(dir, "state.sqlite");
    const db = new DatabaseSync(databasePath);
    db.exec(`CREATE TABLE threads (id TEXT, rollout_path TEXT, name TEXT, title TEXT, preview TEXT, cwd TEXT,
      is_pinned INTEGER, model TEXT, reasoning_effort TEXT, sandbox_policy TEXT, approval_mode TEXT,
      updated_at_ms INTEGER, recency_at_ms INTEGER, archived INTEGER, thread_source TEXT)`);
    db.prepare("INSERT INTO threads VALUES ('t', ?, 'test', 'test', '', '/', 0, NULL, NULL, '{}', 'never', 1, 1, 0, NULL)").run(rollout);
    db.close();
    const desktop = new DesktopState(databasePath);
    try {
      const page = desktop.request("desktopState/readThread", { threadId: "t", history: { limitTurns: 1 } });
      const item = hydrateThread(initialCodexState, page).threads.t.turns.turn.items.answer;
      expect(item.text).toBe(text);
      expect(item.localImages).toEqual({ [source]: expect.stringMatching(/^[0-9a-f-]{36}$/) });
    } finally { desktop.close(); }
  });
});
