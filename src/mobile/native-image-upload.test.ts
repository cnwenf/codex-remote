import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexRemoteNative } from "./native-bridge";
import { uploadNativeImage } from "./native-image-upload";

vi.mock("./native-bridge", () => ({
  CodexRemoteNative: {
    addListener: vi.fn(),
    startImageUpload: vi.fn(),
    appendImageUpload: vi.fn(),
    finishImageUpload: vi.fn(),
    cancelImageUpload: vi.fn(),
  },
}));

const native = vi.mocked(CodexRemoteNative);
const file = () => new File(["image"], "screen.png", { type: "image/png" });
const upload = (onProgress?: (loaded: number, total: number) => void) =>
  uploadNativeImage("https://remote.example.test", "test-token", file(), onProgress);
type Progress = { uploadId: string; loaded: number; total: number };
let listeners: ((event: Progress) => void)[];
let remove: ReturnType<typeof vi.fn>;
const emit = (uploadId: string, loaded = 2, total = 5) =>
  listeners.forEach((listener) => listener({ uploadId, loaded, total }));

describe("native image upload lifecycle", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    listeners = [];
    remove = vi.fn().mockResolvedValue(undefined);
    native.addListener.mockImplementation(async (_event, listener) => {
      listeners.push(listener as unknown as (event: Progress) => void);
      return { remove };
    });
    native.startImageUpload.mockResolvedValue({ uploadId: "upload-1" });
    native.appendImageUpload.mockResolvedValue();
    native.finishImageUpload.mockResolvedValue({
      status: 201,
      data: { id: "image-1", name: "screen.png", mimeType: "image/png", size: 5 },
    });
    native.cancelImageUpload.mockResolvedValue();
  });
  afterEach(() => vi.useRealTimers());

  it("forwards only matching network bytes and never fabricates cache or completion progress", async () => {
    const progress = vi.fn();
    native.appendImageUpload.mockImplementation(async () => {
      expect(progress).not.toHaveBeenCalled();
    });
    native.finishImageUpload.mockImplementationOnce(async () => {
      emit("other-upload");
      emit("upload-1", -1);
      emit("upload-1", NaN);
      emit("upload-1", 2, 0);
      emit("upload-1", 6, 5);
      emit("upload-1", 2, Infinity);
      expect(progress).not.toHaveBeenCalled();
      emit("upload-1", 2, 5);
      return { status: 201, data: { id: "image-1", name: "screen.png", mimeType: "image/png", size: 5 } };
    });
    await expect(upload(progress)).resolves.toMatchObject({ id: "image-1" });
    expect(native.addListener).toHaveBeenCalledWith("imageUploadProgress", expect.any(Function));
    expect(progress.mock.calls).toEqual([[2, 5]]);
    expect(remove).toHaveBeenCalledTimes(1);
    emit("upload-1", 5, 5);
    expect(progress.mock.calls).toEqual([[2, 5]]);
  });

  it.each(["reject", "throw", "stall"])("still sends when listener registration can %s", async (failure) => {
    native.addListener.mockImplementationOnce(() => {
      if (failure === "throw") throw new Error("unsupported");
      if (failure === "reject") return Promise.reject(new Error("unsupported"));
      return new Promise(() => undefined);
    });
    await expect(upload(vi.fn())).resolves.toMatchObject({ id: "image-1" });
  });

  it("does not subscribe without a progress callback", async () => {
    await upload();
    expect(native.addListener).not.toHaveBeenCalled();
  });

  it.each(["success", "failure", "timeout"])("removes a listener after %s and ignores late events", async (outcome) => {
    vi.useFakeTimers();
    const progress = vi.fn();
    if (outcome === "failure") native.appendImageUpload.mockRejectedValueOnce(new Error("write-failed"));
    if (outcome === "timeout") native.appendImageUpload.mockImplementationOnce(() => new Promise(() => undefined));
    const result = upload(progress).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(60_000);
    if (outcome === "success") expect(await result).toMatchObject({ id: "image-1" });
    else expect(await result).toBeInstanceOf(Error);
    expect(remove).toHaveBeenCalledTimes(1);
    emit("upload-1");
    expect(progress).not.toHaveBeenCalled();
  });

  it.each(["success", "failure", "timeout"])("removes registration arriving after %s without blocking the upload", async (outcome) => {
    vi.useFakeTimers();
    let register!: (handle: { remove(): Promise<void> }) => void;
    native.addListener.mockImplementationOnce((_event, listener) => {
      listeners.push(listener as unknown as (event: Progress) => void);
      return new Promise((resolve) => { register = resolve; });
    });
    if (outcome === "failure") native.appendImageUpload.mockRejectedValueOnce(new Error("write-failed"));
    if (outcome === "timeout") native.appendImageUpload.mockImplementationOnce(() => new Promise(() => undefined));
    const progress = vi.fn();
    const result = upload(progress).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(60_000);
    if (outcome === "success") expect(await result).toMatchObject({ id: "image-1" });
    else expect(await result).toBeInstanceOf(Error);
    register({ remove });
    await vi.advanceTimersByTimeAsync(1);
    expect(remove).toHaveBeenCalledTimes(1);
    emit("upload-1");
    expect(progress).not.toHaveBeenCalled();
  });

  it("isolates concurrent uploads and ignores events from a finished image", async () => {
    const first = vi.fn();
    const second = vi.fn();
    native.startImageUpload.mockResolvedValueOnce({ uploadId: "one" }).mockResolvedValueOnce({ uploadId: "two" });
    const finishers = new Map<string, () => void>();
    native.finishImageUpload.mockImplementation(({ uploadId }) => new Promise((resolve) => {
      finishers.set(uploadId, () => resolve({ status: 201, data: { id: uploadId, name: "screen.png", mimeType: "image/png", size: 5 } }));
    }));
    const one = upload(first);
    const two = upload(second);
    await vi.waitFor(() => expect(finishers.size).toBe(2));
    emit("one", 1);
    emit("two", 3);
    expect(first.mock.calls).toEqual([[1, 5]]);
    expect(second.mock.calls).toEqual([[3, 5]]);
    finishers.get("one")!();
    await one;
    emit("one", 4);
    emit("two", 5);
    expect(first.mock.calls).toEqual([[1, 5]]);
    expect(second.mock.calls).toEqual([[3, 5], [5, 5]]);
    finishers.get("two")!();
    await two;
    expect(remove).toHaveBeenCalledTimes(2);
  });

  it("ignores progress callback and listener removal errors", async () => {
    remove.mockRejectedValueOnce(new Error("already removed"));
    native.appendImageUpload.mockImplementationOnce(async () => { emit("upload-1"); });
    await expect(upload(() => { throw new Error("view unmounted"); })).resolves.toMatchObject({ id: "image-1" });
    expect(remove).toHaveBeenCalledTimes(1);
  });

  it("cleans up a staging file created after the caller already timed out", async () => {
    vi.useFakeTimers();
    let finishStart!: (value: { uploadId: string }) => void;
    native.startImageUpload.mockImplementationOnce(() => new Promise((resolve) => { finishStart = resolve; }));
    const result = upload(vi.fn()).catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await result).toBeInstanceOf(Error);

    finishStart({ uploadId: "late-upload" });
    await vi.advanceTimersByTimeAsync(1);
    expect(native.cancelImageUpload).toHaveBeenCalledWith({ uploadId: "late-upload" });
    expect(native.addListener).not.toHaveBeenCalled();
    expect(native.appendImageUpload).not.toHaveBeenCalled();
    expect(native.finishImageUpload).not.toHaveBeenCalled();
  });

  it("reports file reading separately from network timeout and aborts the stalled reader", async () => {
    vi.useFakeTimers();
    vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(() => undefined);
    const abort = vi.spyOn(FileReader.prototype, "abort");
    const result = upload().catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(await result).toEqual(expect.objectContaining({ message: expect.stringContaining("读取图片") }));
    expect(abort).toHaveBeenCalled();
    expect(native.finishImageUpload).not.toHaveBeenCalled();
  });

  it("keeps a bridge timeout observable even when cancellation also never returns", async () => {
    vi.useFakeTimers();
    native.appendImageUpload.mockImplementationOnce(() => new Promise(() => undefined));
    native.cancelImageUpload.mockImplementationOnce(() => new Promise(() => undefined));
    const result = upload().catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(60_000);

    expect(await result).toEqual(expect.objectContaining({ message: expect.stringContaining("写入原生缓存") }));
  });

  it("rejects an aborted file read immediately without waiting for the upload deadline", async () => {
    vi.spyOn(FileReader.prototype, "readAsDataURL").mockImplementation(function (this: FileReader) {
      this.dispatchEvent(new ProgressEvent("abort"));
    });
    await expect(upload()).rejects.toThrow("图片读取已取消");
    expect(native.finishImageUpload).not.toHaveBeenCalled();
  });

  it.each(["appendImageUpload", "finishImageUpload"] as const)(
    "ignores a late %s callback while a fresh retry succeeds",
    async (method) => {
      vi.useFakeTimers();
      // Keep actual FileReader conversion, but settle it before moving the clock.
      let finishOld!: () => void;
      if (method === "appendImageUpload") {
        native.appendImageUpload.mockImplementationOnce(() => new Promise((resolve) => { finishOld = resolve; }));
      } else {
        native.finishImageUpload.mockImplementationOnce(() => new Promise((resolve) => {
          finishOld = () => resolve({
            status: 201, data: { id: "late-image", name: "screen.png", mimeType: "image/png", size: 5 },
          });
        }));
      }
      native.cancelImageUpload.mockImplementationOnce(() => new Promise(() => undefined));
      const oldResult = upload().catch((error: Error) => error);
      await vi.waitFor(() => expect(native[method]).toHaveBeenCalled());
      await vi.advanceTimersByTimeAsync(60_000);
      expect(await oldResult).toBeInstanceOf(Error);

      native.startImageUpload.mockResolvedValueOnce({ uploadId: "retry-upload" });
      const retry = upload();
      await vi.waitFor(() => expect(native.finishImageUpload).toHaveBeenCalledWith(expect.objectContaining({ uploadId: "retry-upload" })));
      expect(await retry).toEqual(expect.objectContaining({ id: "image-1" }));

      finishOld();
      await vi.advanceTimersByTimeAsync(1);
      expect(native.cancelImageUpload).toHaveBeenCalledTimes(1);
      expect(native.cancelImageUpload).toHaveBeenCalledWith({ uploadId: "upload-1" });
      if (method === "appendImageUpload") expect(native.finishImageUpload).toHaveBeenCalledTimes(1);
    },
  );
});
