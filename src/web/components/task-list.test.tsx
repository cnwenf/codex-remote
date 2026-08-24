import { fireEvent, render, screen } from "@testing-library/react";
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

  it("uses Desktop project names and groups all of a project's root paths together", async () => {
    const desktopThreads = [
      {
        ...thread,
        projectId: "project-work",
        projectName: "日常干活",
        projectRootPaths: ["/code/works", "/code/yaochi"],
        cwd: "/code/works",
      },
      {
        ...thread,
        id: "t2",
        title: "Review Yaochi",
        projectId: "project-work",
        projectName: "日常干活",
        projectRootPaths: ["/code/works", "/code/yaochi"],
        cwd: "/code/yaochi",
      },
    ];

    render(<TaskList threads={desktopThreads} onSelect={vi.fn()} onNew={vi.fn()} />);

    expect(screen.getByRole("button", { name: /日常干活.*2 个对话/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /works.*1 个对话/ })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /yaochi.*1 个对话/ })).not.toBeInTheDocument();
  });

  it("keeps Desktop threads outside its project catalog in recent instead of inventing a project", () => {
    const looseThread = {
      ...thread,
      id: "loose",
      title: "Loose task",
      cwd: "/Users/example",
    };
    const desktopThread = {
      ...thread,
      projectId: "project-work",
      projectName: "日常干活",
      projectRootPaths: ["/code/works"],
      cwd: "/code/works",
    };

    render(<TaskList threads={[desktopThread, looseThread]} onSelect={vi.fn()} onNew={vi.fn()} />);

    expect(screen.getByRole("button", { name: /日常干活.*1 个对话/ })).toBeVisible();
    expect(screen.queryByRole("button", { name: /example.*1 个对话/ })).not.toBeInTheDocument();
    expect(screen.getByRole("region", { name: "最近" }))
      .toContainElement(screen.getByRole("button", { name: /^Loose task，/ }));
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
    await userEvent.click(screen.getByRole("button", { name: "对话操作 Fix login race" }));
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
    await userEvent.click(screen.getByRole("button", { name: "对话操作 Fix login race" }));
    await userEvent.click(screen.getByRole("button", { name: "取消置顶 Fix login race" }));
    expect(onTogglePin).toHaveBeenCalledTimes(2);
  });

  it("reveals synchronized pin and archive actions after a left swipe", async () => {
    const onTogglePin = vi.fn();
    const onArchive = vi.fn();
    render(
      <TaskList
        threads={[{ ...thread, cwd: undefined }]}
        onSelect={vi.fn()}
        onNew={vi.fn()}
        onTogglePin={onTogglePin}
        onArchive={onArchive}
      />,
    );

    const row = screen.getByRole("button", { name: /Fix login race，运行中/ }).closest(".task-row-shell");
    expect(row).toHaveAttribute("data-actions-open", "false");
    fireEvent(row as Element, new MouseEvent("pointerdown", { bubbles: true, clientX: 260, clientY: 40 }));
    fireEvent(row as Element, new MouseEvent("pointerup", { bubbles: true, clientX: 120, clientY: 45 }));
    expect(row).toHaveAttribute("data-actions-open", "true");

    await userEvent.click(screen.getByRole("button", { name: "归档 Fix login race" }));
    expect(onArchive).toHaveBeenCalledWith("t1");
    expect(row).toHaveAttribute("data-actions-open", "false");
  });
});
