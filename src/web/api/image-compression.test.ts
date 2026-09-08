import { afterEach, describe, expect, it, vi } from "vitest";
import { MAX_TRANSFER_IMAGE_BYTES } from "../../protocol/image-transfer";
import { compressImageForUpload } from "./image-compression";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("browser image compression", () => {
  it("preserves an already bounded supported image byte-for-byte", async () => {
    const file = pngFile("small.png", 400, 300);

    const result = await compressImageForUpload(file);

    expect(result).toBe(file);
  });

  it("creates a bounded JPEG with preserved proportions and an explicit white background", async () => {
    const operations: string[] = [];
    installImageAndCanvas({ width: 4_000, height: 2_000, operations });
    const file = pngFile("transparent.png", 4_000, 2_000, MAX_TRANSFER_IMAGE_BYTES + 1);

    const result = await compressImageForUpload(file);

    expect(result.type).toBe("image/jpeg");
    expect(result.name).toBe("transparent.jpg");
    expect(result.size).toBeLessThanOrEqual(MAX_TRANSFER_IMAGE_BYTES);
    expect(operations.slice(0, 3)).toEqual([
      "fillStyle:#ffffff",
      "fillRect:0,0,2048,1024",
      "drawImage:0,0,2048,1024",
    ]);
    expect(URL.revokeObjectURL).toHaveBeenCalledWith("blob:test-image");
  });

  it("times out image decoding and releases its Blob URL", async () => {
    vi.useFakeTimers();
    vi.stubGlobal("FileReader", class {
      result: string | ArrayBuffer | null = pngHeader(4_000, 2_000).buffer;
      onerror: (() => void) | null = null;
      onload: (() => void) | null = null;
      readAsArrayBuffer() { this.onload?.(); }
    });
    const revoke = vi.fn();
    let markStarted!: () => void;
    const started = new Promise<void>((resolve) => { markStarted = resolve; });
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => { markStarted(); return "blob:stalled"; }), revokeObjectURL: revoke });
    vi.stubGlobal("Image", class { decode = () => new Promise(() => undefined); });
    const file = pngFile("stalled.png", 4_000, 2_000, MAX_TRANSFER_IMAGE_BYTES + 1);
    const result = compressImageForUpload(file).catch((error: Error) => error);

    await started;
    await vi.advanceTimersByTimeAsync(20_000);

    await expect(result).resolves.toEqual(expect.objectContaining({ message: expect.stringContaining("20 秒") }));
    expect(revoke).toHaveBeenCalledWith("blob:stalled");
  });

  it("rejects excessive pixels before creating a Blob URL or decoder", async () => {
    const createObjectURL = vi.fn();
    vi.stubGlobal("URL", { createObjectURL, revokeObjectURL: vi.fn() });
    const image = vi.fn();
    vi.stubGlobal("Image", image);

    await expect(compressImageForUpload(pngFile("huge.png", 8_000, 4_001))).rejects.toThrow("3200 万");
    expect(createObjectURL).not.toHaveBeenCalled();
    expect(image).not.toHaveBeenCalled();
  });

  it("runs browser decode and encode one image at a time", async () => {
    const operations: string[] = [];
    let active = 0;
    let maxActive = 0;
    let releaseFirst!: () => void;
    const firstGate = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let decodeCount = 0;
    installImageAndCanvas({ width: 4_000, height: 2_000, operations, decode: async () => {
      decodeCount += 1;
      active += 1;
      maxActive = Math.max(maxActive, active);
      if (decodeCount === 1) await firstGate;
      active -= 1;
    } });

    const first = compressImageForUpload(pngFile("first.png", 4_000, 2_000, MAX_TRANSFER_IMAGE_BYTES + 1));
    const second = compressImageForUpload(pngFile("second.png", 4_000, 2_000, MAX_TRANSFER_IMAGE_BYTES + 1));
    await vi.waitFor(() => expect(decodeCount).toBe(1));
    expect(maxActive).toBe(1);
    releaseFirst();
    await Promise.all([first, second]);

    expect(decodeCount).toBe(2);
    expect(maxActive).toBe(1);
  });
});

function installImageAndCanvas({
  width,
  height,
  operations,
  decode = async () => undefined,
}: {
  width: number;
  height: number;
  operations: string[];
  decode?: () => Promise<void>;
}) {
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => "blob:test-image"),
    revokeObjectURL: vi.fn(),
  });
  vi.stubGlobal("Image", class {
    naturalWidth = width;
    naturalHeight = height;
    decode = vi.fn(decode);
  });
  vi.spyOn(HTMLCanvasElement.prototype, "getContext").mockReturnValue({
    set fillStyle(value: string | CanvasGradient | CanvasPattern) { operations.push(`fillStyle:${String(value)}`); },
    fillRect: (x: number, y: number, w: number, h: number) => operations.push(`fillRect:${x},${y},${w},${h}`),
    drawImage: (_image: CanvasImageSource, x: number, y: number, w: number, h: number) => operations.push(`drawImage:${x},${y},${w},${h}`),
  } as unknown as CanvasRenderingContext2D);
  let attempt = 0;
  vi.spyOn(HTMLCanvasElement.prototype, "toBlob").mockImplementation((callback) => {
    attempt += 1;
    const size = attempt === 1 ? MAX_TRANSFER_IMAGE_BYTES + 1 : 900_000;
    callback(new Blob([new Uint8Array(size)], { type: "image/jpeg" }));
  });
}

function pngFile(name: string, width: number, height: number, size = 24) {
  const header = pngHeader(width, height);
  return new File([header, new Uint8Array(Math.max(0, size - header.length))], name, { type: "image/png" });
}

function pngHeader(width: number, height: number) {
  const header = new Uint8Array(24);
  header.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  const view = new DataView(header.buffer);
  view.setUint32(16, width);
  view.setUint32(20, height);
  return header;
}
