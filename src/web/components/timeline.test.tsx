import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CodexThread } from "../../protocol/thread-store";
import { Timeline, TodoListDock } from "./timeline";

describe("Timeline", () => {
  it("renders the latest Desktop todo list with pending running and completed states", async () => {
    const thread: CodexThread = {
      id: "todo",
      title: "Todo",
      status: "running",
      turnOrder: [],
      turns: {},
      todoList: {
        explanation: "Keep this list current",
        items: [
          { step: "Inspect", status: "completed" },
          { step: "Implement", status: "inProgress" },
          { step: "Verify", status: "pending" },
        ],
      },
    };

    render(<TodoListDock todoList={thread.todoList} running />);

    expect(screen.getByRole("button", { name: "任务进度，第 2/3 步" })).toBeVisible();
    expect(screen.queryByText("Keep this list current")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "任务进度，第 2/3 步" }));
    expect(screen.getByText("Keep this list current")).toBeVisible();
    expect(screen.getByText("Inspect").closest("li")).toHaveClass("todo-completed");
    expect(screen.getByText("Implement").closest("li")).toHaveClass("todo-inProgress");
    expect(screen.getByText("Verify").closest("li")).toHaveClass("todo-pending");
  });

  it("hides an unfinished todo dock while the thread is idle", () => {
    render(<TodoListDock
      running={false}
      todoList={{ items: [{ step: "Wait for the next turn", status: "inProgress" }] }}
    />);

    expect(screen.queryByRole("button", { name: /任务进度/ })).not.toBeInTheDocument();
  });

  it("does not bury the current todo inside the scrollable conversation history", () => {
    const thread: CodexThread = {
      id: "todo-history",
      title: "Todo",
      status: "running",
      turnOrder: [],
      turns: {},
      todoList: { items: [{ step: "Visible outside", status: "inProgress" }] },
    };
    render(<Timeline thread={thread} />);
    expect(screen.queryByText("Visible outside")).not.toBeInTheDocument();
  });

  it("hides the todo dock after every item is completed", () => {
    render(<TodoListDock running todoList={{
      explanation: "All work is done",
      items: [
        { step: "Implement", status: "completed" },
        { step: "Verify", status: "completed" },
      ],
    }} />);

    expect(screen.queryByRole("button", { name: /任务进度/ })).not.toBeInTheDocument();
    expect(screen.queryByText("All work is done")).not.toBeInTheDocument();
  });

  it("groups execution events inside their conversation turn", async () => {
    const thread: CodexThread = {
      id: "t1",
      title: "Grouped run",
      status: "idle",
      turnOrder: ["turn-1"],
      turns: {
        "turn-1": {
          id: "turn-1",
          status: "completed",
          durationMs: 4200,
          itemOrder: ["user", "reason", "tool", "agent"],
          items: {
            user: { id: "user", type: "userMessage", text: "Run tests" },
            reason: { id: "reason", type: "reasoning", text: "Inspecting failures" },
            tool: { id: "tool", type: "commandExecution", text: "pnpm test", status: "completed" },
            agent: { id: "agent", type: "agentMessage", text: "All tests pass" },
          },
        },
      },
    };

    render(<Timeline thread={thread} />);

    expect(screen.getByText("Run tests")).toBeVisible();
    expect(screen.getByText("All tests pass")).toBeVisible();
    expect(screen.getByText("执行过程（2 项）")).toBeVisible();
    expect(screen.queryByText("Inspecting failures")).not.toBeVisible();
    await userEvent.click(screen.getByText("执行过程（2 项）"));
    expect(screen.getByText("Inspecting failures")).toBeVisible();
    expect(screen.getByText("pnpm test")).toBeVisible();
  });

  it("collapses every intermediate assistant output into one completed turn process", async () => {
    const thread: CodexThread = {
      id: "completed-process",
      title: "Completed process",
      status: "idle",
      turnOrder: ["turn-1"],
      turns: {
        "turn-1": {
          id: "turn-1",
          status: "completed",
          durationMs: 62_000,
          itemOrder: ["user", "reason", "agent-progress-1", "tool", "agent-progress-2", "agent-final"],
          items: {
            user: { id: "user", type: "userMessage", text: "把问题修好" },
            reason: { id: "reason", type: "reasoning", text: "先定位根因" },
            "agent-progress-1": { id: "agent-progress-1", type: "agentMessage", text: "我先检查消息分组。" },
            tool: { id: "tool", type: "commandExecution", text: "pnpm test", status: "completed" },
            "agent-progress-2": { id: "agent-progress-2", type: "agentMessage", text: "测试已经通过。" },
            "agent-final": { id: "agent-final", type: "agentMessage", text: "问题已经修好。" },
          },
        },
      },
    };

    render(<Timeline thread={thread} />);

    expect(screen.getByText("把问题修好")).toBeVisible();
    expect(screen.getByText("问题已经修好。")).toBeVisible();
    expect(screen.getByText("执行过程（4 项）")).toBeVisible();
    expect(screen.getByText("1 分 2 秒")).toBeVisible();
    expect(screen.queryByText("我先检查消息分组。")).not.toBeVisible();
    expect(screen.queryByText("测试已经通过。")).not.toBeVisible();

    await userEvent.click(screen.getByText("执行过程（4 项）"));

    expect(screen.getByText("先定位根因")).toBeVisible();
    expect(screen.getByText("我先检查消息分组。")).toBeVisible();
    expect(screen.getByText("pnpm test")).toBeVisible();
    expect(screen.getByText("测试已经通过。")).toBeVisible();
  });

  it("keeps tool activity after the assistant text that preceded it and shows a running ellipsis", () => {
    const thread: CodexThread = {
      id: "ordered",
      title: "Ordered output",
      status: "running",
      activeTurnId: "turn-1",
      turnOrder: ["turn-1"],
      turns: {
        "turn-1": {
          id: "turn-1",
          status: "inProgress",
          itemOrder: ["agent-before", "tool-after"],
          items: {
            "agent-before": { id: "agent-before", type: "agentMessage", text: "先输出文字" },
            "tool-after": { id: "tool-after", type: "commandExecution", text: "pnpm test", status: "running" },
          },
        },
      },
    };

    const { container } = render(<Timeline thread={thread} />);
    const agent = screen.getByText("先输出文字").closest("article");
    const activity = screen.getByText("执行过程（1 项）").closest("details");
    expect((agent?.compareDocumentPosition(activity as Node) ?? 0) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    expect(activity).not.toHaveAttribute("open");
    expect(screen.getByLabelText("Codex 仍在输出")).toBeVisible();
    expect(container.querySelectorAll(".typing-dot")).toHaveLength(3);
  });

  it("shows one running ellipsis when stale history contains multiple in-progress turns", () => {
    const thread: CodexThread = {
      id: "stale-running-turns",
      title: "Only latest animates",
      status: "running",
      activeTurnId: "turn-2",
      turnOrder: ["turn-1", "turn-2"],
      turns: {
        "turn-1": {
          id: "turn-1",
          status: "inProgress",
          itemOrder: ["old-tool"],
          items: { "old-tool": { id: "old-tool", type: "commandExecution", text: "old" } },
        },
        "turn-2": {
          id: "turn-2",
          status: "inProgress",
          itemOrder: ["new-tool"],
          items: { "new-tool": { id: "new-tool", type: "commandExecution", text: "new" } },
        },
      },
    };

    const { container } = render(<Timeline thread={thread} />);

    expect(screen.getAllByLabelText("Codex 仍在输出")).toHaveLength(1);
    expect(container.querySelectorAll(".typing-dot")).toHaveLength(3);
    expect(container.querySelector('[data-turn-id="turn-2"] .typing-indicator')).toBeInTheDocument();
  });

  it("shows a running ellipsis while the active turn identity is being recovered", () => {
    const thread: CodexThread = {
      id: "recovering-running-turn",
      title: "Recover running identity",
      status: "running",
      turnOrder: ["turn-completed"],
      turns: {
        "turn-completed": {
          id: "turn-completed",
          status: "completed",
          itemOrder: ["agent-completed"],
          items: {
            "agent-completed": {
              id: "agent-completed",
              type: "agentMessage",
              text: "Earlier response",
            },
          },
        },
      },
    };

    const { container } = render(<Timeline thread={thread} />);

    expect(screen.getAllByLabelText("Codex 仍在输出")).toHaveLength(1);
    expect(container.querySelectorAll(".typing-dot")).toHaveLength(3);
  });

  it("keeps intermediate assistant text visible until the whole thread is terminal", () => {
    const thread: CodexThread = {
      id: "premature-terminal-turn",
      title: "Do not collapse live text",
      status: "running",
      turnOrder: ["turn-1"],
      turns: {
        "turn-1": {
          id: "turn-1",
          status: "completed",
          itemOrder: ["user-1", "agent-progress", "tool-1", "agent-latest"],
          items: {
            "user-1": { id: "user-1", type: "userMessage", text: "继续处理" },
            "agent-progress": { id: "agent-progress", type: "agentMessage", text: "我先定位状态同步问题" },
            "tool-1": { id: "tool-1", type: "commandExecution", text: "pnpm test", status: "running" },
            "agent-latest": { id: "agent-latest", type: "agentMessage", text: "还在继续检查" },
          },
        },
      },
    };

    const { rerender } = render(<Timeline thread={thread} />);
    expect(screen.getByText("我先定位状态同步问题")).toBeVisible();
    expect(screen.getByText("还在继续检查")).toBeVisible();
    expect(screen.getByLabelText("Codex 仍在输出")).toBeVisible();

    rerender(<Timeline thread={{ ...thread, status: "idle" }} />);
    expect(screen.getByText("我先定位状态同步问题")).not.toBeVisible();
    expect(screen.getByText("还在继续检查")).toBeVisible();
  });

  it("marks an earlier activity group complete once later assistant output arrives", () => {
    const thread: CodexThread = {
      id: "later-output",
      title: "Later output",
      status: "running",
      activeTurnId: "turn-1",
      turnOrder: ["turn-1"],
      turns: {
        "turn-1": {
          id: "turn-1",
          status: "inProgress",
          itemOrder: ["tool", "agent"],
          items: {
            tool: { id: "tool", type: "commandExecution", text: "done" },
            agent: { id: "agent", type: "agentMessage", text: "新的文本" },
          },
        },
      },
    };

    const { container } = render(<Timeline thread={thread} />);
    expect(screen.getByText("执行过程（1 项）").closest("details")).not.toHaveAttribute("open");
    expect(container.querySelector(".activity-group .run-completed")).toBeInTheDocument();
    expect(container.querySelector(".activity-group .run-inProgress")).not.toBeInTheDocument();
  });

  it("only expands a running activity group after the user opens it", async () => {
    const thread: CodexThread = {
      id: "manual-activity",
      title: "Manual activity",
      status: "running",
      activeTurnId: "turn-1",
      turnOrder: ["turn-1"],
      turns: {
        "turn-1": {
          id: "turn-1",
          status: "inProgress",
          itemOrder: ["tool"],
          items: {
            tool: { id: "tool", type: "commandExecution", text: "running", status: "running" },
          },
        },
      },
    };
    const { rerender } = render(<Timeline thread={thread} />);
    const summary = screen.getByText("执行过程（1 项）");
    const activity = summary.closest("details");
    expect(activity).not.toHaveAttribute("open");

    await userEvent.click(summary);
    expect(activity).toHaveAttribute("open");

    const updated = structuredClone(thread);
    updated.turns["turn-1"].itemOrder.push("tool-2");
    updated.turns["turn-1"].items["tool-2"] = {
      id: "tool-2",
      type: "commandExecution",
      text: "next",
      status: "running",
    };
    rerender(<Timeline thread={updated} />);
    expect(screen.getByText("执行过程（2 项）").closest("details")).toHaveAttribute("open");
  });

  it("collapses an earlier completed activity segment after newer assistant output", () => {
    const thread: CodexThread = {
      id: "completed-segment",
      title: "Completed segment",
      status: "running",
      activeTurnId: "turn-1",
      turnOrder: ["turn-1"],
      turns: {
        "turn-1": {
          id: "turn-1",
          status: "inProgress",
          itemOrder: ["tool", "agent"],
          items: {
            tool: { id: "tool", type: "commandExecution", text: "done", status: "completed" },
            agent: { id: "agent", type: "agentMessage", text: "工具之后的新文本" },
          },
        },
      },
    };
    const { container } = render(<Timeline thread={thread} />);
    const activity = screen.getByText("执行过程（1 项）").closest("details");
    expect(activity).not.toHaveAttribute("open");
    expect(container.querySelector(".activity-group .run-inProgress")).toBeNull();
  });

  it("renders assistant messages as safe GitHub-flavored Markdown", () => {
    const thread: CodexThread = {
      id: "markdown",
      title: "Markdown",
      status: "idle",
      turnOrder: ["turn-1"],
      turns: {
        "turn-1": {
          id: "turn-1",
          status: "completed",
          itemOrder: ["agent"],
          items: {
            agent: {
              id: "agent",
              type: "agentMessage",
              text: "## 结果\n\n- 第一项\n- 第二项\n\n使用 `pnpm test`。\n\n<script>unsafe()</script>",
            },
          },
        },
      },
    };

    const { container } = render(<Timeline thread={thread} />);

    expect(screen.getByRole("heading", { name: "结果", level: 2 })).toBeVisible();
    expect(container.querySelector(".markdown-body ul")).toHaveTextContent(/第一项\s*第二项/);
    expect(container.querySelector("code")).toHaveTextContent("pnpm test");
    expect(container.querySelector("script")).toBeNull();
  });

  it("strips executable Markdown URLs while isolating ordinary external links", () => {
    const thread: CodexThread = {
      id: "unsafe-links",
      title: "Unsafe links",
      status: "idle",
      turnOrder: ["turn-1"],
      turns: {
        "turn-1": {
          id: "turn-1",
          status: "completed",
          itemOrder: ["agent"],
          items: {
            agent: {
              id: "agent",
              type: "agentMessage",
              text: "[脚本](javascript:alert(1)) [数据](data:text/html,<script>alert(1)</script>) [安全](https://example.com/docs)",
            },
          },
        },
      },
    };

    render(<Timeline thread={thread} />);

    expect(screen.queryByRole("link", { name: "脚本" })).not.toBeInTheDocument();
    expect(screen.queryByRole("link", { name: "数据" })).not.toBeInTheDocument();
    expect(screen.getByText("脚本")).toHaveAttribute("data-invalid-link", "true");
    expect(screen.getByText("数据")).toHaveAttribute("data-invalid-link", "true");
    expect(screen.getByRole("link", { name: "安全" })).toHaveAttribute("href", "https://example.com/docs");
    expect(screen.getByRole("link", { name: "安全" })).toHaveAttribute("rel", "noreferrer noopener");
  });

  it("routes conversation web links through the native browser callback", async () => {
    const openExternalUrl = vi.fn();
    const thread: CodexThread = {
      id: "native-link",
      title: "Native link",
      status: "idle",
      turnOrder: ["turn-1"],
      turns: {
        "turn-1": {
          id: "turn-1",
          status: "completed",
          itemOrder: ["agent"],
          items: {
            agent: {
              id: "agent",
              type: "agentMessage",
              text: "打开 [内网页面](http://192.168.1.20:8080/status)",
            },
          },
        },
      },
    };

    render(<Timeline thread={thread} onOpenExternalUrl={openExternalUrl} />);
    await userEvent.click(screen.getByRole("link", { name: "内网页面" }));

    expect(openExternalUrl).toHaveBeenCalledOnce();
    expect(openExternalUrl).toHaveBeenCalledWith("http://192.168.1.20:8080/status");
  });

  it("previews authenticated uploaded images without navigating away from the conversation", async () => {
    const thread: CodexThread = {
      id: "images",
      title: "Images",
      status: "idle",
      turnOrder: ["turn-1"],
      turns: {
        "turn-1": {
          id: "turn-1",
          status: "completed",
          itemOrder: ["user"],
          items: {
            user: {
              id: "user",
              type: "userMessage",
              text: "看这张图",
              imageIds: ["e77e86c9-bc6b-4aaa-9b6a-d87a55f694c1"],
            },
          },
        },
      },
    };

    render(<Timeline thread={thread} />);

    expect(screen.getByRole("img", { name: "用户上传的图片 1" })).toHaveAttribute(
      "src",
      "/api/images/e77e86c9-bc6b-4aaa-9b6a-d87a55f694c1",
    );
    expect(screen.queryByRole("link", { name: "打开用户上传的图片 1" })).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "预览用户上传的图片 1" }));
    expect(screen.getByRole("dialog", { name: "用户上传的图片 1" })).toBeVisible();
    expect(screen.getByRole("img", { name: "用户上传的图片 1 预览" })).toHaveAttribute(
      "src",
      "/api/images/e77e86c9-bc6b-4aaa-9b6a-d87a55f694c1",
    );
    await userEvent.click(screen.getByRole("button", { name: "关闭图片预览" }));
    expect(screen.queryByRole("dialog", { name: "用户上传的图片 1" })).not.toBeInTheDocument();
  });

  it("opens remotely authenticated images from a revocable blob URL", async () => {
    const createObjectURL = vi.fn(() => "blob:authenticated-image");
    const revokeObjectURL = vi.fn();
    const originalCreateObjectURL = URL.createObjectURL;
    const originalRevokeObjectURL = URL.revokeObjectURL;
    Object.defineProperty(URL, "createObjectURL", { configurable: true, value: createObjectURL });
    Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: revokeObjectURL });
    const fetchImage = vi.spyOn(globalThis, "fetch").mockResolvedValue({
      ok: true,
      blob: vi.fn(async () => new Blob(["image"], { type: "image/png" })),
    } as unknown as Response);
    const thread: CodexThread = {
      id: "remote-image",
      title: "Remote image",
      status: "idle",
      turnOrder: ["turn-1"],
      turns: {
        "turn-1": {
          id: "turn-1",
          status: "completed",
          itemOrder: ["user"],
          items: {
            user: { id: "user", type: "userMessage", text: "远端图片", imageIds: ["remote-image-id"] },
          },
        },
      },
    };

    try {
      const { unmount } = render(<Timeline
        thread={thread}
        imageRequest={{ baseUrl: "https://remote.example.test", token: "secret-token" }}
      />);

      const preview = await screen.findByRole("button", { name: "预览用户上传的图片 1" });
      await waitFor(() => expect(screen.getByRole("img", { name: "用户上传的图片 1" }))
        .toHaveAttribute("src", "blob:authenticated-image"));
      await userEvent.click(preview);
      expect(screen.getByRole("img", { name: "用户上传的图片 1 预览" }))
        .toHaveAttribute("src", "blob:authenticated-image");
      expect(fetchImage).toHaveBeenCalledWith(
        "https://remote.example.test/api/images/remote-image-id",
        { headers: { authorization: "Bearer secret-token" } },
      );
      expect(createObjectURL).toHaveBeenCalledOnce();

      unmount();
      expect(revokeObjectURL).toHaveBeenCalledWith("blob:authenticated-image");
    } finally {
      fetchImage.mockRestore();
      if (originalCreateObjectURL) {
        Object.defineProperty(URL, "createObjectURL", { configurable: true, value: originalCreateObjectURL });
      } else {
        Reflect.deleteProperty(URL, "createObjectURL");
      }
      if (originalRevokeObjectURL) {
        Object.defineProperty(URL, "revokeObjectURL", { configurable: true, value: originalRevokeObjectURL });
      } else {
        Reflect.deleteProperty(URL, "revokeObjectURL");
      }
    }
  });

  it("does not render an input placeholder for an image-only user message", () => {
    const thread: CodexThread = {
      id: "image-only",
      title: "Image only",
      status: "idle",
      turnOrder: ["turn-1"],
      turns: {
        "turn-1": {
          id: "turn-1",
          status: "completed",
          itemOrder: ["user"],
          items: {
            user: {
              id: "user",
              type: "userMessage",
              text: "",
              imageIds: ["image-only-id"],
            },
          },
        },
      },
    };

    render(<Timeline thread={thread} />);

    expect(screen.queryByText("等待输入…")).not.toBeInTheDocument();
    expect(screen.getByRole("img", { name: "用户上传的图片 1" })).toBeVisible();
  });

  it("does not flash an input placeholder while image metadata is still arriving", () => {
    const thread: CodexThread = {
      id: "image-pending-metadata",
      title: "Image metadata pending",
      status: "running",
      turnOrder: ["turn-1"],
      turns: {
        "turn-1": {
          id: "turn-1",
          status: "inProgress",
          itemOrder: ["user"],
          items: {
            user: {
              id: "user",
              type: "userMessage",
              text: "",
            },
          },
        },
      },
    };

    render(<Timeline thread={thread} />);

    expect(screen.queryByText("等待输入…")).not.toBeInTheDocument();
  });
});
