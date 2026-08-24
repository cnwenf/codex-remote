import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import type { CodexThread } from "../../protocol/thread-store";
import { TaskList } from "./task-list";

const thread: CodexThread = {
  id: "t1",
  title: "Fix login race",
  cwd: "/code/app",
  updatedAt: 1_787_200_000,
  status: "running",
  turnOrder: [],
  turns: {},
};

describe("TaskList", () => {
  it("opens a selected task", async () => {
    const onSelect = vi.fn();
    render(<TaskList threads={[thread]} onSelect={onSelect} onNew={vi.fn()} />);

    await userEvent.click(screen.getByRole("button", { name: /app.*1 个对话/ }));
    await userEvent.click(screen.getByRole("button", { name: /Fix login race/ }));

    expect(onSelect).toHaveBeenCalledWith("t1");
  });

  it("filters tasks by title or project path", async () => {
    render(<TaskList threads={[thread]} onSelect={vi.fn()} onNew={vi.fn()} />);

    await userEvent.type(screen.getByRole("searchbox"), "missing");
    expect(screen.getByText("没有匹配的对话")).toBeVisible();
    await userEvent.clear(screen.getByRole("searchbox"));
    await userEvent.type(screen.getByRole("searchbox"), "/code/app");
    expect(screen.getByRole("button", { name: /Fix login race/ })).toBeVisible();
  });

  it("shows recent conversations and groups project conversations by working directory", async () => {
    const second = {
      ...thread,
      id: "t2",
      title: "Review worker",
      status: "idle" as const,
    };

    render(<TaskList threads={[thread, second]} onSelect={vi.fn()} onNew={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "最近" })).toBeVisible();
    expect(screen.getByRole("heading", { name: "项目" })).toBeVisible();
    expect(screen.getByRole("button", { name: /app.*2 个对话/ })).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: /app.*2 个对话/ }));
    expect(screen.getByRole("button", { name: /Fix login race.*运行中/ })).toBeVisible();
  });

  it("keeps all direct conversations accessible in the recent section", () => {
    const directThreads = Array.from({ length: 9 }, (_, index) => ({
      ...thread,
      id: `direct-${index}`,
      title: `Direct conversation ${index + 1}`,
      cwd: "/service/default",
    }));

    render(
      <TaskList
        threads={directThreads}
        directCwd="/service/default"
        onSelect={vi.fn()}
        onNew={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: /Direct conversation 9/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /default.*9 个对话/ })).not.toBeInTheDocument();
  });

  it("renders pinned conversations before projects and recent without duplicating them", () => {
    const pinned = {
      ...thread,
      id: "pinned",
      title: "Pinned task",
      sectionId: "pinned-section",
      sectionName: "Pinned",
    };
    const direct = {
      ...thread,
      id: "direct",
      title: "Direct task",
      cwd: "/service/default",
    };

    render(
      <TaskList
        threads={[pinned, direct]}
        directCwd="/service/default"
        onSelect={vi.fn()}
        onNew={vi.fn()}
        onTogglePin={vi.fn()}
      />,
    );

    const headings = screen.getAllByRole("heading").map((heading) => heading.textContent);
    expect(headings.indexOf("置顶")).toBeLessThan(headings.indexOf("项目"));
    expect(headings.indexOf("项目")).toBeLessThan(headings.indexOf("最近"));
    expect(screen.getByRole("region", { name: "置顶" })).toHaveTextContent("Pinned task");
    expect(screen.getByRole("region", { name: "最近" })).not.toHaveTextContent("Pinned task");
  });

  it("treats Desktop generated Documents Codex folders as direct conversations", () => {
    const generated = {
      ...thread,
      id: "generated",
      title: "Generated projectless task",
      cwd: "/Users/me/Documents/Codex/2026-08-20/generated-task",
    };

    render(<TaskList threads={[generated]} onSelect={vi.fn()} onNew={vi.fn()} />);

    expect(screen.getByRole("region", { name: "最近" })).toHaveTextContent("Generated projectless task");
    expect(screen.queryByRole("button", { name: /generated-task.*1 个对话/ })).not.toBeInTheDocument();
  });

  it("requests pin and unpin from the conversation action", async () => {
    const onTogglePin = vi.fn();
    const { rerender } = render(
      <TaskList
        threads={[thread]}
        onSelect={vi.fn()}
        onNew={vi.fn()}
        onTogglePin={onTogglePin}
      />,
    );

    await userEvent.click(screen.getByRole("button", { name: /app.*1 个对话/ }));
    await userEvent.click(screen.getByRole("button", { name: "置顶 Fix login race" }));
    expect(onTogglePin).toHaveBeenCalledWith("t1");

    rerender(
      <TaskList
        threads={[{ ...thread, sectionId: "pinned", sectionName: "Pinned" }]}
        onSelect={vi.fn()}
        onNew={vi.fn()}
        onTogglePin={onTogglePin}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "取消置顶 Fix login race" }));
    expect(onTogglePin).toHaveBeenCalledTimes(2);
  });
});
