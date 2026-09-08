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
    const file = new File([new Uint8Array([1, 2, 3])], "small.png", { type: "image/png" });

    const result = await compressImageForUpload(file);

    expect(result).toBe(file);
  });

  it("creates a bounded JPEG with preserved proportions and an explicit white background", async () => {
    const operations: string[] = [];
    installImageAndCanvas({ width: 4_000, height: 2_000, operations });
    const file = new File([new Uint8Array(MAX_TRANSFER_IMAGE_BYTES + 1)], "transparent.png", { type: "image/png" });

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
    const revoke = vi.fn();
    vi.stubGlobal("URL", { createObjectURL: vi.fn(() => "blob:stalled"), revokeObjectURL: revoke });
    vi.stubGlobal("Image", class { decode = () => new Promise(() => undefined); });
    const file = new File([new Uint8Array(MAX_TRANSFER_IMAGE_BYTES + 1)], "stalled.png", { type: "image/png" });
    const result = compressImageForUpload(file).catch((error: Error) => error);

    await vi.advanceTimersByTimeAsync(20_000);

    await expect(result).resolves.toEqual(expect.objectContaining({ message: expect.stringContaining("20 秒") }));
    expect(revoke).toHaveBeenCalledWith("blob:stalled");
  });
});

function installImageAndCanvas({ width, height, operations }: { width: number; height: number; operations: string[] }) {
  vi.stubGlobal("URL", {
    createObjectURL: vi.fn(() => "blob:test-image"),
    revokeObjectURL: vi.fn(),
  });
  vi.stubGlobal("Image", class {
    naturalWidth = width;
    naturalHeight = height;
    decode = vi.fn().mockResolvedValue(undefined);
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
