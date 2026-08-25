import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConnectionForm } from "./connection-form";

describe("ConnectionForm", () => {
  it("submits a new private connection and does not render the password as text", async () => {
    const onSave = vi.fn(async () => undefined);
    render(<ConnectionForm onSave={onSave} onCancel={vi.fn()} />);
    await userEvent.type(screen.getByLabelText("名称"), "My Mac");
    await userEvent.type(screen.getByLabelText("Remote 地址"), "http://192.168.1.20:4321");
    const password = screen.getByLabelText("登录密码");
    expect(password).toHaveAttribute("type", "password");
    await userEvent.type(password, "a-private-password");
    await userEvent.click(screen.getByRole("button", { name: "保存并连接" }));

    expect(onSave).toHaveBeenCalledWith({
      id: undefined,
      name: "My Mac",
      baseUrl: "http://192.168.1.20:4321",
      token: "a-private-password",
    });
  });

  it("returns to the connection list after a deliberate left-edge swipe", () => {
    const onCancel = vi.fn();
    const { container } = render(<ConnectionForm onSave={vi.fn(async () => undefined)} onCancel={onCancel} />);
    const form = container.querySelector("form") as HTMLFormElement;

    fireEvent.touchStart(form, { touches: [{ clientX: 12, clientY: 240 }] });
    fireEvent.touchEnd(form, { changedTouches: [{ clientX: 118, clientY: 250 }] });

    expect(onCancel).toHaveBeenCalledOnce();
  });
});
