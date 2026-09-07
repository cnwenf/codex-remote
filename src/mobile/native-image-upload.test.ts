import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { CodexRemoteNative } from "./native-bridge";
import { uploadNativeImage } from "./native-image-upload";

vi.mock("./native-bridge", () => ({
  CodexRemoteNative: {
    startImageUpload: vi.fn(),
    appendImageUpload: vi.fn(),
    finishImageUpload: vi.fn(),
    cancelImageUpload: vi.fn(),
  },
}));

const native = vi.mocked(CodexRemoteNative);
const file = () => new File(["image"], "screen.png", { type: "image/png" });
const upload = () => uploadNativeImage("https://remote.example.test", "test-token", file());

describe("native image upload lifecycle", () => {
  beforeEach(() => {
    vi.resetAllMocks();
    native.startImageUpload.mockResolvedValue({ uploadId: "upload-1" });
    native.appendImageUpload.mockResolvedValue();
    native.finishImageUpload.mockResolvedValue({
      status: 201,
      data: { id: "image-1", name: "screen.png", mimeType: "image/png", size: 5 },
    });
    native.cancelImageUpload.mockResolvedValue();
  });
  afterEach(() => vi.useRealTimers());

  it("cleans up a staging file created after the caller already timed out", async () => {
    vi.useFakeTimers();
    let finishStart!: (value: { uploadId: string }) => void;
    native.startImageUpload.mockImplementationOnce(() => new Promise((resolve) => { finishStart = resolve; }));
    const result = upload().catch((error: Error) => error);
    await vi.advanceTimersByTimeAsync(60_000);
    expect(await result).toBeInstanceOf(Error);

    finishStart({ uploadId: "late-upload" });
    await vi.advanceTimersByTimeAsync(1);
    expect(native.cancelImageUpload).toHaveBeenCalledWith({ uploadId: "late-upload" });
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
