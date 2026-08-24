import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { Composer } from "./composer";

describe("Composer", () => {
  it("sends composer text and clears only after success", async () => {
    const onSend = vi.fn().mockResolvedValue(undefined);
    render(<Composer onSend={onSend} running={false} />);

    const input = screen.getByRole("textbox", { name: "Instruction" });
    await userEvent.type(input, "Run the tests");
    await userEvent.click(screen.getByRole("button", { name: "Send" }));

    expect(onSend).toHaveBeenCalledWith("Run the tests");
    expect(input).toHaveValue("");
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

  it("offers stop and steer while a task is running", () => {
    render(<Composer onSend={vi.fn()} running onStop={vi.fn()} />);

    expect(screen.getByRole("button", { name: "Steer" })).toBeVisible();
    expect(screen.getByRole("button", { name: "Stop" })).toBeVisible();
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
      <Composer {...props} model="gpt-next" reasoningEffort="high" permission="auto" />,
    );
    await userEvent.selectOptions(screen.getByLabelText("思考强度"), "low");
    expect(onSettingsChange).toHaveBeenLastCalledWith({
      model: "gpt-next",
      reasoningEffort: "low",
      permission: "auto",
    });
    rerender(
      <Composer {...props} model="gpt-next" reasoningEffort="low" permission="auto" />,
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
