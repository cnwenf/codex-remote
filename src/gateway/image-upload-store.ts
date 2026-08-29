import { randomUUID } from "node:crypto";
import { createHash } from "node:crypto";
import { chmodSync, copyFileSync, existsSync, lstatSync, mkdirSync, readFileSync, realpathSync } from "node:fs";
import { chmod, lstat, mkdir, writeFile } from "node:fs/promises";
import { basename, join, resolve } from "node:path";

export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

type StoredImage = {
  id: string;
  name: string;
  mimeType: string;
  size: number;
  path: string;
};

const formats = [
  {
    mimeType: "image/png",
    extension: ".png",
    matches: matchesPng,
  },
  {
    mimeType: "image/jpeg",
    extension: ".jpg",
    matches: (buffer: Buffer) => buffer.length >= 4 &&
      buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff &&
      buffer[buffer.length - 2] === 0xff && buffer[buffer.length - 1] === 0xd9,
  },
  {
    mimeType: "image/gif",
    extension: ".gif",
    matches: (buffer: Buffer) => buffer.length >= 14 &&
      ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii")) &&
      buffer[buffer.length - 1] === 0x3b,
  },
  {
    mimeType: "image/webp",
    extension: ".webp",
    matches: (buffer: Buffer) => buffer.length >= 20 &&
      buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
      buffer.readUInt32LE(4) === buffer.length - 8 &&
      buffer.subarray(8, 12).toString("ascii") === "WEBP" &&
      ["VP8 ", "VP8L", "VP8X"].includes(buffer.subarray(12, 16).toString("ascii")) &&
      buffer.readUInt32LE(16) <= buffer.length - 20,
  },
] as const;

const imageIdPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;

function matchesPng(buffer: Buffer) {
  return buffer.length >= 45 &&
    buffer.subarray(0, 8).equals(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) &&
    buffer.readUInt32BE(8) === 13 &&
    buffer.subarray(12, 16).toString("ascii") === "IHDR" &&
    buffer.readUInt32BE(buffer.length - 12) === 0 &&
    buffer.subarray(buffer.length - 8, buffer.length - 4).toString("ascii") === "IEND";
}

export class ImageUploadStore {
  private readonly images = new Map<string, StoredImage>();

  constructor(private readonly root: string) {}

  async save(buffer: Buffer, declaredMimeType: string, originalName?: string): Promise<StoredImage> {
    if (buffer.byteLength === 0) throw new ImageUploadError("image-empty", 400);
    if (buffer.byteLength > MAX_IMAGE_BYTES) throw new ImageUploadError("image-too-large", 413);
    const format = formats.find((candidate) => candidate.matches(buffer));
    if (!format || format.mimeType !== declaredMimeType.toLowerCase()) {
      throw new ImageUploadError("image-type-invalid", 415);
    }
    await mkdir(this.root, { recursive: true, mode: 0o700 });
    await chmod(this.root, 0o700);
    const id = randomUUID();
    const path = join(this.root, `${id}${format.extension}`);
    await writeFile(path, buffer, { flag: "wx", mode: 0o600 });
    const fallbackName = `image${format.extension}`;
    const safeName = sanitizeDisplayName(originalName) || fallbackName;
    const image = {
      id,
      name: safeName,
      mimeType: format.mimeType,
      size: buffer.byteLength,
      path,
    };
    this.images.set(id, image);
    return image;
  }

  resolve(id: string): string {
    const image = this.images.get(id);
    if (!image) throw new ImageUploadError("image-upload-not-found", 400);
    return image.path;
  }

  referenceForPath(path: string): string | undefined {
    const name = basename(path);
    const extension = formats.find((format) => name.endsWith(format.extension))?.extension;
    if (!extension) return undefined;
    const id = name.slice(0, -extension.length);
    if (imageIdPattern.test(id) && resolve(this.root, name) === resolve(path)) return id;

    try {
      const source = realpathSync(path);
      const info = lstatSync(source);
      if (!info.isFile() || info.size <= 0 || info.size > MAX_IMAGE_BYTES) return undefined;
      const buffer = readFileSync(source);
      const format = formats.find((candidate) => candidate.matches(buffer));
      if (!format) return undefined;
      const fingerprint = createHash("sha256")
        .update(source)
        .update(String(info.mtimeMs))
        .update(String(info.size))
        .digest("hex");
      const importedId = `${fingerprint.slice(0, 8)}-${fingerprint.slice(8, 12)}-8${fingerprint.slice(13, 16)}-a${fingerprint.slice(17, 20)}-${fingerprint.slice(20, 32)}`;
      const target = join(this.root, `${importedId}${format.extension}`);
      mkdirSync(this.root, { recursive: true, mode: 0o700 });
      chmodSync(this.root, 0o700);
      if (!existsSync(target)) {
        copyFileSync(source, target);
        chmodSync(target, 0o600);
      }
      return importedId;
    } catch {
      return undefined;
    }
  }

  async open(id: string): Promise<StoredImage> {
    if (!imageIdPattern.test(id)) throw new ImageUploadError("image-upload-not-found", 404);
    for (const format of formats) {
      const path = join(this.root, `${id}${format.extension}`);
      try {
        const info = await lstat(path);
        if (!info.isFile() || info.size <= 0 || info.size > MAX_IMAGE_BYTES) continue;
        return {
          id,
          name: `image${format.extension}`,
          mimeType: format.mimeType,
          size: info.size,
          path,
        };
      } catch {
        // Try the next supported extension.
      }
    }
    throw new ImageUploadError("image-upload-not-found", 404);
  }
}

export class ImageUploadError extends Error {
  constructor(message: string, readonly status: number) {
    super(message);
  }
}

function sanitizeDisplayName(value?: string) {
  if (!value) return "";
  let decoded = value;
  try {
    decoded = decodeURIComponent(value);
  } catch {
    // Keep the original display name when the header is not percent encoded.
  }
  return basename(decoded)
    .replace(/[\u0000-\u001f\u007f]/g, "")
    .slice(0, 160)
    .trim();
}
