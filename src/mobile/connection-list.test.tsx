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

  it("uses balanced header controls and a line-based settings symbol", () => {
    const { container } = render(
      <ConnectionList
        connections={[]}
        onNew={vi.fn()}
        onScan={vi.fn()}
        onOpen={vi.fn()}
        onEdit={vi.fn()}
        onRemove={vi.fn()}
        onSettings={vi.fn()}
        currentVersion="0.4.1"
        updateStatus={{ state: "idle" }}
        onCheckUpdate={vi.fn()}
        onDownloadUpdate={vi.fn()}
      />,
    );

    const settings = screen.getByRole("button", { name: "设置" });
    const update = screen.getByRole("button", { name: "检查更新" });
    expect(settings).toHaveClass("mobile-header-control");
    expect(update).toHaveClass("mobile-header-control");
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
    const header = screen.getByRole("banner");
    expect(within(header).getByText("v0.4.1")).toBeVisible();
    expect(screen.queryByLabelText("客户端更新")).not.toBeInTheDocument();
    await userEvent.click(screen.getByRole("button", { name: "检查更新" }));
    expect(onCheckUpdate).toHaveBeenCalledOnce();

    rerender(
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
    await userEvent.click(screen.getByRole("button", { name: "下载 0.4.2" }));
    expect(onDownloadUpdate).toHaveBeenCalledWith({
      latestVersion: "0.4.2",
      downloadUrl: "https://example.test/app.apk",
      checksumUrl: "https://example.test/app.apk.sha256",
    });

    rerender(<ConnectionList {...common} updateStatus={{ state: "downloading", latestVersion: "0.4.2", progress: 43 }} />);
    const progress = screen.getByRole("progressbar", { name: "正在下载 0.4.2" });
    expect(progress).toHaveAttribute("aria-valuenow", "43");
    expect(progress).toHaveClass("mobile-header-progress-ring");
    expect(progress).toHaveStyle({ "--download-progress": "154.8deg" });
    expect(screen.getByText("43%")).toBeVisible();

    rerender(<ConnectionList {...common} updateStatus={{ state: "installing", latestVersion: "0.4.2" }} />);
    expect(screen.getByRole("status", { name: /准备安装/ })).toHaveClass("is-complete");
    expect(screen.getByText("✓")).toBeVisible();

    rerender(<ConnectionList {...common} updateStatus={{ state: "current" }} />);
    expect(screen.getByText("已是最新版本")).toBeVisible();

    rerender(<ConnectionList {...common} updateStatus={{ state: "error", message: "安装包校验失败" }} />);
    expect(screen.getByRole("status")).toHaveTextContent("安装包校验失败");
    expect(screen.getByRole("button", { name: "重试更新" })).toHaveTextContent("!");
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
