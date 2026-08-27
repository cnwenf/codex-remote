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
    expect(container.querySelector(".mobile-overflow-button")).not.toBeInTheDocument();
    const actions = container.querySelector(".mobile-remote-actions") as HTMLElement;
    expect(actions).toContainElement(within(actions).getByRole("button", { name: "扫码添加" }));
  });

  it("puts the settings control on the right and keeps update details out of the header", () => {
    const { container } = render(
      <ConnectionList
        connections={[]}
        onNew={vi.fn()}
        onScan={vi.fn()}
        onOpen={vi.fn()}
        onEdit={vi.fn()}
        onRemove={vi.fn()}
        onSettings={vi.fn()}
        updateStatus={{ state: "idle" }}
      />,
    );

    const settings = screen.getByRole("button", { name: "设置" });
    const header = screen.getByRole("banner");
    expect(settings).toHaveClass("mobile-header-control");
    expect(settings).toHaveClass("mobile-header-flat-control");
    expect(header.lastElementChild).toBe(settings);
    expect(within(header).queryByText("v0.4.1")).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: "检查更新" })).not.toBeInTheDocument();
    expect(settings.querySelector('svg[data-icon="settings-sliders"]')).not.toBeNull();
    expect(container.querySelector(".mobile-settings-button > span")).not.toBeInTheDocument();
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

  it("marks settings when an update is available and preserves header download progress", () => {
    const common = {
      connections: [],
      onNew: vi.fn(),
      onScan: vi.fn(),
      onOpen: vi.fn(),
      onEdit: vi.fn(),
      onRemove: vi.fn(),
      onSettings: vi.fn(),
    };

    const { container, rerender } = render(
      <ConnectionList
        {...common}
        updateStatus={{
          state: "available",
          latestVersion: "0.4.2",
          downloadUrl: "https://example.test/app.apk",
          checksumUrl: "https://example.test/app.apk.sha256",
        }}
      />,
    );
    expect(container.querySelector(".mobile-update-available-dot")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "设置" })).toContainElement(
      container.querySelector(".mobile-update-available-dot") as HTMLElement,
    );

    rerender(<ConnectionList {...common} updateStatus={{ state: "downloading", latestVersion: "0.4.2", progress: 43 }} />);
    const progress = screen.getByRole("progressbar", { name: "正在下载 0.4.2" });
    expect(progress).toHaveAttribute("aria-valuenow", "43");
    expect(progress).toHaveClass("mobile-header-progress-ring");
    expect(progress).toHaveStyle({ "--download-progress": "154.8deg" });
    expect(screen.getByText("43%")).toBeVisible();
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
