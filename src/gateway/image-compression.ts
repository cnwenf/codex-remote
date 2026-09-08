import { execFile } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { chmod, mkdir, rm, stat } from "node:fs/promises";
import { join } from "node:path";
import { promisify } from "node:util";
import { MAX_TRANSFER_IMAGE_BYTES } from "../protocol/image-transfer";

const execFileAsync = promisify(execFile);
const SIPS = "/usr/bin/sips";
const MAX_PIXELS = 80_000_000;
const MAX_EDGE = 2_048;
const JPEG_QUALITIES = [90, 80, 70, 60];
const MAX_RESIZE_STEPS = 6;
const PROCESS_TIMEOUT_MS = 5_000;
const TOTAL_TIMEOUT_MS = 20_000;
const MAX_ACTIVE = 2;
const MAX_WAITING = 16;
const MAX_CACHE_ENTRIES = 100;

export type GatewayImageSource = {
  path: string;
  name: string;
  mimeType: string;
  size: number;
};

export type GatewayTransferImage = GatewayImageSource & { release?: () => void };

type CacheEntry = GatewayTransferImage & { users: number; lastUsed: number };
type Flight = { promise: Promise<CacheEntry> };
type RunSips = (args: string[], timeoutMs: number) => Promise<string>;

export class GatewayImageCompressionError extends Error {
  constructor(message: string, readonly status: number) { super(message); }
}

export class GatewayImageCompressor {
  private readonly cache = new Map<string, CacheEntry>();
  private readonly flights = new Map<string, Flight>();
  private readonly queue: Array<{
    deadline: number;
    run: () => Promise<void>;
    reject: (error: Error) => void;
    timer: ReturnType<typeof setTimeout>;
  }> = [];
  private active = 0;
  private reserved = 0;
  private closed = false;
  private initialized?: Promise<void>;

  constructor(
    private readonly cacheRoot: string,
    private readonly runSips: RunSips = systemSips,
    private readonly platform = process.platform,
  ) {}

  async open(source: GatewayImageSource): Promise<GatewayTransferImage> {
    if (source.size <= MAX_TRANSFER_IMAGE_BYTES) return source;
    if (this.platform !== "darwin") {
      throw new GatewayImageCompressionError("image-compression-unavailable", 500);
    }
    if (this.closed) throw new GatewayImageCompressionError("image-compressor-closed", 503);
    const info = await stat(source.path);
    const key = createHash("sha256")
      .update(source.path).update("\0").update(String(info.mtimeMs)).update("\0").update(String(info.size))
      .digest("hex");
    const cached = this.cache.get(key);
    if (cached) {
      cached.lastUsed = Date.now();
      return this.lease(cached);
    }
    const current = this.flights.get(key);
    if (current) return this.lease(await current.promise);
    const deadline = Date.now() + TOTAL_TIMEOUT_MS;
    const flight: Flight = { promise: Promise.resolve(undefined as never) };
    flight.promise = (async () => {
      await this.reserveCacheSlot();
      try {
        return await this.schedule(deadline, () => this.compress(source, key, deadline));
      } catch (cause) {
        this.reserved = Math.max(0, this.reserved - 1);
        throw cause;
      }
    })();
    this.flights.set(key, flight);
    try {
      return this.lease(await flight.promise);
    } finally {
      this.flights.delete(key);
    }
  }

  async close() {
    this.closed = true;
    while (this.queue.length > 0) {
      const waiting = this.queue.shift()!;
      clearTimeout(waiting.timer);
      waiting.reject(new GatewayImageCompressionError("image-compressor-closed", 503));
    }
    await Promise.allSettled([...this.flights.values()].map((flight) => flight.promise));
    this.cache.clear();
    this.reserved = 0;
    await removeDerived(this.cacheRoot, true);
  }

  private async compress(source: GatewayImageSource, key: string, deadline: number) {
    await this.ensureCacheRoot();
    const metadata = await this.run(deadline, ["-g", "pixelWidth", "-g", "pixelHeight", source.path]);
    const width = property(metadata, "pixelWidth");
    const height = property(metadata, "pixelHeight");
    if (!width || !height || width * height > MAX_PIXELS) {
      throw new GatewayImageCompressionError("image-dimensions-invalid", 413);
    }
    let dimensions = boundedDimensions(width, height, MAX_EDGE);
    const output = join(this.cacheRoot, `${key}.${randomUUID()}.jpg`);
    let retained = false;
    try {
      for (const quality of JPEG_QUALITIES) {
        const result = await this.encode(source.path, output, dimensions.width, dimensions.height, quality, deadline);
        if (result <= MAX_TRANSFER_IMAGE_BYTES) {
          retained = true;
          return this.remember(key, source, output, result);
        }
      }
      for (let step = 0; step < MAX_RESIZE_STEPS; step += 1) {
        dimensions = {
          width: Math.max(1, Math.round(dimensions.width * 0.75)),
          height: Math.max(1, Math.round(dimensions.height * 0.75)),
        };
        const result = await this.encode(source.path, output, dimensions.width, dimensions.height, 60, deadline);
        if (result <= MAX_TRANSFER_IMAGE_BYTES) {
          retained = true;
          return this.remember(key, source, output, result);
        }
      }
      throw new GatewayImageCompressionError("image-compression-too-large", 500);
    } finally {
      if (!retained) await removeDerived(output);
    }
  }

