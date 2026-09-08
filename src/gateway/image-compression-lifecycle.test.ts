// @vitest-environment node

import { mkdtemp, rm, stat as realStat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_TRANSFER_IMAGE_BYTES } from "../protocol/image-transfer";

const directories: string[] = [];

afterEach(async () => {
  vi.doUnmock("node:fs/promises");
  vi.resetModules();
  await Promise.all(directories.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("Gateway image compressor lifecycle", () => {
  it("does not resume an open after close while source stat is pending", async () => {
    const root = await mkdtemp(join(tmpdir(), "codex-image-lifecycle-"));
    directories.push(root);
    const sourcePath = join(root, "source.png");
    await writeFile(sourcePath, "source");
    let releaseStat!: () => void;
    const statGate = new Promise<void>((resolve) => { releaseStat = resolve; });
    let enteredStat!: () => void;
    const statEntered = new Promise<void>((resolve) => { enteredStat = resolve; });

    vi.doMock("node:fs/promises", async () => {
      const original = await vi.importActual<typeof import("node:fs/promises")>("node:fs/promises");
      return {
        ...original,
        stat: async (path: Parameters<typeof realStat>[0]) => {
          if (path === sourcePath) {
            enteredStat();
            await statGate;
          }
          return realStat(path);
        },
      };
    });
    const { GatewayImageCompressor } = await import("./image-compression");
    const runSips = vi.fn(async () => "pixelWidth: 2200\npixelHeight: 1400\n");
    const compressor = new GatewayImageCompressor(join(root, "cache"), runSips, "darwin");

    const pending = compressor.open({
      path: sourcePath,
      name: "source.png",
      mimeType: "image/png",
      size: MAX_TRANSFER_IMAGE_BYTES + 1,
    });
    await statEntered;
    await compressor.close();
    releaseStat();

    await expect(pending).rejects.toEqual(expect.objectContaining({ message: "image-compressor-closed", status: 503 }));
    expect(runSips).not.toHaveBeenCalled();
  });
});
