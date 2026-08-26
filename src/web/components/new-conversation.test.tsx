import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { NewConversation } from "./new-conversation";

describe("NewConversation", () => {
  it("renders the creation flow in English", () => {
    render(
      <NewConversation
        projects={[]}
        models={[]}
        permissions={[]}
        catalogLoading
        onCreate={vi.fn()}
        onCancel={vi.fn()}
        language="en"
      />,
    );

    expect(screen.getByRole("heading", { name: "New conversation" })).toBeVisible();
    expect(screen.getByLabelText("Project")).toBeVisible();
    expect(screen.getByText("Loading models and permissions from this Mac…")).toBeVisible();
  });

  it("submits the selected project permission model and supported reasoning effort", async () => {
    const onCreate = vi.fn();
    const onProjectChange = vi.fn();
    render(
      <NewConversation
        projects={[{ cwd: "/code/rdsai", name: "rdsai" }]}
        models={[{
          id: "gpt-test",
          displayName: "GPT Test",
          defaultReasoningEffort: "medium",
          reasoningEfforts: ["low", "medium", "high"],
        }]}
        permissions={[
          { id: ":read-only", label: "只读" },
          { id: ":danger-full-access", label: "完全访问" },
        ]}
        onCreate={onCreate}
        onProjectChange={onProjectChange}
        onCancel={vi.fn()}
      />,
    );

    await userEvent.selectOptions(screen.getByLabelText("项目"), "/code/rdsai");
    expect(onProjectChange).toHaveBeenCalledWith("/code/rdsai");
    await userEvent.selectOptions(screen.getByLabelText("权限"), ":danger-full-access");
    await userEvent.selectOptions(screen.getByLabelText("模型"), "gpt-test");
    await userEvent.selectOptions(screen.getByLabelText("思考强度"), "high");
    await userEvent.click(screen.getByRole("button", { name: "创建对话" }));

    expect(onCreate).toHaveBeenCalledWith({
      cwd: "/code/rdsai",
      permission: ":danger-full-access",
      model: "gpt-test",
      reasoningEffort: "high",
    });
  });

  it("shows catalog failures and lets the user retry", async () => {
    const onRetry = vi.fn();
    render(
      <NewConversation
        projects={[]}
        models={[]}
        permissions={[]}
        catalogError="catalog unavailable"
        onRetry={onRetry}
        onProjectChange={vi.fn()}
        onCreate={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole("alert")).toHaveTextContent("catalog unavailable");
    await userEvent.click(screen.getByRole("button", { name: "重试读取" }));
    expect(onRetry).toHaveBeenCalledOnce();
  });

  it("cannot create with stale choices while the selected project catalog failed", () => {
    render(
      <NewConversation
        projects={[{ cwd: "/code/next", name: "next" }]}
        models={[{
          id: "gpt-test",
          displayName: "GPT Test",
          defaultReasoningEffort: "medium",
          reasoningEfforts: ["medium"],
        }]}
        permissions={[{ id: ":workspace", label: "工作区写入" }]}
        catalogError="catalog unavailable"
        onRetry={vi.fn()}
        onCreate={vi.fn()}
        onCancel={vi.fn()}
      />,
    );

    expect(screen.getByRole("button", { name: "创建对话" })).toBeDisabled();
  });
});
