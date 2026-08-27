import { fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { describe, expect, it, vi } from "vitest";
import { SettingsPage } from "./settings-page";
import type { MobileSettings } from "./settings-store";

describe("SettingsPage", () => {
  const settings: MobileSettings = {
    theme: "system",
    language: "zh-CN",
    messageSendMode: "queue",
  };

  it("shows all mobile preferences and saves each selection immediately", async () => {
    const onChange = vi.fn();
    render(<SettingsPage settings={settings} onChange={onChange} onBack={vi.fn()} />);

    expect(screen.getByRole("heading", { name: "设置" })).toBeVisible();
    expect(screen.getByRole("radiogroup", { name: "外观" })).toBeVisible();
    expect(screen.getByRole("radiogroup", { name: "语言" })).toBeVisible();
    expect(screen.getByRole("radiogroup", { name: "新消息发送方式" })).toBeVisible();

    await userEvent.click(screen.getByRole("radio", { name: /暗色/ }));
    expect(onChange).toHaveBeenCalledWith({ ...settings, theme: "dark" });
    await userEvent.click(screen.getByRole("radio", { name: /English/ }));
    expect(onChange).toHaveBeenCalledWith({ ...settings, language: "en" });
    await userEvent.click(screen.getByRole("radio", { name: /引导/ }));
    expect(onChange).toHaveBeenCalledWith({ ...settings, messageSendMode: "steer" });
  });

  it("supports a deliberate left-edge swipe back", () => {
    const onBack = vi.fn();
    const { container } = render(<SettingsPage settings={settings} onChange={vi.fn()} onBack={onBack} />);
    const page = container.querySelector(".mobile-settings") as HTMLElement;

    fireEvent.touchStart(page, { touches: [{ clientX: 10, clientY: 200 }] });
    fireEvent.touchEnd(page, { changedTouches: [{ clientX: 112, clientY: 205 }] });

    expect(onBack).toHaveBeenCalledOnce();
  });

  it("renders English copy when English is selected", () => {
    render(
      <SettingsPage
        settings={{ ...settings, language: "en" }}
        onChange={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    expect(screen.getByRole("heading", { name: "Settings" })).toBeVisible();
    expect(screen.getByRole("radiogroup", { name: "Appearance" })).toBeVisible();
    expect(screen.getByText("Queue until the current turn finishes")).toBeVisible();
  });

  it("shows the installed version and owns the update action", async () => {
    const onCheckUpdate = vi.fn();
    const onDownloadUpdate = vi.fn();
    const confirm = vi.spyOn(window, "confirm").mockReturnValueOnce(true);
    render(
      <SettingsPage
        settings={settings}
        currentVersion="0.5.11"
        updateStatus={{ state: "available", latestVersion: "0.5.12", downloadUrl: "https://example.test/app.apk" }}
        onCheckUpdate={onCheckUpdate}
        onDownloadUpdate={onDownloadUpdate}
        onChange={vi.fn()}
        onBack={vi.fn()}
      />,
    );

    expect(screen.getByText("当前版本")).toBeVisible();
    expect(screen.getByText("v0.5.11")).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "检查更新" }));
    expect(onCheckUpdate).toHaveBeenCalledOnce();
    await userEvent.click(screen.getByRole("button", { name: "下载 0.5.12" }));
    expect(confirm).toHaveBeenCalledWith("发现新版本 0.5.12，是否下载并更新？");
    expect(onDownloadUpdate).toHaveBeenCalledWith({
      latestVersion: "0.5.12",
      downloadUrl: "https://example.test/app.apk",
      checksumUrl: undefined,
    });
  });
});
