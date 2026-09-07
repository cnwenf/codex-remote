import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialCodexState, reduceCodexState } from "../../protocol/thread-store";
import { hydrateThread } from "../state/conversation-history";
import { Timeline } from "./timeline";

const id = "00000000-0000-4000-8000-000000000001";
const nextId = "00000000-0000-4000-8000-000000000002";
const source = "file:///tmp/local%20image.png";
function thread(localImages?: Record<string, string>, linked = false) {
  const image = `![Generated](${source})`;
  return hydrateThread(initialCodexState, { thread: { id: "t", turns: [{ id: "turn", status: "completed", items: [
    { id: "a", type: "agentMessage", text: `${linked ? `[${image}](https://example.test/image)` : image}\n![Remote](https://example.test/image.png)\n[Open website](https://example.test)`, localImages },
  ] }] } }).threads.t;
}

afterEach(() => vi.unstubAllGlobals());

describe("assistant local image rendering", () => {
  it("uses the exact opaque mapping and authorization header, supports preview, and never sends the token to external images", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(["image"]) });
    vi.stubGlobal("fetch", fetcher);
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL() { return "blob:local-preview"; }
      static revokeObjectURL() {}
    });
    const value = thread({ [source]: id });
    render(<Timeline thread={value} imageRequest={{ baseUrl: "https://gateway.test", token: "test-secret" }} />);
    expect(await screen.findByRole("img", { name: "Generated" })).toHaveAttribute("src", "blob:local-preview");
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`https://gateway.test/api/images/${id}`, { headers: { authorization: "Bearer test-secret" } });
    expect(screen.getByRole("img", { name: "Remote" })).toHaveAttribute("src", "https://example.test/image.png");
    expect(document.body.innerHTML).not.toContain("test-secret");
    await userEvent.click(screen.getByRole("button", { name: "预览Generated" }));
    expect(screen.getByRole("img", { name: "Generated 预览" })).toHaveAttribute("src", "blob:local-preview");
    expect(value.turns.turn.items.a.text).toContain(source);
  });

  it.each([false, true])("keeps an authenticated image mounted across thread updates and opening its preview (linked: %s)", async (linked) => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(["image"]) });
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL() { return "blob:stable-preview"; }
      static revokeObjectURL(value: string) { revokeObjectURL(value); }
    });
    const value = thread({ [source]: id }, linked);
    const imageRequest = { baseUrl: "https://gateway.test", token: "test-secret" };
    const openExternal = vi.fn();
    const nextOpenExternal = vi.fn();
    const { rerender } = render(<Timeline thread={value} imageRequest={imageRequest} onOpenExternalUrl={openExternal} />);
    expect(await screen.findByRole("img", { name: "Generated" })).toHaveAttribute("src", "blob:stable-preview");

    rerender(<Timeline thread={{ ...value }} imageRequest={imageRequest} onOpenExternalUrl={nextOpenExternal} />);
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).not.toHaveBeenCalled();

    await userEvent.click(screen.getByRole("button", { name: "预览Generated" }));
    expect(screen.getByRole("img", { name: "Generated 预览" })).toHaveAttribute("src", "blob:stable-preview");
    expect(fetcher).toHaveBeenCalledTimes(1);
    expect(revokeObjectURL).not.toHaveBeenCalled();
    expect(openExternal).not.toHaveBeenCalled();
    expect(nextOpenExternal).not.toHaveBeenCalled();
    await userEvent.click(screen.getByRole("button", { name: "关闭图片预览" }));
    await userEvent.click(screen.getByRole("link", { name: "Open website" }));
    expect(nextOpenExternal).toHaveBeenCalledExactlyOnceWith("https://example.test");
  });

  it.each([false, true])("reloads with current authorization and releases each blob when the image identity changes (linked: %s)", async (linked) => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(["image"]) });
    const createObjectURL = vi.fn()
      .mockReturnValueOnce("blob:first")
      .mockReturnValueOnce("blob:second")
      .mockReturnValueOnce("blob:third");
    const revokeObjectURL = vi.fn();
    vi.stubGlobal("fetch", fetcher);
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL(blob: Blob) { return createObjectURL(blob); }
      static revokeObjectURL(value: string) { revokeObjectURL(value); }
    });
    const { rerender, unmount } = render(<Timeline thread={thread({ [source]: id }, linked)}
      imageRequest={{ baseUrl: "https://first.test", token: "first-secret" }} />);
    expect(await screen.findByRole("img", { name: "Generated" })).toHaveAttribute("src", "blob:first");

    rerender(<Timeline thread={thread({ [source]: id }, linked)}
      imageRequest={{ baseUrl: "https://second.test", token: "second-secret" }} />);
    expect(await screen.findByRole("img", { name: "Generated" })).toHaveAttribute("src", "blob:second");
    expect(fetcher).toHaveBeenNthCalledWith(2, `https://second.test/api/images/${id}`, {
      headers: { authorization: "Bearer second-secret" },
    });
    expect(revokeObjectURL).toHaveBeenCalledExactlyOnceWith("blob:first");

    rerender(<Timeline thread={thread({ [source]: nextId }, linked)}
      imageRequest={{ baseUrl: "https://second.test", token: "second-secret" }} />);
    expect(await screen.findByRole("img", { name: "Generated" })).toHaveAttribute("src", "blob:third");
    expect(fetcher).toHaveBeenNthCalledWith(3, `https://second.test/api/images/${nextId}`, {
      headers: { authorization: "Bearer second-secret" },
    });
    expect(revokeObjectURL).toHaveBeenNthCalledWith(2, "blob:second");

    unmount();
    expect(revokeObjectURL).toHaveBeenNthCalledWith(3, "blob:third");
  });

  it("shows unavailable local images and failed authenticated downloads instead of loading forever", async () => {
    vi.stubGlobal("fetch", vi.fn().mockResolvedValue({ ok: false }));
    const { rerender } = render(<Timeline thread={thread()} />);
    expect(screen.getByText("本机图片不可用：Generated")).toBeVisible();
    expect(screen.queryByRole("img", { name: "Generated" })).not.toBeInTheDocument();
    rerender(<Timeline thread={thread({ [source]: id })} imageRequest={{ baseUrl: "https://gateway.test", token: "test-secret" }} />);
    expect(await screen.findByText("图片加载失败：Generated")).toBeVisible();
    await waitFor(() => expect(screen.queryByText("正在加载图片…")).not.toBeInTheDocument());
  });

  it("keeps mappings across live completion and partial hydration", () => {
    const live = reduceCodexState(initialCodexState, { method: "item/completed", params: { threadId: "t", turnId: "turn", item: {
      id: "a", type: "agentMessage", text: `![Generated](${source})`, localImages: { [source]: id },
    } } });
    expect(live.threads.t.turns.turn.items.a).toMatchObject({ localImages: { [source]: id } });
    const refreshed = hydrateThread(live, { thread: { id: "t", turns: [{ id: "turn", status: "completed", items: [
      { id: "a", type: "agentMessage", text: `![Generated](${source})` },
    ] }] } });
    expect(refreshed.threads.t.turns.turn.items.a).toMatchObject({ localImages: { [source]: id } });
  });
});
