import { StringDecoder } from "node:string_decoder";

export type QuestionRecord = {
  kind: "turn" | "question" | "anchor";
  turnId?: string;
  id?: string;
  text?: string;
  textLength?: number;
  imageCount?: number;
  source?: "user" | "delegated";
  sourceThreadId?: string;
  replay?: boolean;
};

type TextSlice = { length: number; start: number; page: string; prefix: string; suffix: string; images?: number; visibleLength?: number; rawLength?: number };
type TextGroup = { slice: TextSlice; visible: VisibleText; hasText: boolean };
const identityKeys = new Set(["type", "role", "id", "call_id", "callId", "turn_id", "namespace", "name"]);
const record = (value: unknown): Record<string, unknown> => value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {};
const str = (value: unknown) => typeof value === "string" && value.length <= 1024 ? value : undefined;

function collect(s: TextSlice, text: string) {
  if (s.prefix.length < 256) s.prefix += text.slice(0, 256 - s.prefix.length);
  s.suffix = (s.suffix + text.slice(-256)).slice(-256);
  const from = Math.max(0, s.start - s.length);
  const to = Math.min(text.length, s.start + 4353 - s.length);
  if (to > from) s.page += text.slice(from, to);
  s.length += text.length;
}

/** Streaming counterpart of displayUserInput: bounded marker/tag lookbehind,
 * rollback of attachment bodies, and trim without storing trailing whitespace. */
class VisibleText {
  private markerBuffer = "";
  private imageBuffer = "";
  private markerSeen = false;
  private previous = "";
  private lastVisible = 0;
  private envelope?: { slice: TextSlice; lastVisible: number };
  constructor(private slice: TextSlice, private trimStart: boolean) {}

  write(text: string, final = false) {
    this.markerBuffer += text;
    if (!this.markerSeen) {
      const match = /(?:^|\n)#{1,3}\s*My request:\s*/i.exec(this.previous + this.markerBuffer);
      if (match) {
        this.markerBuffer = (this.previous + this.markerBuffer).slice(match.index + match[0].length);
        Object.assign(this.slice, { length: 0, page: "", prefix: "", suffix: "", images: 0 });
        this.lastVisible = 0;
        this.envelope = undefined;
        this.imageBuffer = "";
        this.markerSeen = true;
      }
    }
    const count = final || this.markerSeen ? this.markerBuffer.length : Math.max(0, this.markerBuffer.length - 512);
    const ready = this.markerBuffer.slice(0, count);
    this.markerBuffer = this.markerBuffer.slice(count);
    if (ready) this.previous = ready.slice(-1);
    this.images(ready, final);
    if (final) {
      this.slice.visibleLength = this.lastVisible;
    }
  }

  private emit(text: string) {
    if (this.trimStart && !this.slice.length) text = text.replace(/^\s+/, "");
    const visible = text.search(/\s*$/);
    if (visible > 0) this.lastVisible = this.slice.length + visible;
    collect(this.slice, text);
  }

  private images(text: string, final: boolean) {
    this.imageBuffer += text;
    while (this.imageBuffer) {
      const begin = this.imageBuffer.search(/<\/?image\b/i);
      if (begin < 0) {
        const count = final ? this.imageBuffer.length : Math.max(0, this.imageBuffer.length - 7);
        this.emit(this.imageBuffer.slice(0, count)); this.imageBuffer = this.imageBuffer.slice(count); return;
      }
      if (begin > 0) { this.emit(this.imageBuffer.slice(0, begin)); this.imageBuffer = this.imageBuffer.slice(begin); }
      const end = this.imageBuffer.indexOf(">");
      if (end < 0) {
        if (!final && this.imageBuffer.length <= 4096) return;
        this.emit(this.imageBuffer[0]); this.imageBuffer = this.imageBuffer.slice(1); continue;
      }
      const tag = this.imageBuffer.slice(0, end + 1);
      this.imageBuffer = this.imageBuffer.slice(end + 1);
      if (/^<image\b[^>]*>$/i.test(tag)) {
        this.slice.images = (this.slice.images ?? 0) + 1;
        this.envelope ??= { slice: { ...this.slice }, lastVisible: this.lastVisible };
      } else if (/^<\/image>$/i.test(tag)) {
        if (this.envelope) {
          const images = this.slice.images;
          Object.assign(this.slice, this.envelope.slice, { images });
          this.lastVisible = this.envelope.lastVisible;
          this.envelope = undefined;
        }
      } else this.emit(tag);
    }
  }
}

