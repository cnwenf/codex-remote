import { render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConnectionList } from "./connection-list";

describe("ConnectionList", () => {
  it("offers a first connection and opens or edits an existing connection", async () => {
    const onNew = vi.fn();
    const onOpen = vi.fn();
    const onEdit = vi.fn();
    const onScan = vi.fn();
    const connection = {
      id: "mac-one",
      name: "Office Mac",
      baseUrl: "http://192.168.1.20:4321",
      lastUsedAt: 1,
    };
    const { rerender } = render(
      <ConnectionList connections={[]} onNew={onNew} onScan={onScan} onOpen={onOpen} onEdit={onEdit} onRemove={vi.fn()} />,
    );
    await userEvent.click(screen.getAllByRole("button", { name: "扫码添加" })[0]);
    expect(onScan).toHaveBeenCalled();
    await userEvent.click(screen.getAllByRole("button", { name: "新建连接" })[1]);
    expect(onNew).toHaveBeenCalled();

    rerender(
      <ConnectionList connections={[connection]} onNew={onNew} onScan={onScan} onOpen={onOpen} onEdit={onEdit} onRemove={vi.fn()} />,
    );
    await userEvent.click(screen.getByRole("button", { name: /Office Mac/ }));
    expect(onOpen).toHaveBeenCalledWith(connection);
    await userEvent.click(screen.getByRole("button", { name: "修改" }));
    expect(onEdit).toHaveBeenCalledWith(connection);
  });
});
