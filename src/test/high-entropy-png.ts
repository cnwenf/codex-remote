import { deflateSync } from "node:zlib";

export function createHighEntropyPng(width = 2_200, height = 1_400, alpha = false) {
  const channels = alpha ? 4 : 3;
  const scanlines = Buffer.alloc((width * channels + 1) * height);
  let random = 0x6d2b79f5;
  for (let y = 0; y < height; y += 1) {
    const row = y * (width * channels + 1);
    scanlines[row] = 0;
    for (let x = 0; x < width * channels; x += 1) {
      random ^= random << 13;
      random ^= random >>> 17;
      random ^= random << 5;
      scanlines[row + x + 1] = alpha && x % channels === channels - 1 ? 0 : random & 0xff;
    }
  }
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8;
  header[9] = alpha ? 6 : 2;
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    pngChunk("IHDR", header),
    pngChunk("IDAT", deflateSync(scanlines, { level: 6 })),
    pngChunk("IEND", Buffer.alloc(0)),
  ]);
}

export function withExifOrientation(jpeg: Buffer, orientation: number) {
  const tiff = Buffer.alloc(26);
  tiff.write("II", 0, "ascii");
  tiff.writeUInt16LE(42, 2);
  tiff.writeUInt32LE(8, 4);
  tiff.writeUInt16LE(1, 8);
  tiff.writeUInt16LE(0x0112, 10);
  tiff.writeUInt16LE(3, 12);
  tiff.writeUInt32LE(1, 14);
  tiff.writeUInt16LE(orientation, 18);
  const payload = Buffer.concat([Buffer.from("Exif\0\0", "binary"), tiff]);
  const segment = Buffer.alloc(payload.length + 4);
  segment.writeUInt16BE(0xffe1, 0);
  segment.writeUInt16BE(payload.length + 2, 2);
  payload.copy(segment, 4);
  return Buffer.concat([jpeg.subarray(0, 2), segment, jpeg.subarray(2)]);
}

function pngChunk(name: string, data: Buffer) {
  const type = Buffer.from(name);
  const chunk = Buffer.alloc(12 + data.length);
  chunk.writeUInt32BE(data.length, 0);
  type.copy(chunk, 4);
  data.copy(chunk, 8);
  chunk.writeUInt32BE(crc32(Buffer.concat([type, data])), 8 + data.length);
  return chunk;
}

function crc32(value: Buffer) {
  let crc = 0xffffffff;
  for (const byte of value) {
    crc ^= byte;
    for (let bit = 0; bit < 8; bit += 1) crc = crc >>> 1 ^ (crc & 1 ? 0xedb88320 : 0);
  }
  return (crc ^ 0xffffffff) >>> 0;
}
