import { fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialCodexState } from "../../protocol/thread-store";
import { hydrateThread } from "../state/conversation-history";
import { Timeline } from "./timeline";

const id = "00000000-0000-4000-8000-000000000001";
const request = { baseUrl: "https://gateway.test", token: "test-secret" };
const thread = hydrateThread(initialCodexState, { thread: { id: "t", turns: [{ id: "turn", status: "completed", items: [
  { id: "user", type: "userMessage", text: "Picture", imageIds: [id] },
] }] } }).threads.t;

afterEach(() => vi.unstubAllGlobals());

describe("image failure evidence", () => {
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
