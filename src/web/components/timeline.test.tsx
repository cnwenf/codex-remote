import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it } from "vitest";
import type { CodexThread } from "../../protocol/thread-store";
import { Timeline } from "./timeline";

describe("Timeline", () => {
  it("renders the latest Desktop todo list with pending running and completed states", () => {
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

    render(<Timeline thread={thread} />);

    expect(screen.getByLabelText("任务进度，1/3 已完成")).toBeVisible();
    expect(screen.getByText("Keep this list current")).toBeVisible();
    expect(screen.getByText("Inspect").closest("li")).toHaveClass("todo-completed");
    expect(screen.getByText("Implement").closest("li")).toHaveClass("todo-inProgress");
    expect(screen.getByText("Verify").closest("li")).toHaveClass("todo-pending");
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

  it("renders authenticated uploaded images in user messages", () => {
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
  });
});
