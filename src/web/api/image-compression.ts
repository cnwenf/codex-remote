import {
  MAX_SELECTABLE_IMAGE_BYTES,
  MAX_TRANSFER_IMAGE_BYTES,
  SUPPORTED_TRANSFER_IMAGE_TYPES,
} from "../../protocol/image-transfer";

const COMPRESSION_TIMEOUT_MS = 20_000;
const MAX_IMAGE_EDGE = 2_048;
const JPEG_QUALITIES = [0.9, 0.8, 0.7, 0.6];
const MAX_RESIZE_STEPS = 6;

export async function compressImageForUpload(file: File): Promise<File> {
  if (!SUPPORTED_TRANSFER_IMAGE_TYPES.includes(file.type as typeof SUPPORTED_TRANSFER_IMAGE_TYPES[number])) {
    throw new Error("仅支持 PNG、JPEG、GIF 和 WebP 图片");
  }
  if (file.size > MAX_SELECTABLE_IMAGE_BYTES) throw new Error("单张原图不能超过 50 MiB");
  if (file.size <= MAX_TRANSFER_IMAGE_BYTES) return file;

  let url: string | undefined;
  let canvas: HTMLCanvasElement | undefined;
  let image: HTMLImageElement | undefined;
  let timeout: ReturnType<typeof setTimeout> | undefined;
  let timedOut = false;
  try {
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
    const deadline = new Promise<never>((_resolve, reject) => {
      timeout = setTimeout(() => {
        timedOut = true;
        reject(new Error("图片压缩超过 20 秒，请重试"));
      }, COMPRESSION_TIMEOUT_MS);
    });
    return await Promise.race([work, deadline]);
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
