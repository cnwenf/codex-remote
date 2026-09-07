import { closeSync, openSync, readSync, statSync, renameSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { QuestionContext, QuestionContextRequest } from "../protocol/question-context";
import { QuestionRecordReader, type QuestionRecord } from "./question-records";

const BLOCK = 64 * 1024;
type FileRow = { path: string; thread: string; generation: string; identity: string; size: number; mtime: number; ctime: number;
  fingerprint: string; scanned: number; observed: number; turn: string | null; error: string | null; barrier: number };
type QuestionRow = { id: string; text: string; length: number; images: number; source: "user" | "delegated";
  source_thread: string | null; start: number; end: number };

// All instances share two read slots; the queue is also bounded.
let active = 0;
const queue: Array<() => Promise<void>> = [];
function pump() {
  while (active < 2 && queue.length) {
    const task = queue.shift()!;
    active++;
    void task().finally(() => { active--; pump(); });
  }
}

/** The caller supplies a rollout path already checked against Desktop's roots. */
export class QuestionIndex {
  private db: DatabaseSync;
  private closed = false;
  private jobs = new Set<string>();
  private handles = new Set<FileHandle>();
  // At most 64 continuation pages (well below the 8 MiB memory ceiling).
  private pages = new Map<string, { generation: string; text?: string; error?: string }>();

  constructor(databasePath: string) {
    this.db = new DatabaseSync(databasePath);
    try { this.initialize(); }
    catch (error) {
      this.db.close();
      if (![11, 26].includes((error as { errcode?: number }).errcode ?? 0)) throw error;
      // Only this Remote-owned cache is moved; rollout files are never mutated.
      renameSync(databasePath, databasePath + ".corrupt-" + randomUUID());
      this.db = new DatabaseSync(databasePath);
      this.initialize();
    }
  }

  private initialize() {
    this.db.exec(`PRAGMA cache_size=-2048; PRAGMA max_page_count=32768; PRAGMA journal_mode=DELETE;
      CREATE TABLE IF NOT EXISTS question_files (
        path TEXT PRIMARY KEY, thread TEXT NOT NULL, generation TEXT NOT NULL, identity TEXT NOT NULL,
        size INTEGER NOT NULL, mtime REAL NOT NULL, ctime REAL NOT NULL, fingerprint TEXT NOT NULL,
        scanned INTEGER NOT NULL DEFAULT 0, observed INTEGER NOT NULL DEFAULT -1, turn TEXT, error TEXT, barrier INTEGER NOT NULL DEFAULT 0);
      CREATE TABLE IF NOT EXISTS questions (
        generation TEXT NOT NULL, thread TEXT NOT NULL, turn TEXT NOT NULL, id TEXT NOT NULL,
        text TEXT NOT NULL, length INTEGER NOT NULL, images INTEGER NOT NULL, source TEXT NOT NULL,
        source_thread TEXT, start INTEGER NOT NULL, end INTEGER NOT NULL,
        PRIMARY KEY(generation, thread, turn, id));
      CREATE INDEX IF NOT EXISTS question_latest ON questions(generation, thread, turn, start DESC);
      CREATE TABLE IF NOT EXISTS question_anchors (
        generation TEXT NOT NULL, thread TEXT NOT NULL, turn TEXT NOT NULL, id TEXT NOT NULL, question TEXT,
        PRIMARY KEY(generation, thread, turn, id));`);
  }

  read(path: string, request: QuestionContextRequest): QuestionContext {
    const base = { threadId: request.threadId, turnId: request.turnId, ...(request.anchorItemId ? { anchorItemId: request.anchorItemId } : {}) };
    if (this.closed) return { ...base, state: "error", revision: "closed", message: "问题索引已关闭" };
    if (!request.threadId || !request.turnId || request.threadId.length > 1024 || request.turnId.length > 1024 ||
      (request.anchorItemId !== undefined && (!request.anchorItemId || request.anchorItemId.length > 1024)) ||
      (request.textOffset !== undefined && (!Number.isSafeInteger(request.textOffset) || request.textOffset < 0))) {
      return { ...base, state: "error", revision: "invalid", message: "问题定位参数无效" };
    }
    try {
      const file = this.validate(path, request.threadId);
      const revision = file.generation;
      if (file.error) return { ...base, state: "error", revision, message: file.error };
      if (file.observed < file.size) this.schedule("scan:" + revision, () => this.scan(file));
      if (!request.anchorItemId && file.observed < file.size) return { ...base, state: "pending", revision };
      const q = (request.anchorItemId
        ? this.db.prepare(`SELECT q.* FROM question_anchors a JOIN questions q ON q.generation=a.generation AND q.thread=a.thread
            AND q.turn=a.turn AND q.id=a.question WHERE a.generation=? AND a.thread=? AND a.turn=? AND a.id=?`)
          .get(revision, request.threadId, request.turnId, request.anchorItemId)
        : this.db.prepare("SELECT * FROM questions WHERE generation=? AND thread=? AND turn=? AND start>=? ORDER BY start DESC LIMIT 1")
          .get(revision, request.threadId, request.turnId, file.barrier)) as QuestionRow | undefined;
      if (!q) return { ...base, state: file.observed < file.size ? "pending" : "not_found", revision };
      const offset = request.textOffset ?? 0;
      let text = offset === 0 ? q.text : offset >= q.length ? "" : undefined;
      if (text === undefined) {
        const key = JSON.stringify([revision, request.threadId, request.turnId, request.anchorItemId, q.id, offset]);
        const page = this.pages.get(key);
        if (page?.error) return { ...base, state: "error", revision, message: page.error };
        text = page?.text;
        if (text === undefined) {
          this.schedule("page:" + key, () => this.page(file, q, offset, key));
          return { ...base, state: "pending", revision };
        }
      }
      const next = offset + text.length;
      return { ...base, state: "ready", revision, question: {
        id: q.id, text, imageCount: q.images, source: q.source,
        ...(q.source_thread ? { sourceThreadId: q.source_thread } : {}),
        truncated: next < q.length, textOffset: offset, ...(next < q.length ? { nextTextOffset: next } : {}),
      } };
    } catch { return { ...base, state: "error", revision: "unavailable", message: "无法读取问题记录" }; }
  }

  private fingerprint(path: string, size: number) {
    const fd = openSync(path, "r");
    try {
      const prefix = Buffer.alloc(Math.min(256, size));
      const suffix = Buffer.alloc(Math.min(256, size));
      readSync(fd, prefix, 0, prefix.length, 0);
      readSync(fd, suffix, 0, suffix.length, Math.max(0, size - suffix.length));
      return createHash("sha256").update(prefix).update(suffix).digest("hex");
    } finally { closeSync(fd); }
  }

  private validate(path: string, thread: string): FileRow {
    const stat = statSync(path);
    if (!stat.isFile()) throw new Error("Not a file");
    const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
    let row = this.db.prepare("SELECT * FROM question_files WHERE path=?").get(path) as FileRow | undefined;
    const invalid = !row || row.thread !== thread || row.identity !== identity || stat.size < row.size ||
      (stat.size === row.size && (stat.mtimeMs !== row.mtime || stat.ctimeMs !== row.ctime)) ||
      (stat.size > row.size && this.fingerprint(path, row.size) !== row.fingerprint);
    if (invalid) {
      if (row) {
        for (const [key, page] of this.pages) if (page.generation === row.generation) this.pages.delete(key);
        this.db.prepare("DELETE FROM questions WHERE generation=?").run(row.generation);
        this.db.prepare("DELETE FROM question_anchors WHERE generation=?").run(row.generation);
      }
      row = { path, thread, generation: randomUUID(), identity, size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs,
        fingerprint: this.fingerprint(path, stat.size), scanned: 0, observed: -1, turn: null, error: null, barrier: 0 };
      this.db.prepare(`INSERT OR REPLACE INTO question_files VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
        path, thread, row.generation, identity, row.size, row.mtime, row.ctime, row.fingerprint, 0, -1, null, null, 0);
    } else if (row && stat.size !== row.size) {
      row = { ...row, size: stat.size, mtime: stat.mtimeMs, ctime: stat.ctimeMs, fingerprint: this.fingerprint(path, stat.size) };
      this.db.prepare("UPDATE question_files SET size=?,mtime=?,ctime=?,fingerprint=? WHERE path=?").run(
        row.size, row.mtime, row.ctime, row.fingerprint, path);
    }
    return row!;
  }

  private schedule(key: string, work: () => Promise<void>) {
    if (this.jobs.has(key) || queue.length >= 32 || this.jobs.size >= 32) return;
    this.jobs.add(key);
    queue.push(async () => {
      try { if (!this.closed) await work(); }
      catch { /* Work records its own generation-scoped failure. */ }
      finally { this.jobs.delete(key); }
    });
    pump();
  }

  private current(file: FileRow) {
    return !this.closed && this.validate(file.path, file.thread).generation === file.generation;
  }

  private saveRecord(file: FileRow, entry: QuestionRecord | undefined, start: number, end: number) {
    if (!entry) return;
    if (entry.kind === "turn") { file.turn = entry.turnId ?? null; return; }
    const turn = entry.turnId ?? file.turn;
    if (!turn || !entry.id) return;
    if (entry.kind === "question") {
      if (entry.replay) return;
      this.db.prepare(`INSERT OR IGNORE INTO questions VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
        file.generation, file.thread, turn, entry.id, entry.text ?? "", entry.textLength ?? 0, entry.imageCount ?? 0,
        entry.source ?? "user", entry.sourceThreadId ?? null, start, end);
    } else {
      const q = this.db.prepare("SELECT id FROM questions WHERE generation=? AND thread=? AND turn=? AND start>=? ORDER BY start DESC LIMIT 1")
        .get(file.generation, file.thread, turn, file.barrier) as { id: string } | undefined;
      this.db.prepare("INSERT OR IGNORE INTO question_anchors VALUES(?,?,?,?,?)").run(file.generation, file.thread, turn, entry.id, q?.id ?? null);
    }
  }

  private async scan(file: FileRow) {
    let handle: FileHandle | undefined;
    try {
      handle = await open(file.path, "r");
      this.handles.add(handle);
      let position = file.scanned;
      let start = position;
      let reader = new QuestionRecordReader();
      const block = Buffer.alloc(BLOCK);
      while (!this.closed && position < file.size) {
        const { bytesRead } = await handle.read(block, 0, Math.min(BLOCK, file.size - position), position);
        if (!bytesRead || !this.current(file)) return;
        this.db.exec("BEGIN");
        try {
          let cursor = 0;
          for (let n = 0; n < bytesRead; n++) if (block[n] === 10) {
            reader.write(block.subarray(cursor, n));
            const end = position + n + 1;
            const entry = reader.finish();
            if (!reader.valid) file.barrier = end;
            this.saveRecord(file, entry, start, end);
            file.scanned = end;
            start = end;
            reader = new QuestionRecordReader();
            cursor = n + 1;
          }
          reader.write(block.subarray(cursor, bytesRead));
          this.db.prepare("UPDATE question_files SET scanned=?,turn=?,barrier=? WHERE generation=?").run(file.scanned, file.turn, file.barrier, file.generation);
          this.db.exec("COMMIT");
        } catch (error) { this.db.exec("ROLLBACK"); throw error; }
        position += bytesRead;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (this.current(file)) this.db.prepare("UPDATE question_files SET observed=? WHERE generation=?").run(file.size, file.generation);
    } catch {
      if (!this.closed) this.db.prepare("UPDATE question_files SET error=? WHERE generation=?").run("问题索引读取失败", file.generation);
    } finally { if (handle) { this.handles.delete(handle); await handle.close().catch(() => {}); } }
  }

  private async page(file: FileRow, question: QuestionRow, offset: number, key: string) {
    let handle: FileHandle | undefined;
    try {
      handle = await open(file.path, "r");
      this.handles.add(handle);
      const reader = new QuestionRecordReader(offset);
      const block = Buffer.alloc(BLOCK);
      for (let position = question.start; position < question.end && !this.closed;) {
        const { bytesRead } = await handle.read(block, 0, Math.min(BLOCK, question.end - position), position);
        if (!this.current(file)) return;
        if (!bytesRead) throw new Error("Incomplete question record");
        reader.write(block.subarray(0, bytesRead));
        position += bytesRead;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      const entry = reader.finish();
      if (!this.current(file)) return;
      if (entry?.id === question.id && entry.kind === "question") {
        if (this.pages.size >= 64) this.pages.delete(this.pages.keys().next().value!);
        this.pages.set(key, { generation: file.generation, text: entry.text ?? "" });
      } else throw new Error("Invalid question record");
    } catch {
      if (!this.closed && (this.db.prepare("SELECT generation FROM question_files WHERE path=?").get(file.path) as { generation?: string } | undefined)?.generation === file.generation) {
        if (this.pages.size >= 64) this.pages.delete(this.pages.keys().next().value!);
        this.pages.set(key, { generation: file.generation, error: "无法读取问题后续内容" });
      }
    } finally { if (handle) { this.handles.delete(handle); await handle.close().catch(() => {}); } }
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    this.pages.clear();
    for (const handle of this.handles) void handle.close().catch(() => {});
    this.db.close();
  }
}
