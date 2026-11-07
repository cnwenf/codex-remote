import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialCodexState } from "../../protocol/thread-store";
import { hydrateThread } from "../state/conversation-history";
import { Timeline } from "./timeline";

const id = "00000000-0000-4000-8000-000000000001";
const request = { baseUrl: "https://gateway.test", token: "test-secret" };
const thread = hydrateThread(initialCodexState, { thread: { id: "t", turns: [{ id: "turn", status: "completed", items: [
  { id: "user", type: "userMessage", text: "Picture", imageIds: [id] },
] }] } }).threads.t;

afterEach(() => { vi.unstubAllGlobals(); vi.useRealTimers(); });

describe("image failure evidence", () => {
  it.each(["request", "body"])("bounds a stalled HTTP %s and allows retry", async (stage) => {
    vi.useFakeTimers();
    const fetcher = vi.fn().mockImplementationOnce(() => stage === "request"
      ? new Promise(() => {})
      : Promise.resolve({ ok: true, blob: () => new Promise(() => {}) }))
      .mockResolvedValue(new Response("image"));
    vi.stubGlobal("fetch", fetcher);
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL() { return "blob:recovered"; }
      static revokeObjectURL() {}
    });
    render(<Timeline thread={thread} imageRequest={request} />);
    await act(async () => { await vi.advanceTimersByTimeAsync(30_000); });
    expect(screen.getByText(/图片下载超时/)).toBeInTheDocument();
    expect(fetcher.mock.calls[0][1].signal.aborted).toBe(true);
    await act(async () => { fireEvent.click(screen.getByRole("button", { name: "重试图片" })); });
    expect(screen.getByRole("img", { name: "用户上传的图片 1" })).toHaveAttribute("src", "blob:recovered");
  });

  it("renders over the chat downloader without starting a stalled HTTP fetch", async () => {
    const http = vi.fn(() => new Promise<Response>(() => {}));
    vi.stubGlobal("fetch", http);
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL() { return "blob:chat-image"; }
      static revokeObjectURL() {}
    });
    const download = vi.fn(async () => new Blob(["image"], { type: "image/png" }));
    render(<Timeline thread={thread} imageRequest={{ ...request, download }} />);
    expect(await screen.findByRole("img", { name: "用户上传的图片 1" })).toHaveAttribute("src", "blob:chat-image");
    expect(http).not.toHaveBeenCalled();
    expect(download).toHaveBeenCalledWith(id, expect.any(AbortSignal));
  });

  it("retries a temporarily busy image download once without reusing an error from cache", async () => {
    const fetcher = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 503 }))
      .mockResolvedValueOnce(new Response("image data"));
    vi.stubGlobal("fetch", fetcher);
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL() { return "blob:retried-image"; }
      static revokeObjectURL() {}
    });
    render(<Timeline thread={thread} imageRequest={request} />);
    expect(await screen.findByRole("img", { name: "用户上传的图片 1" }, { timeout: 3000 }))
      .toHaveAttribute("src", "blob:retried-image");
    expect(fetcher).toHaveBeenCalledTimes(2);
    expect(fetcher).toHaveBeenLastCalledWith(`https://gateway.test/api/images/${id}`, {
      headers: { authorization: "Bearer test-secret" }, signal: expect.any(AbortSignal), cache: "reload",
    });
  });

  it("preserves an HTTP status instead of collapsing it into an unknown image error", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response(null, { status: 403 })));
    render(<Timeline thread={thread} imageRequest={request} />);
    expect(await screen.findByText(/图片加载失败.*HTTP 403/)).toBeInTheDocument();
  });

  it("identifies a failed request without exposing raw error text or credentials", async () => {
    vi.stubGlobal("fetch", vi.fn().mockRejectedValue(new TypeError("secret URL https://gateway.test/?token=test-secret")));
    render(<Timeline thread={thread} imageRequest={request} />);
    expect(await screen.findByText(/图片加载失败.*下载请求失败/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("test-secret");
    expect(document.body.textContent).not.toContain("gateway.test");
  });

  it("separates a response-body failure from a failed request", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: true, status: 200, blob: async () => { throw new TypeError("body interrupted"); } }));
    render(<Timeline thread={thread} imageRequest={request} />);
    expect(await screen.findByText(/图片加载失败.*读取图片数据失败/)).toBeInTheDocument();
  });

  it("identifies a preview creation failure without exposing the original exception", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("image data")));
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL(): string { throw new Error("test-secret"); }
    });
    render(<Timeline thread={thread} imageRequest={request} />);
    expect(await screen.findByText(/图片加载失败.*创建图片预览失败/)).toBeInTheDocument();
    expect(document.body.textContent).not.toContain("test-secret");
  });

  it("identifies a display failure after a successful download without guessing its cause", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue(new Response("not an image", { status: 200 })));
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL() { return "blob:diagnostic"; }
      static revokeObjectURL() {}
    });
    render(<Timeline thread={thread} imageRequest={request} />);
    fireEvent.error(await screen.findByRole("img", { name: "用户上传的图片 1" }));
    expect(await screen.findByText(/图片加载失败.*下载已完成，图片显示失败/)).toBeInTheDocument();
  });
});
