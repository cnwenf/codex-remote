import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { useEffect, useState } from "react";
import { CodexRemoteNative, type NotificationStatus } from "./native-bridge";
import type { MobileLanguage } from "./settings-store";

export function NotificationHealthPanel({ language, compact = false }: { language: MobileLanguage; compact?: boolean }) {
  const [status, setStatus] = useState<NotificationStatus>();
  const [actionError, setActionError] = useState(false);
  const [busy, setBusy] = useState(false);
  const android = Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
  useEffect(() => {
    if (!android) return;
    let disposed = false;
    const refresh = async () => {
      try {
        const next = await CodexRemoteNative.getNotificationStatus();
        if (!disposed) { setStatus(next); setActionError(false); }
      } catch { if (!disposed) setActionError(true); }
    };
    void refresh();
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 15_000);
    const listener = CapacitorApp.addListener("appStateChange", ({ isActive }) => { if (isActive) void refresh(); });
    return () => {
      disposed = true;
      window.clearInterval(timer);
      void listener.then((handle) => handle.remove()).catch(() => undefined);
    };
  }, [android]);
  if (!android || (!status && !actionError)) return null;
  const en = language === "en";
  const disabled = status && (!status.enabled || !status.runningEnabled || !status.completedEnabled);
  const failed = status?.state === "error" || status?.state === "stopped";
  if (compact && !disabled && !failed && !actionError) return null;
  const messages = {
    idle: en ? "Open a connection to start background monitoring." : "打开连接后启用后台监控。",
    starting: en ? "Checking background monitoring…" : "正在检查后台监控…",
    healthy: en ? "Background monitoring is working." : "后台监控正常。",
    stopped: en ? "Background monitoring stopped; completion alerts are unavailable." : "后台监控已停止，无法接收完成提醒。",
    error: status?.error === "unauthorized"
      ? (en ? "Background authentication failed. Check the connection password." : "后台监控鉴权失败，请检查连接密码。")
      : (en ? "Background monitoring failed. Check the connection and retry." : "后台监控异常，请检查连接后重试。"),
  };
  const permissionMessage = !status?.enabled
    ? (en ? "Notifications are off; running and completion alerts cannot be shown." : "通知未开启，无法显示运行状态和完成提醒。")
    : !status.runningEnabled
      ? (en ? "Running task notifications are off." : "运行状态通知已关闭。")
      : (en ? "Completion alerts are off." : "完成提醒已关闭。");
  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setActionError(false);
    try { await action(); setStatus(await CodexRemoteNative.getNotificationStatus()); }
    catch { setActionError(true); }
    finally { setBusy(false); }
  }
  return (
    <aside className="mobile-notification-health" role="status">
      {!compact ? <h2>{en ? "Task notifications" : "任务通知"}</h2> : null}
      <p>{disabled ? permissionMessage : status ? messages[status.state] : ""}</p>
      {disabled && failed ? <p>{messages[status.state]}</p> : null}
      {actionError ? <p>{en ? "Unable to check or configure notifications. Try again." : "通知状态读取或设置失败，请重试。"}</p> : null}
      <div>
        {disabled || !compact ? <button type="button" className="secondary-button" disabled={busy} onClick={() => void perform(() => CodexRemoteNative.openNotificationSettings(
          !status?.enabled ? {} : !status.runningEnabled ? { channel: "running" } : !status.completedEnabled ? { channel: "completed" } : {},
        ))}>{disabled ? (en ? "Enable notifications" : "开启通知") : (en ? "Notification settings" : "通知设置")}</button> : null}
        {failed ? <button type="button" className="secondary-button" disabled={busy} onClick={() => void perform(() => CodexRemoteNative.retryMonitoring())}>{en ? "Retry monitoring" : "重试监控"}</button> : null}
      </div>
      {!compact ? <small>{en ? "Lock screen visibility and sounds follow Android settings. Only the last opened connection is monitored." : "锁屏显示和声音遵循 Android 系统设置；后台监控最近打开的连接。"}</small> : null}
    </aside>
  );
}
