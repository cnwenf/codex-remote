import { closeSync, openSync, readSync, statSync, renameSync } from "node:fs";
import { open, type FileHandle } from "node:fs/promises";
import { createHash, randomUUID } from "node:crypto";
import { DatabaseSync } from "node:sqlite";
import type { QuestionContext, QuestionContextRequest } from "../protocol/question-context";
import { QuestionRecordReader, type QuestionRecord } from "./question-records";

const BLOCK = 64 * 1024;
const TAIL_BYTES = 256 * 1024;
const INDEX_VERSION = 3;
type FileRow = { path: string; thread: string; generation: string; identity: string; size: number; mtime: number; ctime: number;
  fingerprint: string; scanned: number; observed: number; turn: string | null; error: string | null; barrier: number };
type QuestionRow = { id: string; text: string; length: number; images: number; source: "user" | "delegated";
  source_thread: string | null; start: number; end: number };
type TailRow = { start: number; scanned: number; observed: number; turn: string | null; barrier: number };

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
        start INTEGER NOT NULL DEFAULT 0, PRIMARY KEY(generation, thread, turn, id));
      CREATE TABLE IF NOT EXISTS question_tails (
        generation TEXT PRIMARY KEY, start INTEGER NOT NULL, scanned INTEGER NOT NULL,
        observed INTEGER NOT NULL, turn TEXT, barrier INTEGER NOT NULL);`);
    // Additive schema migration preserves existing columns; version changes below invalidate stale semantics.
    const columns = this.db.prepare("PRAGMA table_info(question_anchors)").all() as { name: string }[];
    if (!columns.some((column) => column.name === "start")) this.db.exec("ALTER TABLE question_anchors ADD COLUMN start INTEGER NOT NULL DEFAULT 0");
    const version = this.db.prepare("PRAGMA user_version").get() as { user_version: number };
    if (version.user_version !== INDEX_VERSION) this.db.exec(`BEGIN;
      DELETE FROM question_anchors; DELETE FROM questions; DELETE FROM question_files; DELETE FROM question_tails;
      PRAGMA user_version=${INDEX_VERSION}; COMMIT;`);
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
      let tail = this.db.prepare("SELECT * FROM question_tails WHERE generation=?").get(revision) as TailRow | undefined;
      const latest = file.observed >= file.size ? file : tail && tail.observed >= file.size ? tail : undefined;
      const q = (request.anchorItemId
        ? this.db.prepare(`SELECT q.* FROM question_anchors a JOIN questions q ON q.generation=a.generation AND q.thread=a.thread
            AND q.turn=a.turn AND q.id=a.question WHERE a.generation=? AND a.thread=? AND a.turn=? AND a.id=?`)
          .get(revision, request.threadId, request.turnId, request.anchorItemId)
        : latest && this.db.prepare("SELECT * FROM questions WHERE generation=? AND thread=? AND turn=? AND start>=? ORDER BY start DESC LIMIT 1")
          .get(revision, request.threadId, request.turnId, latest.barrier)) as QuestionRow | undefined;
      if (!q) {
        if (file.observed < file.size) this.schedule("scan:" + revision, async () => {
          // Try a bounded suffix before scanning old history. Never carry turn/question state across the gap.
          // Once present, retain the suffix checkpoint even for a large append.
          if (!tail && file.size - file.scanned > TAIL_BYTES) {
            const start = file.size - TAIL_BYTES;
            tail = { start, scanned: start, observed: -1, turn: null, barrier: start };
            this.db.prepare("INSERT OR REPLACE INTO question_tails VALUES(?,?,?,?,?,?)").run(revision, start, start, -1, null, start);
          }
          if (tail && tail.observed < file.size && tail.scanned > file.scanned) {
            await this.scan({ ...file, ...tail }, true, tail.scanned === tail.start);
          } else await this.scan(file);
        });
        return { ...base, state: file.observed < file.size ? "pending" : "not_found", revision };
      }
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
        this.db.prepare("DELETE FROM question_tails WHERE generation=?").run(row.generation);
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

  private saveRecord(file: FileRow, entry: QuestionRecord | undefined, start: number, end: number, tail: boolean) {
    if (!entry) return;
    if (entry.kind === "question" && entry.replay) return;
    // An explicitly foreign completion is historical replay, not a change of turn.
    if (tail && entry.kind === "anchor" && entry.replay && entry.turnId !== undefined && entry.turnId !== file.turn) return;
    if (entry.kind === "turn") {
      // turn_context can repeat after mid-turn compaction. Only task_started proves
      // the suffix includes the whole turn, including earlier occurrences of an anchor ID.
      if (!tail || entry.turnStart) file.turn = entry.turnId ?? null;
      else if (entry.turnId !== file.turn) { file.turn = null; file.barrier = end; }
      return;
    }
    const turn = entry.turnId ?? file.turn;
    if (tail && (!file.turn || turn !== file.turn)) {
      file.turn = null;
      file.barrier = end;
      return;
    }
    if (!turn || !entry.id) return;
    if (entry.kind === "question") {
      this.db.prepare(`INSERT INTO questions VALUES(?,?,?,?,?,?,?,?,?,?,?)
        ON CONFLICT(generation,thread,turn,id) DO UPDATE SET text=excluded.text,length=excluded.length,
          images=excluded.images,source=excluded.source,source_thread=excluded.source_thread,start=excluded.start,end=excluded.end
        WHERE excluded.start < questions.start`).run(
        file.generation, file.thread, turn, entry.id, entry.text ?? "", entry.textLength ?? 0, entry.imageCount ?? 0,
        entry.source ?? "user", entry.sourceThreadId ?? null, start, end);
    } else {
      const q = this.db.prepare("SELECT id FROM questions WHERE generation=? AND thread=? AND turn=? AND start>=? AND start<? ORDER BY start DESC LIMIT 1")
        .get(file.generation, file.thread, turn, file.barrier, start) as { id: string } | undefined;
      // Preserve the first occurrence even when it has no attributable question.
      this.db.prepare(`INSERT INTO question_anchors VALUES(?,?,?,?,?,?)
        ON CONFLICT(generation,thread,turn,id) DO UPDATE SET question=excluded.question,start=excluded.start
        WHERE excluded.start < question_anchors.start`).run(file.generation, file.thread, turn, entry.id, q?.id ?? null, start);
    }
  }

  private async scan(file: FileRow, tail = false, skipFirst = false) {
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
            const end = position + n + 1;
            if (skipFirst) skipFirst = false;
            else {
              reader.write(block.subarray(cursor, n));
              const entry = reader.finish();
              if (!reader.valid) { file.barrier = end; if (tail) file.turn = null; }
              this.saveRecord(file, entry, start, end, tail);
            }
            file.scanned = end;
            start = end;
            reader = new QuestionRecordReader();
            cursor = n + 1;
          }
          if (!skipFirst) reader.write(block.subarray(cursor, bytesRead));
          this.db.prepare(`UPDATE ${tail ? "question_tails" : "question_files"} SET scanned=?,turn=?,barrier=? WHERE generation=?`).run(file.scanned, file.turn, file.barrier, file.generation);
          this.db.exec("COMMIT");
        } catch (error) { this.db.exec("ROLLBACK"); throw error; }
        position += bytesRead;
        await new Promise<void>((resolve) => setImmediate(resolve));
      }
      if (this.current(file)) this.db.prepare(`UPDATE ${tail ? "question_tails" : "question_files"} SET observed=? WHERE generation=?`).run(file.size, file.generation);
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
