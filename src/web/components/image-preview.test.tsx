import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import { initialCodexState } from "../../protocol/thread-store";
import { hydrateThread } from "../state/conversation-history";
import { Timeline } from "./timeline";

const thread = hydrateThread(initialCodexState, { thread: { id: "t", turns: [{ id: "turn", status: "completed", items: [
  { id: "image", type: "userMessage", text: "Picture", imageIds: ["00000000-0000-4000-8000-000000000001"] },
] }] } }).threads.t;

describe("full-screen image preview", () => {
  it.each(["button", "Escape", "backdrop"])("mounts outside the scrolling ancestor and closes with %s", async (method) => {
    const { container } = render(<div style={{ overflow: "hidden", transform: "translateZ(0)" }}><Timeline thread={thread} /></div>);
    await userEvent.click(screen.getByRole("button", { name: "预览用户上传的图片 1" }));
    const dialog = screen.getByRole("dialog");
    expect(dialog.parentElement).toBe(document.body);
    expect(container).not.toContainElement(dialog);
    if (method === "Escape") await userEvent.keyboard("{Escape}");
    else if (method === "button") await userEvent.click(screen.getByRole("button", { name: "关闭图片预览" }));
    else await userEvent.click(dialog);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });

  it("removes the body portal on task switch and unmount", async () => {
    const { rerender, unmount } = render(<Timeline thread={thread} />);
    await userEvent.click(screen.getByRole("button", { name: "预览用户上传的图片 1" }));
    expect(screen.getByRole("dialog").parentElement).toBe(document.body);
    rerender(<Timeline thread={{ ...thread, id: "another-task" }} />);
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "预览用户上传的图片 1" }));
    unmount();
    expect(screen.queryByRole("dialog")).not.toBeInTheDocument();
  });
});
