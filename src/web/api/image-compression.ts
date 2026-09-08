import {
  MAX_TRANSFER_IMAGE_BYTES,
} from "../../protocol/image-transfer";
import { inspectImageFile } from "./image-metadata";

const COMPRESSION_TIMEOUT_MS = 20_000;
const MAX_IMAGE_EDGE = 2_048;
const JPEG_QUALITIES = [0.9, 0.8, 0.7, 0.6];
const MAX_RESIZE_STEPS = 6;
let codecTail = Promise.resolve();

export async function compressImageForUpload(file: File): Promise<File> {
  const deadline = Date.now() + COMPRESSION_TIMEOUT_MS;
  await inspectImageFile(file);
  if (file.size <= MAX_TRANSFER_IMAGE_BYTES) return file;
  return withCodecSlot(() => compressImage(file, deadline));
}

async function compressImage(file: File, deadline: number) {
  let url: string | undefined;
  let canvas: HTMLCanvasElement | undefined;
  let image: HTMLImageElement | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
    if (deadline <= Date.now()) throw new Error("图片压缩超过 20 秒，请重试");
    url = URL.createObjectURL(file);
    image = new Image();
    image.src = url;
    const work = (async () => {
      await image.decode();
      if (timedOut) throw new Error("图片压缩超过 20 秒，请重试");
      if (!image.naturalWidth || !image.naturalHeight) throw new Error("图片解码失败");
      canvas = document.createElement("canvas");
      const context = canvas.getContext("2d");
      if (!context) throw new Error("当前浏览器无法压缩图片");
      let dimensions = boundedDimensions(image.naturalWidth, image.naturalHeight, MAX_IMAGE_EDGE);
      for (const quality of JPEG_QUALITIES) {
        const result = await encodeJpeg(canvas, context, image, dimensions.width, dimensions.height, quality);
        if (timedOut) throw new Error("图片压缩超过 20 秒，请重试");
        if (result.size <= MAX_TRANSFER_IMAGE_BYTES) return transferFile(file, result);
      }
      for (let step = 0; step < MAX_RESIZE_STEPS; step += 1) {
        dimensions = {
          width: Math.max(1, Math.round(dimensions.width * 0.75)),
          height: Math.max(1, Math.round(dimensions.height * 0.75)),
        };
        const result = await encodeJpeg(canvas, context, image, dimensions.width, dimensions.height, JPEG_QUALITIES.at(-1)!);
        if (timedOut) throw new Error("图片压缩超过 20 秒，请重试");
        if (result.size <= MAX_TRANSFER_IMAGE_BYTES) return transferFile(file, result);
      }
      throw new Error("图片压缩后仍超过 1 MB，请选择较小的图片");
    })();
    const timeoutPromise = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        reject(new Error("图片压缩超过 20 秒，请重试"));
      }, Math.max(1, deadline - Date.now()));
    });
    return await Promise.race([work, timeoutPromise]);
  } catch (cause) {
    if (cause instanceof Error && cause.message.startsWith("图片")) throw cause;
    throw new Error("图片压缩失败，请重新选择图片", { cause });
  } finally {
    if (timeout) clearTimeout(timeout);
    if (image) image.src = "";
    if (url) URL.revokeObjectURL(url);
    if (canvas) {
      canvas.width = 0;
      canvas.height = 0;
    }
  }
}

function withCodecSlot<T>(work: () => Promise<T>) {
  const result = codecTail.then(work);
  codecTail = result.then(() => undefined, () => undefined);
  return result;
}

function boundedDimensions(width: number, height: number, longestEdge: number) {
  const scale = Math.min(1, longestEdge / Math.max(width, height));
  return {
    width: Math.max(1, Math.round(width * scale)),
    height: Math.max(1, Math.round(height * scale)),
  };
}

function encodeJpeg(
  canvas: HTMLCanvasElement,
  context: CanvasRenderingContext2D,
  image: HTMLImageElement,
  width: number,
  height: number,
  quality: number,
) {
  canvas.width = width;
  canvas.height = height;
  context.fillStyle = "#ffffff";
  context.fillRect(0, 0, width, height);
  context.drawImage(image, 0, 0, width, height);
  return new Promise<Blob>((resolve, reject) => {
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error("图片压缩失败，请重新选择图片"));
    }, "image/jpeg", quality);
  });
}

function transferFile(original: File, jpeg: Blob) {
  const stem = original.name.replace(/\.[^.]*$/, "") || "image";
  return new File([jpeg], `${stem}.jpg`, { type: "image/jpeg", lastModified: original.lastModified });
}
