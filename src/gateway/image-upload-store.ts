import { randomUUID } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

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
    matches: (buffer: Buffer) => buffer.length >= 8 && buffer.subarray(0, 8).equals(
      Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    ),
  },
  {
    mimeType: "image/jpeg",
    extension: ".jpg",
    matches: (buffer: Buffer) => buffer.length >= 3 &&
      buffer[0] === 0xff && buffer[1] === 0xd8 && buffer[2] === 0xff,
  },
  {
    mimeType: "image/gif",
    extension: ".gif",
    matches: (buffer: Buffer) => buffer.length >= 6 &&
      ["GIF87a", "GIF89a"].includes(buffer.subarray(0, 6).toString("ascii")),
  },
  {
    mimeType: "image/webp",
    extension: ".webp",
    matches: (buffer: Buffer) => buffer.length >= 12 &&
      buffer.subarray(0, 4).toString("ascii") === "RIFF" &&
      buffer.subarray(8, 12).toString("ascii") === "WEBP",
  },
] as const;

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
