// @vitest-environment node

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterEach, describe, expect, it } from "vitest";
import { MAX_TRANSFER_IMAGE_BYTES } from "../protocol/image-transfer";
import { createHighEntropyPng, withExifOrientation } from "../test/high-entropy-png";
import { GatewayImageCompressor, GatewayImageCompressionError } from "./image-compression";
import { ImageUploadStore, MAX_IMAGE_BYTES } from "./image-upload-store";

const execFileAsync = promisify(execFile);

const directories: string[] = [];
afterEach(async () => Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))));

describe("Gateway image transfer compression", () => {
  it("returns a real bounded JPEG transfer copy without changing the high-entropy PNG", async () => {
    const root = await temporaryDirectory();
    const original = createHighEntropyPng();
    expect(original.byteLength).toBeGreaterThan(MAX_TRANSFER_IMAGE_BYTES);
    expect(original.byteLength).toBeLessThan(MAX_IMAGE_BYTES);
    const store = new ImageUploadStore(root);
    const saved = await store.save(original, "image/png", "noise.png");

    const transfer = await store.openTransfer(saved.id);
    try {
      expect(transfer.mimeType).toBe("image/jpeg");
      expect(transfer.size).toBeLessThanOrEqual(MAX_TRANSFER_IMAGE_BYTES);
      expect(await readFile(saved.path)).toEqual(original);
      expect(transfer.path).not.toBe(saved.path);
      const { stdout } = await execFileAsync("/usr/bin/sips", ["-g", "pixelWidth", "-g", "pixelHeight", transfer.path], { encoding: "utf8" });
      const width = Number(/pixelWidth:\s*(\d+)/.exec(stdout)?.[1]);
      const height = Number(/pixelHeight:\s*(\d+)/.exec(stdout)?.[1]);
      expect(Math.max(width, height)).toBeLessThan(2_048);
      expect(width / height).toBeCloseTo(2_200 / 1_400, 2);
    } finally {
      transfer.release?.();
      await store.close();
    }
  }, 30_000);

  it("coalesces concurrent requests for the same source into one transfer copy", async () => {
    const root = await temporaryDirectory();
    const original = createHighEntropyPng();
    const store = new ImageUploadStore(root);
    const saved = await store.save(original, "image/png", "noise.png");

    const transfers = await Promise.all(Array.from({ length: 6 }, () => store.openTransfer(saved.id)));
    expect(new Set(transfers.map((transfer) => transfer.path))).toHaveLength(1);
    transfers.forEach((transfer) => transfer.release?.());
    await store.close();
  }, 30_000);

  it("flattens a transparent high-entropy PNG onto white", async () => {
    const root = await temporaryDirectory();
    const original = createHighEntropyPng(1_200, 900, true);
    expect(original.byteLength).toBeGreaterThan(MAX_TRANSFER_IMAGE_BYTES);
    const store = new ImageUploadStore(root);
    const saved = await store.save(original, "image/png", "transparent.png");
    const transfer = await store.openTransfer(saved.id);
    const bitmap = join(root, "flattened.bmp");
    try {
      await execFileAsync("/usr/bin/sips", ["-s", "format", "bmp", transfer.path, "--out", bitmap]);
      const bytes = await readFile(bitmap);
      const pixels = bytes.readUInt32LE(10);
      expect([...bytes.subarray(pixels, pixels + 3)].every((channel) => channel >= 245)).toBe(true);
    } finally {
      transfer.release?.();
      await store.close();
    }
  }, 30_000);

  it("keeps an EXIF-rotated camera JPEG portrait without stretching or mirroring", async () => {
    const root = await temporaryDirectory();
    const png = join(root, "camera-source.png");
    const jpeg = join(root, "camera-source.jpg");
    await writeFile(png, createHighEntropyPng());
    await execFileAsync("/usr/bin/sips", ["-s", "format", "jpeg", "-s", "formatOptions", "90", png, "--out", jpeg]);
    const oriented = withExifOrientation(await readFile(jpeg), 6);
    expect(oriented.byteLength).toBeGreaterThan(MAX_TRANSFER_IMAGE_BYTES);
    const store = new ImageUploadStore(join(root, "uploads"));
    const saved = await store.save(oriented, "image/jpeg", "camera.jpg");
    const transfer = await store.openTransfer(saved.id);
    try {
      const bitmap = join(root, "camera-transfer.bmp");
      await execFileAsync("/usr/bin/sips", ["-s", "format", "bmp", transfer.path, "--out", bitmap]);
      const bytes = await readFile(bitmap);
      const width = Math.abs(bytes.readInt32LE(18));
      const height = Math.abs(bytes.readInt32LE(22));
      expect(width).toBeLessThan(height);
      expect(height / width).toBeCloseTo(2_200 / 1_400, 2);
    } finally {
      transfer.release?.();
      await store.close();
    }
  }, 30_000);

  it("rejects an over-capacity queue with a retryable error while running at most two jobs", async () => {
    const root = await temporaryDirectory();
    let activeEncodes = 0;
    let maxActiveEncodes = 0;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const runSips = async (args: string[], timeoutMs: number) => {
      expect(timeoutMs).toBeLessThanOrEqual(5_000);
      if (args.includes("pixelWidth")) return "pixelWidth: 2200\npixelHeight: 1400\n";
      activeEncodes += 1;
      maxActiveEncodes = Math.max(maxActiveEncodes, activeEncodes);
      await gate;
      activeEncodes -= 1;
      await writeFile(args.at(-1)!, Buffer.alloc(100));
      return "";
    };
    const compressor = new GatewayImageCompressor(join(root, "cache"), runSips, "darwin");
    const sources = await Promise.all(Array.from({ length: 19 }, async (_, index) => {
      const path = join(root, `source-${index}.png`);
      await writeFile(path, "source");
      return { path, name: `source-${index}.png`, mimeType: "image/png", size: MAX_TRANSFER_IMAGE_BYTES + 1 };
    }));
    const accepted: Array<ReturnType<GatewayImageCompressor["open"]>> = [];
    for (const source of sources.slice(0, 18)) {
      accepted.push(compressor.open(source));
      await new Promise<void>((resolve) => setImmediate(resolve));
    }
    await expect.poll(() => maxActiveEncodes).toBe(2);
    await expect(compressor.open(sources[18])).rejects.toEqual(expect.objectContaining({
      message: "image-compression-busy", status: 503,
    }));
    release();
    const transfers = await Promise.all(accepted);
    transfers.forEach((transfer) => transfer.release?.());
    await compressor.close();
  }, 10_000);

  it("rejects abnormal pixel counts before encoding and never returns an oversized original", async () => {
    const root = await temporaryDirectory();
    const source = join(root, "huge.png");
    await writeFile(source, "source");
    let calls = 0;
    const compressor = new GatewayImageCompressor(join(root, "cache"), async () => {
      calls += 1;
      return "pixelWidth: 10000\npixelHeight: 9000\n";
    }, "darwin");

    await expect(compressor.open({
      path: source, name: "huge.png", mimeType: "image/png", size: MAX_TRANSFER_IMAGE_BYTES + 1,
    })).rejects.toEqual(expect.objectContaining({ message: "image-dimensions-invalid", status: 413 }));
    expect(calls).toBe(1);
    await compressor.close();
  });

  it("does not return an oversized original when the platform codec is unavailable", async () => {
    const root = await temporaryDirectory();
    const source = join(root, "large.png");
    await writeFile(source, "source");
    const compressor = new GatewayImageCompressor(join(root, "cache"), async () => "", "linux");

    await expect(compressor.open({
      path: source, name: "large.png", mimeType: "image/png", size: MAX_TRANSFER_IMAGE_BYTES + 1,
    })).rejects.toBeInstanceOf(GatewayImageCompressionError);
    await compressor.close();
  });

  it("cleans stale derived files and caps the cache at 100 without evicting active leases", async () => {
    const root = await temporaryDirectory();
    const cacheRoot = join(root, "cache");
    await mkdir(cacheRoot);
    await writeFile(join(cacheRoot, "stale.jpg"), "stale");
    const runSips = async (args: string[]) => {
      if (args.includes("pixelWidth")) return "pixelWidth: 2200\npixelHeight: 1400\n";
      await writeFile(args.at(-1)!, Buffer.alloc(100));
      return "";
    };
    const compressor = new GatewayImageCompressor(cacheRoot, runSips, "darwin");
    const sources = await Promise.all(Array.from({ length: 101 }, async (_, index) => {
      const path = join(root, `cache-source-${index}.png`);
      await writeFile(path, "source");
      return { path, name: `source-${index}.png`, mimeType: "image/png", size: MAX_TRANSFER_IMAGE_BYTES + 1 };
    }));
    const leases = [];
    for (const source of sources.slice(0, 100)) leases.push(await compressor.open(source));

    expect(await readdir(cacheRoot)).toHaveLength(100);
    await expect(compressor.open(sources[100])).rejects.toEqual(expect.objectContaining({
      message: "image-compression-busy", status: 503,
    }));

    leases[0].release?.();
    const replacement = await compressor.open(sources[100]);
    expect(await readdir(cacheRoot)).toHaveLength(100);
    replacement.release?.();
    leases.slice(1).forEach((lease) => lease.release?.());
    await compressor.close();
  });
});

async function temporaryDirectory() {
  const root = await mkdtemp(join(tmpdir(), "codex-image-compression-"));
  directories.push(root);
  return root;
}