  private async encode(source: string, output: string, width: number, height: number, quality: number, deadline: number) {
    await removeDerived(output);
    await this.run(deadline, [
      "-s", "format", "jpeg",
      "-s", "formatOptions", String(quality),
      "-Z", String(Math.max(width, height)),
      "--padColor", "FFFFFF",
      source, "--out", output,
    ]);
    const info = await stat(output);
    if (!info.isFile() || info.size <= 0) throw new GatewayImageCompressionError("image-compression-failed", 500);
    await chmod(output, 0o600);
    return info.size;
  }

  private remember(key: string, source: GatewayImageSource, path: string, size: number) {
    const entry: CacheEntry = {
      ...source,
      name: `${source.name.replace(/\.[^.]*$/, "") || "image"}.jpg`,
      mimeType: "image/jpeg",
      path,
      size,
      users: 0,
      lastUsed: Date.now(),
    };
    this.cache.set(key, entry);
    return entry;
  }

  private lease(entry: CacheEntry): GatewayTransferImage {
    entry.users += 1;
    let released = false;
    return {
      path: entry.path,
      name: entry.name,
      mimeType: entry.mimeType,
      size: entry.size,
      release: () => {
        if (released) return;
        released = true;
        entry.users = Math.max(0, entry.users - 1);
        entry.lastUsed = Date.now();
      },
    };
  }

  private async reserveCacheSlot() {
    if (this.reserved < MAX_CACHE_ENTRIES) {
      this.reserved += 1;
      return;
    }
    const victim = [...this.cache.entries()]
      .filter(([, candidate]) => candidate.users === 0)
      .sort((a, b) => a[1].lastUsed - b[1].lastUsed)[0];
    if (!victim) throw new GatewayImageCompressionError("image-compression-busy", 503);
    this.cache.delete(victim[0]);
    try {
      await removeDerived(victim[1].path);
    } catch (cause) {
      this.cache.set(victim[0], victim[1]);
      throw cause;
    }
    // The evicted entry's reservation is transferred to this compression.
  }

  private ensureCacheRoot() {
    this.initialized ??= (async () => {
      await removeDerived(this.cacheRoot, true);
      await mkdir(this.cacheRoot, { recursive: true, mode: 0o700 });
      await chmod(this.cacheRoot, 0o700);
    })();
    return this.initialized;
  }

  private schedule<T>(deadline: number, task: () => Promise<T>): Promise<T> {
    if (this.active < MAX_ACTIVE) return this.start(task);
    if (this.queue.length >= MAX_WAITING) {
      return Promise.reject(new GatewayImageCompressionError("image-compression-busy", 503));
    }
    return new Promise<T>((resolve, reject) => {
      const waiting = {
        deadline,
        reject,
        run: async () => {
          try { resolve(await this.start(task)); } catch (cause) { reject(asError(cause)); }
        },
        timer: setTimeout(() => {
          const index = this.queue.indexOf(waiting);
          if (index >= 0) this.queue.splice(index, 1);
          reject(new GatewayImageCompressionError("image-compression-timeout", 503));
        }, Math.max(1, deadline - Date.now())),
      };
      this.queue.push(waiting);
    });
  }

  private async start<T>(task: () => Promise<T>): Promise<T> {
    this.active += 1;
    try { return await task(); } finally {
      this.active -= 1;
      const waiting = this.queue.shift();
      if (waiting) {
        clearTimeout(waiting.timer);
        if (waiting.deadline <= Date.now()) waiting.reject(new GatewayImageCompressionError("image-compression-timeout", 503));
        else void waiting.run();
      }
    }
  }

  private run(deadline: number, args: string[]) {
    const remaining = deadline - Date.now();
    if (remaining <= 0) throw new GatewayImageCompressionError("image-compression-timeout", 503);
    return this.runSips(args, Math.min(PROCESS_TIMEOUT_MS, remaining));
  }
}

async function systemSips(args: string[], timeoutMs: number) {
  try {
    const { stdout } = await execFileAsync(SIPS, args, { encoding: "utf8", timeout: timeoutMs, maxBuffer: 64 * 1024 });
    return stdout;
  } catch (cause) {
    const timedOut = cause instanceof Error && "killed" in cause && cause.killed;
    throw new GatewayImageCompressionError(timedOut ? "image-compression-timeout" : "image-compression-failed", timedOut ? 503 : 500);
  }
}

function property(output: string, name: string) {
  const match = new RegExp(`\\b${name}:\\s*(\\d+)`).exec(output);
  return match ? Number.parseInt(match[1], 10) : 0;
}

function boundedDimensions(width: number, height: number, longestEdge: number) {
  const scale = Math.min(1, longestEdge / Math.max(width, height));
  return { width: Math.max(1, Math.round(width * scale)), height: Math.max(1, Math.round(height * scale)) };
}

function asError(cause: unknown) { return cause instanceof Error ? cause : new Error("image-compression-failed"); }

async function removeDerived(path: string, recursive = false) {
  try { await rm(path, { recursive, force: true }); } catch {
    throw new GatewayImageCompressionError("image-cache-cleanup-failed", 500);
  }
}
