import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { initialCodexState } from "../../protocol/thread-store";
import { hydrateThread } from "../state/conversation-history";
import { Timeline } from "./timeline";

afterEach(() => vi.unstubAllGlobals());

describe("tool result disclosure", () => {
  it.each([
    ["completed", "已查看图片"], ["running", "正在查看图片"],
    ["inProgress", "正在查看图片"], ["unknown", "查看图片"], ["failed", "查看图片失败"],
  ])("describes the ImageView reference action honestly when %s", (status, text) => {
    const state = hydrateThread(initialCodexState, { thread: { id: "t", turns: [{ id: "turn", items: [
      { id: "view", type: "ImageView", path: "/private/reference.png", status },
    ] }] } });
    const { container } = render(<Timeline thread={state.threads.t} />);
    expect(container.querySelector(".activity-copy > strong")).toHaveTextContent("查看图片");
    expect(container.querySelector(".activity-copy > span")).toHaveTextContent(text);
    expect(screen.queryByText("未收到结果正文")).not.toBeInTheDocument();
    expect(container.querySelector("img")).toBeNull();
    expect(container.textContent).not.toContain("/private/reference.png");
  });

  it("previews authenticated tool-returned images without claiming generation and clears previews on auth/task changes", async () => {
    const fetcher = vi.fn().mockResolvedValue({ ok: true, blob: async () => new Blob(["image"]) });
    const revoke = vi.fn();
    let nextUrl = 0;
    vi.stubGlobal("fetch", fetcher);
    vi.stubGlobal("URL", class extends URL {
      static createObjectURL() { return `blob:tool-${++nextUrl}`; }
      static revokeObjectURL(value: string) { revoke(value); }
    });
    const imageId = "00000000-0000-4000-8000-000000000001";
    const thread = hydrateThread(initialCodexState, { thread: { id: "t", turns: [{ id: "turn", status: "completed", items: [
      { id: "c", type: "toolCall", toolInput: "view_image(reference)", toolOutput: "Screenshot\n[非文本结果]",
        toolOutputImageIds: [imageId], toolOutputImagesIncomplete: true },
    ] }] } }).threads.t;
    const { rerender } = render(<Timeline thread={thread} imageRequest={{ baseUrl: "https://gateway.test", token: "first-token" }} />);
    await userEvent.click(screen.getByText("执行过程（1 项）"));
    await userEvent.click(screen.getByText("查看输入与结果"));
    expect(await screen.findByRole("img", { name: "工具返回图片 1" })).toHaveAttribute("src", "blob:tool-1");
    expect(fetcher).toHaveBeenCalledExactlyOnceWith(`https://gateway.test/api/images/${imageId}`, { headers: { authorization: "Bearer first-token" } });
    expect(screen.getByText(/部分工具图片不可用/)).toBeVisible();
    expect(screen.queryByText(/生成图片/)).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "预览工具返回图片 1" }));
    expect(screen.getByRole("dialog")).toBeVisible();
    expect(fetcher).toHaveBeenCalledTimes(1);
    rerender(<Timeline thread={thread} imageRequest={{ baseUrl: "https://gateway.test", token: "next-token" }} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(await screen.findByRole("img", { name: "工具返回图片 1" })).toHaveAttribute("src", "blob:tool-2");
    expect(revoke).toHaveBeenCalledExactlyOnceWith("blob:tool-1");
    await userEvent.click(screen.getByRole("button", { name: "预览工具返回图片 1" }));
    rerender(<Timeline thread={{ ...thread, id: "other-task" }} imageRequest={{ baseUrl: "https://gateway.test", token: "next-token" }} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    expect(document.body.innerHTML).not.toContain("next-token");
  });

  it("does not call an output-only partial history an empty conversation", () => {
    const state = hydrateThread(initialCodexState, { thread: { id: "t", turns: [] } });
    const thread = { ...state.threads.t, toolOutputWarning: "部分工具结果尚未找到对应调用；请继续加载较早对话以恢复。" };
    render(<Timeline thread={thread} />);
    expect(screen.queryByText("可以开始了")).not.toBeInTheDocument();
    expect(screen.getByRole("status")).toHaveTextContent("部分工具结果");
  });

  it("shows incomplete tool history honestly without hiding readable QA", () => {
    const state = hydrateThread(initialCodexState, { thread: { id: "t", turns: [{ id: "turn", status: "completed", items: [
      { id: "q", type: "userMessage", text: "检查结果" },
      { id: "a", type: "agentMessage", text: "最新回答仍然可读", phase: "final_answer" },
    ] }] } });
    const thread = { ...state.threads.t, toolOutputWarning: "部分工具结果尚未匹配，加载更早内容后继续核对。" };
    render(<Timeline thread={thread} />);
    expect(screen.getByRole("status")).toHaveTextContent("部分工具结果尚未匹配");
    expect(screen.getByText("检查结果")).toBeVisible();
    expect(screen.getByText("最新回答仍然可读")).toBeVisible();
  });

  it("expands readable input/output and marks truncation without rendering result HTML", async () => {
    const state = hydrateThread(initialCodexState, { thread: { id: "t", turns: [{ id: "turn", status: "completed", items: [
      { id: "c", type: "commandExecution", command: "pnpm test", aggregatedOutput: "<b>result</b>\n" + "x".repeat(17000) },
    ] }] } });
    render(<Timeline thread={state.threads.t} />);
    await userEvent.click(screen.getByText("执行过程（1 项）"));
    await userEvent.click(screen.getByText("查看输入与结果"));
    expect(screen.getByText("输入")).toBeVisible();
    expect(screen.getByText("结果")).toBeVisible();
    expect(screen.getByText(/已截断.*16384.*17014/)).toBeVisible();
    expect(screen.getByText(/<b>result<\/b>/).tagName).toBe("PRE");
  });

  it("distinguishes missing result from pending result", async () => {
    const state = hydrateThread(initialCodexState, { thread: { id: "t", turns: [{ id: "turn", status: "completed", items: [
      { id: "c", type: "commandExecution", command: "pwd", status: "completed" },
    ] }] } });
    render(<Timeline thread={state.threads.t} />);
    await userEvent.click(screen.getByText("执行过程（1 项）"));
    await userEvent.click(screen.getByText("查看输入与结果"));
    expect(screen.getByText("未收到结果正文")).toBeVisible();
  });
});
