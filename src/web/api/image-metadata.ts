import {
  MAX_SELECTABLE_IMAGE_BYTES,
  SUPPORTED_TRANSFER_IMAGE_TYPES,
} from "../../protocol/image-transfer";

export const MAX_BROWSER_IMAGE_PIXELS = 32_000_000;
export const MAX_BROWSER_IMAGE_HEADER_BYTES = 256 * 1024;
const MAX_HEADER_SEGMENTS = 128;

export type ImageDimensions = { width: number; height: number; pixels: number };

export async function inspectImageFile(file: File): Promise<ImageDimensions> {
  if (!SUPPORTED_TRANSFER_IMAGE_TYPES.includes(file.type as typeof SUPPORTED_TRANSFER_IMAGE_TYPES[number])) {
    throw new Error("仅支持 PNG、JPEG、GIF 和 WebP 图片");
  }
  if (file.size > MAX_SELECTABLE_IMAGE_BYTES) throw new Error("单张原图不能超过 50 MiB");
  const bytes = await readBytes(file.slice(0, MAX_BROWSER_IMAGE_HEADER_BYTES));
  const dimensions = file.type === "image/png"
    ? pngDimensions(bytes)
    : file.type === "image/gif"
      ? gifDimensions(bytes)
      : file.type === "image/jpeg"
        ? jpegDimensions(bytes)
        : webpDimensions(bytes, file.size);
  if (!dimensions) throw new Error("无法读取图片尺寸，请重新选择图片");
  const pixels = dimensions.width * dimensions.height;
  if (!Number.isSafeInteger(pixels) || pixels <= 0) throw new Error("无法读取图片尺寸，请重新选择图片");
  if (pixels > MAX_BROWSER_IMAGE_PIXELS) throw new Error("图片像素不能超过 3200 万，请选择较小的图片");
  return { ...dimensions, pixels };
}

function pngDimensions(bytes: Uint8Array) {
  if (bytes.length < 24 || !matches(bytes, 0, [137, 80, 78, 71, 13, 10, 26, 10])) return;
  const view = dataView(bytes);
  if (view.getUint32(8) !== 13 || !matches(bytes, 12, [73, 72, 68, 82])) return;
  return validDimensions(view.getUint32(16), view.getUint32(20));
}

function gifDimensions(bytes: Uint8Array) {
  if (bytes.length < 10) return;
  const signature = String.fromCharCode(...bytes.subarray(0, 6));
  if (signature !== "GIF87a" && signature !== "GIF89a") return;
  const view = dataView(bytes);
  return validDimensions(view.getUint16(6, true), view.getUint16(8, true));
}

function jpegDimensions(bytes: Uint8Array) {
  if (bytes.length < 4 || bytes[0] !== 0xff || bytes[1] !== 0xd8) return;
  let offset = 2;
  for (let segments = 0; segments < MAX_HEADER_SEGMENTS && offset < bytes.length; segments += 1) {
    while (offset < bytes.length && bytes[offset] === 0xff) offset += 1;
    if (offset >= bytes.length) return;
    const marker = bytes[offset++];
    if (marker === 0xd9 || marker === 0xda) return;
    if (marker === 0x01 || (marker >= 0xd0 && marker <= 0xd7)) continue;
    if (offset + 2 > bytes.length) return;
    const length = dataView(bytes).getUint16(offset);
    if (length < 2 || offset + length > bytes.length) return;
    if (isStartOfFrame(marker)) {
      if (length < 8) return;
      return validDimensions(dataView(bytes).getUint16(offset + 5), dataView(bytes).getUint16(offset + 3));
    }
    offset += length;
  }
}

function webpDimensions(bytes: Uint8Array, fileSize: number) {
  if (bytes.length < 20 || !matchesAscii(bytes, 0, "RIFF") || !matchesAscii(bytes, 8, "WEBP")) return;
  const riffEnd = dataView(bytes).getUint32(4, true) + 8;
  if (riffEnd < 20 || riffEnd > fileSize) return;
  let offset = 12;
  for (let chunks = 0; chunks < MAX_HEADER_SEGMENTS && offset + 8 <= bytes.length && offset + 8 <= riffEnd; chunks += 1) {
    const type = String.fromCharCode(...bytes.subarray(offset, offset + 4));
    const size = dataView(bytes).getUint32(offset + 4, true);
    const payload = offset + 8;
    const chunkEnd = payload + size;
    if (!Number.isSafeInteger(chunkEnd) || chunkEnd > riffEnd) return;
    if (type === "VP8X") {
      if (size < 10 || payload + 10 > bytes.length) return;
      return validDimensions(readUint24(bytes, payload + 4) + 1, readUint24(bytes, payload + 7) + 1);
    }
    if (type === "VP8 ") {
      if (size < 10 || payload + 10 > bytes.length || !matches(bytes, payload + 3, [0x9d, 0x01, 0x2a])) return;
      const view = dataView(bytes);
      return validDimensions(view.getUint16(payload + 6, true) & 0x3fff, view.getUint16(payload + 8, true) & 0x3fff);
    }
    if (type === "VP8L") {
      if (size < 5 || payload + 5 > bytes.length || bytes[payload] !== 0x2f) return;
      const b1 = bytes[payload + 1];
      const b2 = bytes[payload + 2];
      const b3 = bytes[payload + 3];
      const b4 = bytes[payload + 4];
      return validDimensions(1 + b1 + ((b2 & 0x3f) << 8), 1 + (b2 >>> 6) + (b3 << 2) + ((b4 & 0x0f) << 10));
    }
    const next = chunkEnd + (size % 2);
    if (next > bytes.length || next > riffEnd) return;
    offset = next;
  }
}

function isStartOfFrame(marker: number) {
  return marker >= 0xc0 && marker <= 0xcf && ![0xc4, 0xc8, 0xcc].includes(marker);
}

function validDimensions(width: number, height: number) {
  return width > 0 && height > 0 ? { width, height } : undefined;
}

function dataView(bytes: Uint8Array) {
  return new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
}

function matches(bytes: Uint8Array, offset: number, expected: number[]) {
  return expected.every((value, index) => bytes[offset + index] === value);
}

function matchesAscii(bytes: Uint8Array, offset: number, expected: string) {
  return matches(bytes, offset, [...expected].map((value) => value.charCodeAt(0)));
}

function readUint24(bytes: Uint8Array, offset: number) {
  return bytes[offset] + (bytes[offset + 1] << 8) + (bytes[offset + 2] << 16);
}

function readBytes(blob: Blob) {
  return new Promise<Uint8Array>((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error("无法读取图片尺寸，请重新选择图片"));
    reader.onload = () => {
      if (reader.result instanceof ArrayBuffer) resolve(new Uint8Array(reader.result));
      else reject(new Error("无法读取图片尺寸，请重新选择图片"));
    };
    reader.readAsArrayBuffer(blob);
  });
}
