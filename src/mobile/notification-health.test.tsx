import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

const native = vi.hoisted(() => ({
  getNotificationStatus: vi.fn(),
  openNotificationSettings: vi.fn(async () => undefined),
  retryMonitoring: vi.fn(async () => undefined),
  onResume: undefined as undefined | ((state: { isActive: boolean }) => void),
}));
vi.mock("@capacitor/core", () => ({
  Capacitor: { getPlatform: () => "android", isNativePlatform: () => true },
  registerPlugin: () => native,
}));
vi.mock("@capacitor/app", () => ({ App: { addListener: async (_: string, listener: typeof native.onResume) => {
  native.onResume = listener;
  return { remove: async () => undefined };
} } }));
import { NotificationHealthPanel } from "./notification-health";

const healthy = { enabled: true, runningEnabled: true, completedEnabled: true, state: "healthy" };
afterEach(() => { vi.clearAllMocks(); });

describe("Android notification health", () => {
  it("clears a transient status read error after a successful resume refresh", async () => {
    native.getNotificationStatus.mockRejectedValueOnce(new Error("temporary"));
    render(<NotificationHealthPanel language="zh-CN" compact />);
    expect(await screen.findByText(/通知状态读取或设置失败/)).toBeVisible();
    native.getNotificationStatus.mockResolvedValue(healthy);
    act(() => native.onResume?.({ isActive: true }));
    await waitFor(() => expect(screen.queryByText(/通知状态读取或设置失败/)).not.toBeInTheDocument());
  });
  it("explains denied notifications, opens settings, and refreshes when returning", async () => {
    native.getNotificationStatus.mockResolvedValue({ ...healthy, enabled: false });
    render(<NotificationHealthPanel language="zh-CN" compact />);
    expect(await screen.findByText(/通知未开启/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "开启通知" }));
    expect(native.openNotificationSettings).toHaveBeenCalledWith({});
    native.getNotificationStatus.mockResolvedValue(healthy);
    act(() => native.onResume?.({ isActive: true }));
    await waitFor(() => expect(screen.queryByText(/通知未开启/)).not.toBeInTheDocument());
  });

  it("identifies a disabled completion channel independently of the app permission", async () => {
    native.getNotificationStatus.mockResolvedValue({ ...healthy, completedEnabled: false });
    render(<NotificationHealthPanel language="zh-CN" />);
    expect(await screen.findByText(/完成提醒已关闭/)).toBeVisible();
    await userEvent.click(screen.getByRole("button", { name: "开启通知" }));
    expect(native.openNotificationSettings).toHaveBeenCalledWith({ channel: "completed" });
  });

  it("shows monitoring failure and lets the user retry without presenting a healthy connection", async () => {
    native.getNotificationStatus.mockResolvedValue({ ...healthy, state: "error", error: "unauthorized" });
    render(<NotificationHealthPanel language="zh-CN" />);
    expect(await screen.findByText(/后台监控鉴权失败/)).toBeVisible();
    native.getNotificationStatus.mockResolvedValue(healthy);
    await userEvent.click(screen.getByRole("button", { name: "重试监控" }));
    expect(await screen.findByText(/后台监控正常/)).toBeVisible();
  });

  it("ignores an older failed refresh after retry has confirmed recovery", async () => {
    const failure = { ...healthy, state: "error", error: "timeout" };
    native.getNotificationStatus.mockResolvedValueOnce(failure);
    render(<NotificationHealthPanel language="zh-CN" compact />);
    await screen.findByRole("button", { name: "重试监控" });
    let resolveOld!: (value: typeof failure) => void;
    native.getNotificationStatus.mockImplementationOnce(() => new Promise((resolve) => { resolveOld = resolve; }));
    act(() => native.onResume?.({ isActive: true }));
    native.getNotificationStatus.mockResolvedValue(healthy);
    await userEvent.click(screen.getByRole("button", { name: "重试监控" }));
    await waitFor(() => expect(screen.queryByRole("status")).not.toBeInTheDocument());
    await act(async () => resolveOld(failure));
    expect(screen.queryByRole("status")).not.toBeInTheDocument();
  });

  it.each([
    ["bridge-unavailable", /Mac 上的 Codex Desktop/],
    ["timeout", /状态请求超时/],
    ["dns", /地址无法解析/],
    ["tls", /安全连接失败/],
    ["http-503", /HTTP 503/],
    ["invalid-status", /状态数据无效/],
  ])("explains %s without suggesting every failure is the connection password", async (error, message) => {
    native.getNotificationStatus.mockResolvedValue({ ...healthy, state: "error", error });
    render(<NotificationHealthPanel language="zh-CN" compact />);
    expect(await screen.findByText(message)).toBeVisible();
    expect(screen.queryByText(/后台监控正常/)).not.toBeInTheDocument();
  });
});