/** Replaces strings as they arrive, then validates the bounded JSON skeleton.
 * A large scalar never becomes a large JavaScript string. Structure, nesting,
 * identities and captured text all have independent hard limits. */
export class QuestionRecordReader {
  private decoder = new StringDecoder("utf8");
  private json = "";
  private stack: string[] = [];
  private paths: string[] = [];
  private previous = "";
  private key = "";
  private inString = false;
  private keyString = false;
  private escape = "";
  private scalar = "";
  private slice?: TextSlice;
  private textGroup?: TextGroup;
  private textGroups = new Map<string, TextGroup>();
  private stringStarted = false;
  private slices: TextSlice[] = [];
  private invalid = false;

  constructor(private textOffset = 0) {}

  get valid() { return !this.invalid; }

  write(bytes: Uint8Array) { this.consume(this.decoder.write(Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength))); }

  private add(text: string) {
    if (this.json.length + text.length > 128 * 1024) this.invalid = true;
    else this.json += text;
  }

  private stringChunk(text: string) {
    if (this.slice) {
      if (this.textGroup) {
        if (!this.stringStarted && text) {
          if (this.textGroup.hasText) this.textGroup.visible.write("\n");
          this.textGroup.hasText = true;
          this.stringStarted = true;
        }
        this.slice.rawLength = (this.slice.rawLength ?? 0) + text.length;
        this.textGroup.visible.write(text);
      }
      else collect(this.slice, text);
    } else if (this.keyString || identityKeys.has(this.key) || this.stack.at(-1) === "[") {
      if (this.scalar.length + text.length > 1024) this.invalid = true;
      else this.scalar += text;
    }
  }

  private consume(chunk: string) {
    for (let n = 0; n < chunk.length && !this.invalid; n++) {
      const c = chunk[n];
      if (this.inString) {
        if (this.escape) {
          this.escape += c;
          if (this.escape === "\\u") continue;
          if (this.escape.startsWith("\\u") && this.escape.length < 6) continue;
          try { this.stringChunk(JSON.parse('"' + this.escape + '"') as string); }
          catch { this.invalid = true; }
          this.escape = "";
        } else if (c === "\\") this.escape = c;
        else if (c === '"') {
          this.inString = false;
          if (this.keyString) { this.key = this.scalar; this.add(JSON.stringify(this.scalar)); }
          else if (this.slice) {
            if (this.slices.length >= 256) { this.invalid = true; continue; }
            this.add(JSON.stringify("@" + this.slices.length));
            this.slices.push(this.slice);
          } else this.add(JSON.stringify(this.scalar));
          this.previous = '"';
        } else if (c.charCodeAt(0) < 32) this.invalid = true;
        else {
          // Skip ordinary runs, including base64, without one callback per byte.
          const end = chunk.slice(n).search(/["\\\x00-\x1f]/);
          const last = end < 0 ? chunk.length : n + end;
          this.stringChunk(chunk.slice(n, last));
          n = last - 1;
        }
        continue;
      }
      if (c === '"') {
        this.inString = true;
        this.keyString = this.stack.at(-1) === "{" && (this.previous === "{" || this.previous === ",");
        this.scalar = "";
        const path = (this.paths.at(-1) ?? "") + (this.stack.at(-1) === "[" ? "[]" : "." + this.key);
        const groupPath = !this.keyString && /^(\.payload(?:\.item)?\.(?:text|content))(?:\[\](?:\.text)?)?$/.exec(path)?.[1];
        this.textGroup = groupPath ? this.textGroups.get(groupPath) : undefined;
        if (groupPath && !this.textGroup) {
          const slice: TextSlice = { length: 0, start: this.textOffset, page: "", prefix: "", suffix: "" };
          this.textGroup = { slice, visible: new VisibleText(slice, true), hasText: false };
          this.textGroups.set(groupPath, this.textGroup);
        }
        this.slice = this.textGroup?.slice ?? (!this.keyString && this.key === "output"
          ? { length: 0, start: this.textOffset, page: "", prefix: "", suffix: "" } : undefined);
        this.stringStarted = false;
        continue;
      }
      if (c === "{" || c === "[") {
        this.paths.push(this.stack.length ? (this.paths.at(-1) ?? "") + (this.stack.at(-1) === "[" ? "[]" : "." + this.key) : "");
        this.stack.push(c);
        if (this.stack.length > 32) this.invalid = true;
      } else if (c === "}" || c === "]") {
        if (this.stack.pop() !== (c === "}" ? "{" : "[")) this.invalid = true;
        this.paths.pop();
      }
      this.add(c);
      if (!/\s/.test(c)) this.previous = c;
    }
  }

  finish(): QuestionRecord | undefined {
    this.consume(this.decoder.end());
    if (this.invalid || this.inString || this.stack.length) { this.invalid = true; return; }
    let entry: Record<string, unknown>;
    if (!this.json.trim()) return;
    try { entry = record(JSON.parse(this.json)); } catch { this.invalid = true; return; }
    for (const group of this.textGroups.values()) group.visible.write("", true);
    const payload = record(entry.payload);
    if (entry.type === "turn_context" || entry.type === "event_msg" && payload.type === "task_started") {
      return { kind: "turn", turnId: str(payload.turn_id) };
    }
    const replay = entry.type === "event_msg" && payload.type === "item_completed";
    if (entry.type !== "response_item" && !replay) return;
    const item = replay ? record(payload.item) : payload;
    const metadata = record(item.internal_chat_message_metadata_passthrough);
    const turnId = str(metadata.turn_id) ?? str(payload.turn_id);
    const type = str(item.type)?.replace(/[_-]/g, "").toLowerCase();
    const id = str(type === "functioncall" || type === "customtoolcall" ? item.call_id ?? item.id : item.id);
    if (!id) return;
    const getSlice = (value: unknown) => typeof value === "string" && /^@\d+$/.test(value) ? this.slices[Number(value.slice(1))] : undefined;
    if (type === "functioncalloutput" && item.namespace === "codex_app" && item.name === "send_message_to_thread" &&
      item.call_id === undefined && item.callId === undefined) {
      const s = getSlice(item.output);
      if (!s) return;
      const head = /^\s*<codex_delegation>\s*<source_thread_id>\s*([0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12})\s*<\/source_thread_id>\s*<input>/i.exec(s.prefix);
      const tail = /<\/input>\s*<\/codex_delegation>\s*$/i.exec(s.suffix);
      if (!head || !tail || head[0].length + tail[0].length > s.length) return;
      const length = s.length - head[0].length - tail[0].length;
      return { kind: "question", turnId, id, source: "delegated", sourceThreadId: head[1], replay,
        text: s.page.slice(head[0].length, head[0].length + Math.min(4096, Math.max(0, length - this.textOffset))), textLength: length, imageCount: 0 };
    }
    if (type === "message" && item.role === "user") {
      const kinds = Array.isArray(metadata.content_item_kinds) ? metadata.content_item_kinds : [];
      if (kinds.length && !kinds.some((kind) => typeof kind === "string" && kind.startsWith("user."))) return;
      const content = Array.isArray(item.content) ? item.content : [];
      const direct = getSlice(item.text);
      const s = direct?.rawLength ? direct : getSlice(item.content) ?? content.map((part) => getSlice(typeof part === "string" ? part : record(part).text)).find(Boolean);
      const length = s?.visibleLength ?? 0;
      const text = s?.page.slice(0, Math.min(4096, Math.max(0, length - this.textOffset))) ?? "";
      const imageCount = Math.max(content.filter((part) => record(part).type === "input_image").length,
        s?.images ?? 0);
      if (!length && !imageCount) return;
      return { kind: "question", turnId, id, text, textLength: length, imageCount, source: "user", replay };
    }
    if (type === "message" && item.role === "assistant" || ["agentmessage", "assistantmessage", "functioncall", "customtoolcall", "reasoning"].includes(type ?? "")) {
      return { kind: "anchor", turnId, id };
    }
  }
}
