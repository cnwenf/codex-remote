import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { CodexRemoteNative, type NotificationStatus } from "./native-bridge";
import type { MobileLanguage } from "./settings-store";

export function NotificationHealthPanel({ language, compact = false }: { language: MobileLanguage; compact?: boolean }) {
  const [status, setStatus] = useState<NotificationStatus>();
  const [actionError, setActionError] = useState(false);
  const [busy, setBusy] = useState(false);
  const requestId = useRef(0);
  const mounted = useRef(false);
  const android = Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
  const refresh = useCallback(async () => {
    if (!mounted.current) return;
    const id = ++requestId.current;
    try {
      const next = await CodexRemoteNative.getNotificationStatus();
      if (id === requestId.current) { setStatus(next); setActionError(false); }
    } catch { if (id === requestId.current) setActionError(true); }
  }, []);
  useEffect(() => {
    if (!android) return;
    mounted.current = true;
    void refresh();
    const timer = window.setInterval(() => { if (!document.hidden) void refresh(); }, 15_000);
    const listener = CapacitorApp.addListener("appStateChange", ({ isActive }) => { if (isActive) void refresh(); });
    return () => {
      mounted.current = false;
      requestId.current++;
      window.clearInterval(timer);
      void listener.then((handle) => handle.remove()).catch(() => undefined);
    };
  }, [android, refresh]);
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
    error: monitoringError(status?.error, en),
  };
  const permissionMessage = !status?.enabled
    ? (en ? "Notifications are off; running and completion alerts cannot be shown." : "通知未开启，无法显示运行状态和完成提醒。")
    : !status.runningEnabled
      ? (en ? "Running task notifications are off." : "运行状态通知已关闭。")
      : (en ? "Completion alerts are off." : "完成提醒已关闭。");
  async function perform(action: () => Promise<void>) {
    setBusy(true);
    setActionError(false);
    requestId.current++; // A pre-action refresh cannot restore an error after a successful retry.
    try { await action(); await refresh(); }
    catch { if (mounted.current) setActionError(true); }
    finally { if (mounted.current) setBusy(false); }
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

function monitoringError(code: string | undefined, en: boolean): string {
  const messages: Record<string, string> = {
    unauthorized: en ? "Background authentication failed. Check the connection password." : "后台监控鉴权失败，请检查连接密码。",
    "bridge-unavailable": en ? "The Mac gateway is reachable, but Codex Desktop is disconnected. Retrying automatically." : "已连上 Mac 网关，但 Mac 上的 Codex Desktop 暂未连接，正在自动重试。",
    timeout: en ? "The background status request timed out. Retrying automatically." : "后台状态请求超时，正在自动重试。",
    dns: en ? "The background monitor cannot resolve the connection address. Check the private network connection." : "后台监控的连接地址无法解析，请检查私网连接。",
    tls: en ? "The background monitor could not establish a secure connection. Check the gateway certificate." : "后台监控安全连接失败，请检查网关证书。",
    "invalid-status": en ? "The gateway returned invalid status data. Retrying automatically." : "网关返回的状态数据无效，正在自动重试。",
    "start-failed": en ? "Background monitoring could not start. Reopen the connection and retry." : "后台监控启动失败，请重新打开连接后重试。",
  };
  if (code && /^http-\d{3}$/.test(code)) {
    return en ? `The status endpoint returned HTTP ${code.slice(5)}. Retrying automatically.` : `后台状态接口返回 HTTP ${code.slice(5)}，正在自动重试。`;
  }
  return messages[code ?? ""] ?? (en ? "Background monitoring cannot reach the gateway. Retrying automatically; messaging uses a separate connection." : "后台监控暂时无法连接网关，正在自动重试；这与消息连接是独立的。");
}
