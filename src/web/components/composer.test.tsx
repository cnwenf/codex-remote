import { act, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Composer } from "./composer";

describe("Composer", () => {
  it("starts as one line, expands on focus, and can be collapsed without losing the draft", async () => {
    const { rerender } = render(
      <Composer
        onSend={vi.fn()}
        running={false}
        expanded={false}
        onExpandedChange={vi.fn()}
        models={[{ id: "gpt-test", displayName: "GPT Test", defaultReasoningEffort: "high", reasoningEfforts: ["high"] }]}
        model="gpt-test"
      />,
    );
    const input = screen.getByRole("textbox", { name: "Instruction" });
    expect(input).toHaveAttribute("rows", "1");
    expect(screen.queryByLabelText("对话设置")).not.toBeInTheDocument();

    rerender(
      <Composer
        onSend={vi.fn()}
        running={false}
        expanded
        onExpandedChange={vi.fn()}
        models={[{ id: "gpt-test", displayName: "GPT Test", defaultReasoningEffort: "high", reasoningEfforts: ["high"] }]}
        model="gpt-test"
      />,
    );
    await userEvent.type(input, "draft stays");
    expect(input).toHaveAttribute("rows", "3");
    expect(screen.getByLabelText("对话设置")).toBeVisible();

    rerender(
      <Composer
        onSend={vi.fn()}
        running={false}
        expanded={false}
        onExpandedChange={vi.fn()}
        models={[{ id: "gpt-test", displayName: "GPT Test", defaultReasoningEffort: "high", reasoningEfforts: ["high"] }]}
        model="gpt-test"
      />,
    );
    expect(input).toHaveValue("draft stays");
    expect(input).toHaveAttribute("rows", "1");
  });

  it("restores an unsent draft per conversation after navigation and remount", async () => {
    localStorage.clear();
    const props = { onSend: vi.fn(), running: false };
    const { rerender, unmount } = render(<Composer {...props} draftKey="thread-a" />);
    const input = screen.getByRole("textbox", { name: "Instruction" });
    await userEvent.type(input, "unfinished message");

    rerender(<Composer {...props} draftKey="thread-b" />);
    expect(input).toHaveValue("");
    await userEvent.type(input, "another draft");
    rerender(<Composer {...props} draftKey="thread-a" />);
    expect(input).toHaveValue("unfinished message");

    unmount();
    render(<Composer {...props} draftKey="thread-a" />);
    expect(screen.getByRole("textbox", { name: "Instruction" })).toHaveValue("unfinished message");
  });

  it("sends composer text and clears only after success", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<Composer onSend={onSend} running={false} />);

    const input = screen.getByRole("textbox", { name: "Instruction" });
    await userEvent.type(input, "Run the tests");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(onSend).toHaveBeenCalledWith("Run the tests", []);
    expect(input).toHaveValue("");
  });

  it("submits only once when the send button is double-clicked", async () => {
    let finish: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const onSend = vi.fn(() => pending);
    render(<Composer onSend={onSend} running={false} />);

    await userEvent.type(screen.getByRole("textbox", { name: "Instruction" }), "Send once");
    await userEvent.dblClick(screen.getByRole("button", { name: "Send" }));

    expect(onSend).toHaveBeenCalledTimes(1);
    await act(async () => finish?.());
  });

  it("keeps composer text when sending fails", async () => {
    const onSend = vi.fn().mockRejectedValue(new Error("offline"));
    render(<Composer onSend={onSend} running={false} />);

    const input = screen.getByRole("textbox", { name: "Instruction" });
    await userEvent.type(input, "Keep this");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(input).toHaveValue("Keep this");
    expect(screen.getByRole("alert")).toHaveTextContent("offline");
  });

  it("does not submit a composing IME value on the send shortcut", async () => {
    const onSend = vi.fn();
    render(<Composer onSend={onSend} running={false} />);
    const input = screen.getByRole("textbox", { name: "Instruction" });
    await userEvent.type(input, "拼音输入中");

    fireEvent.keyDown(input, { key: "Enter", metaKey: true, isComposing: true });

    expect(onSend).not.toHaveBeenCalled();
    expect(input).toHaveValue("拼音输入中");
  });

  it("offers stop and steer while a task is running", () => {
    render(<Composer onSend={vi.fn()} running onStop={vi.fn()} expanded />);

    expect(screen.getByRole("button", { name: "Steer" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Stop" })).toBeVisible();
  });

  it("interrupts only once when the stop button is double-clicked", async () => {
    let finish: (() => void) | undefined;
    const pending = new Promise<void>((resolve) => { finish = resolve; });
    const onStop = vi.fn(() => pending);
    render(<Composer onSend={vi.fn()} running onStop={onStop} expanded />);

    await userEvent.dblClick(screen.getByRole("button", { name: "Stop" }));

    expect(onStop).toHaveBeenCalledTimes(1);
    await act(async () => finish?.());
  });

  it("labels the running Desktop action as queue", () => {
    render(<Composer onSend={vi.fn()} running runningMode="queue" expanded />);
    expect(screen.getByRole("button", { name: "排队" })).toBeVisible();
  });

  it("supports selecting and pasting multiple images and keeps them until send succeeds", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<Composer onSend={onSend} running={false} expanded />);
    const picker = screen.getByLabelText("添加图片");
    const first = new File(["png"], "first.png", { type: "image/png" });
    const second = new File(["jpg"], "second.jpg", { type: "image/jpeg" });

    await userEvent.upload(picker, [first, second]);
    expect(screen.getByText("first.png")).toBeVisible();
    expect(screen.getByText("second.jpg")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(onSend).toHaveBeenCalledWith("", [first, second]);
    expect(screen.queryByText("first.png")).not.toBeInTheDocument();
  });

  it("keeps selected images when sending fails", async () => {
    const onSend = vi.fn().mockRejectedValue(new Error("upload failed"));
    render(<Composer onSend={onSend} running={false} expanded />);
    const image = new File(["png"], "keep.png", { type: "image/png" });
    await userEvent.upload(screen.getByLabelText("添加图片"), image);
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(screen.getByText("keep.png")).toBeVisible();
    expect(screen.getByRole("alert")).toHaveTextContent("upload failed");
  });

  it("explains when an image selection exceeds the four-file limit", async () => {
    render(<Composer onSend={vi.fn()} running={false} expanded />);
    const images = Array.from({ length: 5 }, (_, index) =>
      new File([`image-${index}`], `image-${index}.png`, { type: "image/png" })
    );

    await userEvent.upload(screen.getByLabelText("添加图片"), images);

    expect(screen.getAllByRole("button", { name: /^移除 / })).toHaveLength(4);
    expect(screen.getByRole("alert")).toHaveTextContent(/最多.*4.*张/);
  });

  it("shows and updates the current model reasoning effort and permission", async () => {
    const onSettingsChange = vi.fn();
    const props = {
      onSend: vi.fn(),
      running: false,
      models: [
        {
          id: "gpt-test",
          displayName: "GPT Test",
          defaultReasoningEffort: "medium",
          reasoningEfforts: ["medium", "high"],
        },
        {
          id: "gpt-next",
          displayName: "GPT Next",
          defaultReasoningEffort: "high",
          reasoningEfforts: ["low", "high"],
        },
      ],
      permissions: [
        {
          id: "auto",
          label: "请求批准",
          description: "编辑外部文件和使用互联网时始终询问",
        },
        {
          id: "guardian-approvals",
          label: "帮我批准",
          description: "仅对检测到的风险操作请求批准",
        },
        {
          id: "full-access",
          label: "完全访问权限",
          description: "可不受限制地访问互联网和你电脑上的任何文件",
        },
      ],
      onSettingsChange,
    };
    const { rerender } = render(
      <Composer
        {...props}
        expanded
        model="gpt-test"
        reasoningEffort="high"
        permission="auto"
        onSettingsChange={onSettingsChange}
      />,
    );

    expect(screen.getByLabelText("模型")).toHaveValue("gpt-test");
    expect(screen.getByLabelText("思考强度")).toHaveValue("high");
    expect(screen.getByRole("button", { name: "权限：请求批准" })).toBeVisible();

    await userEvent.selectOptions(screen.getByLabelText("模型"), "gpt-next");
    expect(onSettingsChange).toHaveBeenCalledWith({
      model: "gpt-next",
      reasoningEffort: "high",
      permission: "auto",
    });
    rerender(
      <Composer {...props} expanded model="gpt-next" reasoningEffort="high" permission="auto" />,
    );
    await userEvent.selectOptions(screen.getByLabelText("思考强度"), "low");
    expect(onSettingsChange).toHaveBeenLastCalledWith({
      model: "gpt-next",
      reasoningEffort: "low",
      permission: "auto",
    });
    rerender(
      <Composer {...props} expanded model="gpt-next" reasoningEffort="low" permission="auto" />,
    );
    await userEvent.click(screen.getByRole("button", { name: "权限：请求批准" }));
    expect(screen.getByRole("listbox", { name: "权限" })).toBeVisible();
    expect(screen.getByText("编辑外部文件和使用互联网时始终询问")).toBeVisible();
    expect(screen.getByText("仅对检测到的风险操作请求批准")).toBeVisible();
    expect(screen.getByText("可不受限制地访问互联网和你电脑上的任何文件")).toBeVisible();
    await userEvent.click(screen.getByRole("option", { name: /完全访问权限/ }));
    expect(onSettingsChange).toHaveBeenLastCalledWith({
      model: "gpt-next",
      reasoningEffort: "low",
      permission: "full-access",
    });
  });
});
