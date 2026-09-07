import { uploadedImageFromResponse } from "../web/api/socket";
import { normalizeRemoteUrl } from "./connection-store";
import { CodexRemoteNative } from "./native-bridge";

const IMAGE_UPLOAD_CHUNK_BYTES = 256 * 1024;
const IMAGE_UPLOAD_TIMEOUT_MS = 60_000;

export async function uploadNativeImage(baseUrl: string, token: string, file: File) {
  let uploadId: string | undefined;
  let phase = "准备原生上传";
  let cancellationRequested = false;
  const controller = new AbortController();
  const { signal } = controller;
  const cancel = () => {
    if (!uploadId || cancellationRequested) return;
    cancellationRequested = true;
    // The bridge may be stalled too; never await it to release the composer.
    void CodexRemoteNative.cancelImageUpload({ uploadId }).catch(() => undefined);
  };
  let timeout: ReturnType<typeof setTimeout> | undefined;
  const timeoutPromise = new Promise<never>((_resolve, reject) => {
    timeout = setTimeout(() => {
      const error = new Error(`图片上传超时（${phase}），请重试`);
      reject(error);
      controller.abort(error);
      cancel();
    }, IMAGE_UPLOAD_TIMEOUT_MS);
  });
  const upload = (async () => {
    try {
      const started = await CodexRemoteNative.startImageUpload();
      uploadId = started.uploadId;
      if (signal.aborted) throw signal.reason;
      for (let offset = 0; offset < file.size; offset += IMAGE_UPLOAD_CHUNK_BYTES) {
        phase = "读取图片";
        const data = await blobAsBase64(file.slice(offset, offset + IMAGE_UPLOAD_CHUNK_BYTES), signal);
        if (signal.aborted) throw signal.reason;
        phase = "写入原生缓存";
        await CodexRemoteNative.appendImageUpload({ uploadId, data });
        if (signal.aborted) throw signal.reason;
      }
      phase = "传输到服务端";
      const response = await CodexRemoteNative.finishImageUpload({
        uploadId,
        url: `${normalizeRemoteUrl(baseUrl)}/api/images`,
        token,
        fileName: encodeURIComponent(file.name),
        mimeType: file.type,
      });
      if (signal.aborted) throw signal.reason;
      return uploadedImageFromResponse(response.status, response.data);
    } finally {
      // startImageUpload can resolve after the caller has already timed out.
      if (signal.aborted) cancel();
    }
  })();
  try {
    return await Promise.race([upload, timeoutPromise]);
  } catch (cause) {
    controller.abort(cause);
    cancel();
    throw cause;
  } finally {
    if (timeout) clearTimeout(timeout);
  }
}

function blobAsBase64(blob: Blob, signal: AbortSignal) {
  return new Promise<string>((resolve, reject) => {
    if (signal.aborted) { reject(signal.reason); return; }
    const reader = new FileReader();
    const abort = () => {
      reader.abort();
      fail(signal.reason);
    };
    const cleanup = () => signal.removeEventListener("abort", abort);
    const fail = (cause: unknown) => { cleanup(); reject(cause); };
    reader.addEventListener("load", () => {
      cleanup();
      if (typeof reader.result !== "string") {
        reject(new Error("图片读取失败"));
        return;
      }
      const separator = reader.result.indexOf(",");
      if (separator < 0) {
        reject(new Error("图片读取失败"));
        return;
      }
      resolve(reader.result.slice(separator + 1));
    });
    reader.addEventListener("error", () => fail(new Error("图片读取失败")));
    reader.addEventListener("abort", () => fail(signal.reason ?? new Error("图片读取已取消，请重新选择图片")));
    signal.addEventListener("abort", abort, { once: true });
    try {
      reader.readAsDataURL(blob);
    } catch (cause) {
      fail(cause);
    }
  });
}
