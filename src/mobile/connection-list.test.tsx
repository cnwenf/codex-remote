import { render, screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { ConnectionList } from "./connection-list";

describe("ConnectionList", () => {
  it("uses the native-style Remote connection header", () => {
    const { container } = render(
      <ConnectionList connections={[]} onNew={vi.fn()} onScan={vi.fn()} onOpen={vi.fn()} onEdit={vi.fn()} onRemove={vi.fn()} />,
    );

    expect(screen.getByRole("heading", { name: "Remote" })).toBeVisible();
    expect(container.querySelector(".mobile-remote-header")).toBeInTheDocument();
    const actions = container.querySelector(".mobile-remote-actions") as HTMLElement;
    expect(actions).toContainElement(within(actions).getByRole("button", { name: "扫码添加" }));
  });

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

  it("shows the installed version and exposes mobile update actions", async () => {
    const onCheckUpdate = vi.fn();
    const onDownloadUpdate = vi.fn();
    const common = {
      connections: [],
      onNew: vi.fn(),
      onScan: vi.fn(),
      onOpen: vi.fn(),
      onEdit: vi.fn(),
      onRemove: vi.fn(),
      currentVersion: "0.4.1",
      onCheckUpdate,
      onDownloadUpdate,
    };

    const { rerender } = render(<ConnectionList {...common} updateStatus={{ state: "idle" }} />);
    expect(screen.getByText("版本 0.4.1")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "检查更新" }));
    expect(onCheckUpdate).toHaveBeenCalledOnce();

    rerender(
      <ConnectionList
        {...common}
        updateStatus={{ state: "available", latestVersion: "0.4.2", downloadUrl: "https://example.test/app.apk" }}
      />,
    );
    await userEvent.click(screen.getByRole("button", { name: "下载 0.4.2" }));
    expect(onDownloadUpdate).toHaveBeenCalledWith("https://example.test/app.apk");
  });

  it("shows pairing progress and failure in the connection list", () => {
    render(
      <ConnectionList
        connections={[
          {
            id: "pairing",
            name: "Pairing Mac",
            baseUrl: "http://192.168.1.20:4321",
            lastUsedAt: 2,
            pairingStatus: "pending",
          },
          {
            id: "offline",
            name: "Offline Mac",
            baseUrl: "http://192.168.1.21:4321",
            lastUsedAt: 1,
            pairingStatus: "error",
          },
        ]}
        onNew={vi.fn()}
        onScan={vi.fn()}
        onOpen={vi.fn()}
        onEdit={vi.fn()}
        onRemove={vi.fn()}
      />,
    );

    expect(screen.getByText("正在配对…")).toBeVisible();
    expect(screen.getByText("连接不可用，请重新扫码")).toBeVisible();
  });
});
