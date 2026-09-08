import { afterEach, describe, expect, it, vi } from "vitest";
import {
  MAX_BROWSER_IMAGE_HEADER_BYTES,
  MAX_BROWSER_IMAGE_PIXELS,
  inspectImageFile,
} from "./image-metadata";

afterEach(() => {
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
  vi.useRealTimers();
});

describe("browser image metadata preflight", () => {
  it.each([
    ["image/png", pngHeader(4_000, 3_000)],
    ["image/gif", gifHeader(4_000, 3_000)],
    ["image/jpeg", jpegHeader(4_000, 3_000)],
    ["image/webp", webpVp8xHeader(4_000, 3_000)],
    ["image/webp", webpVp8Header(4_000, 3_000)],
    ["image/webp", webpVp8lHeader(4_000, 3_000)],
  ])("reads %s dimensions from a bounded header", async (type, bytes) => {
    const file = new File([bytes, new Uint8Array(MAX_BROWSER_IMAGE_HEADER_BYTES + 1)], "camera", { type });
    const slice = vi.spyOn(file, "slice");

    await expect(inspectImageFile(file)).resolves.toEqual({ width: 4_000, height: 3_000, pixels: 12_000_000 });
    expect(slice).toHaveBeenCalledWith(0, MAX_BROWSER_IMAGE_HEADER_BYTES);
  });

  it("rejects excessive pixels before any browser decoder is used", async () => {
    const file = new File([pngHeader(8_000, 4_001)], "huge.png", { type: "image/png" });

    await expect(inspectImageFile(file)).rejects.toThrow("3200 万");
    expect(8_000 * 4_001).toBeGreaterThan(MAX_BROWSER_IMAGE_PIXELS);
  });

  it("rejects a JPEG whose SOF is outside the bounded marker scan", async () => {
    const bytes = new Uint8Array(MAX_BROWSER_IMAGE_HEADER_BYTES + 100);
    bytes.set([0xff, 0xd8, 0xff, 0xe1, 0xff, 0xff]);
    const file = new File([bytes], "metadata-heavy.jpg", { type: "image/jpeg" });

    await expect(inspectImageFile(file)).rejects.toThrow("无法读取图片尺寸");
  });

  it("rejects a MIME and magic mismatch", async () => {
    const file = new File([gifHeader(10, 10)], "wrong.png", { type: "image/png" });

    await expect(inspectImageFile(file)).rejects.toThrow("无法读取图片尺寸");
  });

  it.each(["VP8 ", "VP8L"])("reads dimensions before a large %s payload exceeds the header budget", async (type) => {
    const { header, fileSize } = largeWebpHeader(type, 4_000, 3_000, MAX_BROWSER_IMAGE_HEADER_BYTES + 100);
    const file = new File([header, new Uint8Array(fileSize - header.length)], "large.webp", { type: "image/webp" });

    await expect(inspectImageFile(file)).resolves.toEqual({ width: 4_000, height: 3_000, pixels: 12_000_000 });
  });

  it("times out a stalled header read, cleans handlers, then aborts without synchronous re-entry", async () => {
    vi.useFakeTimers();
    const reader = installFileReader("stall");
    let state = "pending";
    const result = inspectImageFile(pngFile("stalled.png")).then(
      () => { state = "resolved"; },
      (error: unknown) => { state = error instanceof Error ? error.message : "rejected"; throw error; },
    );
    void result.catch(() => undefined);

    await vi.advanceTimersByTimeAsync(4_999);
    expect(state).toBe("pending");
    await vi.advanceTimersByTimeAsync(1);

    expect(state).toContain("无法读取图片尺寸");
    await expect(result).rejects.toThrow("无法读取图片尺寸");
    expect(reader.current().abort).toHaveBeenCalledOnce();
    expect(reader.abortSawHandler()).toBe(false);
    expect(reader.current()).toMatchObject({ onload: null, onerror: null, onabort: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("rejects an active FileReader abort and clears its timer and handlers", async () => {
    vi.useFakeTimers();
    const reader = installFileReader("abort");
    let state = "pending";
    const result = inspectImageFile(pngFile("aborted.png")).then(
      () => { state = "resolved"; },
      (error: unknown) => { state = error instanceof Error ? error.message : "rejected"; throw error; },
    );
    void result.catch(() => undefined);
    await Promise.resolve();
    await Promise.resolve();

    expect(state).toContain("无法读取图片尺寸");
    await expect(result).rejects.toThrow("无法读取图片尺寸");
    expect(reader.current()).toMatchObject({ onload: null, onerror: null, onabort: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it("cleans its timer and handlers when FileReader throws synchronously", async () => {
    vi.useFakeTimers();
    const reader = installFileReader("throw");

    await expect(inspectImageFile(pngFile("throw.png"))).rejects.toThrow("无法读取图片尺寸");

    expect(reader.current()).toMatchObject({ onload: null, onerror: null, onabort: null });
    expect(vi.getTimerCount()).toBe(0);
  });

  it.each(["load", "error"] as const)("cleans its timer and handlers after FileReader %s", async (action) => {
    vi.useFakeTimers();
    const reader = installFileReader(action);
    const result = inspectImageFile(pngFile(`${action}.png`));

    if (action === "load") await expect(result).resolves.toEqual({ width: 400, height: 300, pixels: 120_000 });
    else await expect(result).rejects.toThrow("无法读取图片尺寸");

    expect(reader.current()).toMatchObject({ onload: null, onerror: null, onabort: null });
    expect(vi.getTimerCount()).toBe(0);
  });
});

type TestReader = {
  result: string | ArrayBuffer | null;
  onload: (() => void) | null;
  onerror: (() => void) | null;
  onabort: (() => void) | null;
  abort: ReturnType<typeof vi.fn>;
};

function installFileReader(action: "stall" | "abort" | "throw" | "load" | "error") {
  let instance: TestReader | undefined;
  let abortSawHandler = false;
  vi.stubGlobal("FileReader", class implements TestReader {
    result: string | ArrayBuffer | null = pngHeader(400, 300).buffer;
    onload: (() => void) | null = null;
    onerror: (() => void) | null = null;
    onabort: (() => void) | null = null;
    abort = vi.fn(() => {
      abortSawHandler = this.onabort !== null;
      this.onabort?.();
    });

    constructor() { instance = this; }

    readAsArrayBuffer() {
      if (action === "abort") this.onabort?.();
      if (action === "throw") throw new Error("reader-threw");
      if (action === "load") this.onload?.();
      if (action === "error") this.onerror?.();
    }
  });
  return {
    current: () => {
      if (!instance) throw new Error("FileReader was not created");
      return instance;
    },
    abortSawHandler: () => abortSawHandler,
  };
}

function pngFile(name: string) {
  return new File([pngHeader(400, 300)], name, { type: "image/png" });
}

function pngHeader(width: number, height: number) {
  const bytes = new Uint8Array(24);
  bytes.set([137, 80, 78, 71, 13, 10, 26, 10, 0, 0, 0, 13, 73, 72, 68, 82]);
  new DataView(bytes.buffer).setUint32(16, width);
  new DataView(bytes.buffer).setUint32(20, height);
  return bytes;
}

function gifHeader(width: number, height: number) {
  const bytes = new Uint8Array(10);
  bytes.set(new TextEncoder().encode("GIF89a"));
  new DataView(bytes.buffer).setUint16(6, width, true);
  new DataView(bytes.buffer).setUint16(8, height, true);
  return bytes;
}

function jpegHeader(width: number, height: number) {
  const bytes = new Uint8Array(13);
  bytes.set([0xff, 0xd8, 0xff, 0xc0, 0, 9, 8]);
  new DataView(bytes.buffer).setUint16(7, height);
  new DataView(bytes.buffer).setUint16(9, width);
  bytes.set([1, 1], 11);
  return bytes;
}

function webpVp8xHeader(width: number, height: number) {
  const bytes = new Uint8Array(30);
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true);
  bytes.set(new TextEncoder().encode("WEBPVP8X"), 8);
  new DataView(bytes.buffer).setUint32(16, 10, true);
  writeUint24(bytes, 24, width - 1);
  writeUint24(bytes, 27, height - 1);
  return bytes;
}

function webpVp8Header(width: number, height: number) {
  const bytes = webpChunk("VP8 ", 10);
  bytes.set([0x9d, 0x01, 0x2a], 23);
  const view = new DataView(bytes.buffer);
  view.setUint16(26, width, true);
  view.setUint16(28, height, true);
  return bytes;
}

function webpVp8lHeader(width: number, height: number) {
  const bytes = webpChunk("VP8L", 5);
  const widthBits = width - 1;
  const heightBits = height - 1;
  bytes[20] = 0x2f;
  bytes[21] = widthBits & 0xff;
  bytes[22] = ((widthBits >>> 8) & 0x3f) | ((heightBits & 0x03) << 6);
  bytes[23] = (heightBits >>> 2) & 0xff;
  bytes[24] = (heightBits >>> 10) & 0x0f;
  return bytes;
}

function webpChunk(type: string, size: number) {
  const bytes = new Uint8Array(20 + size + (size % 2));
  bytes.set(new TextEncoder().encode("RIFF"), 0);
  new DataView(bytes.buffer).setUint32(4, bytes.length - 8, true);
  bytes.set(new TextEncoder().encode("WEBP"), 8);
  bytes.set(new TextEncoder().encode(type), 12);
  new DataView(bytes.buffer).setUint32(16, size, true);
  return bytes;
}

function largeWebpHeader(type: string, width: number, height: number, payloadSize: number) {
  const header = new Uint8Array(30);
  const paddedPayloadSize = payloadSize + (payloadSize % 2);
  const fileSize = 20 + paddedPayloadSize;
  header.set(new TextEncoder().encode("RIFF"), 0);
  new DataView(header.buffer).setUint32(4, fileSize - 8, true);
  header.set(new TextEncoder().encode("WEBP"), 8);
  header.set(new TextEncoder().encode(type), 12);
  new DataView(header.buffer).setUint32(16, payloadSize, true);
  if (type === "VP8 ") {
    header.set([0x9d, 0x01, 0x2a], 23);
    new DataView(header.buffer).setUint16(26, width, true);
    new DataView(header.buffer).setUint16(28, height, true);
  } else {
    const widthBits = width - 1;
    const heightBits = height - 1;
    header[20] = 0x2f;
    header[21] = widthBits & 0xff;
    header[22] = ((widthBits >>> 8) & 0x3f) | ((heightBits & 0x03) << 6);
    header[23] = (heightBits >>> 2) & 0xff;
    header[24] = (heightBits >>> 10) & 0x0f;
  }
  return { header, fileSize };
}

function writeUint24(bytes: Uint8Array, offset: number, value: number) {
  bytes[offset] = value & 0xff;
  bytes[offset + 1] = (value >>> 8) & 0xff;
  bytes[offset + 2] = (value >>> 16) & 0xff;
}
