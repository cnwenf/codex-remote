import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { useCallback, useEffect, useRef, useState } from "react";
import { CodexRemoteNative, type NotificationStatus } from "./native-bridge";
import type { MobileLanguage } from "./settings-store";

// Settings-only: notification checks never control the conversation's connection indicator.
export function NotificationHealthPanel({ language }: { language: MobileLanguage }) {
  const [status, setStatus] = useState<NotificationStatus>();
  const [actionError, setActionError] = useState(false);
  const [busy, setBusy] = useState(false);
  const [now, setNow] = useState(Date.now);
  const requestId = useRef(0);
  const mounted = useRef(false);
  const android = Capacitor.isNativePlatform() && Capacitor.getPlatform() === "android";
  const refresh = useCallback(async () => {
    if (!mounted.current) return;
    setNow(Date.now());
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
  const lastSuccessAt = status?.lastSuccessAt ?? 0;
  const stale = lastSuccessAt > 0 && now - lastSuccessAt >= 60_000;
  const messages = {
    idle: en ? "Open a connection to enable task notifications." : "打开连接后启用任务通知。",
    starting: en ? "Checking task notifications…" : "正在重新检查任务通知…",
    healthy: stale
      ? (en ? "Task notification status is out of date." : "任务通知状态已过期。")
      : (en ? "Task notifications are working." : "任务通知正常。"),
    stopped: en ? "Task notification checks stopped; completion alerts may be delayed." : "任务通知检查已停止，完成提醒可能延迟。",
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
      <h2>{en ? "Task notifications" : "任务通知"}</h2>
      {status?.connectionName ? <p>{en ? "Connection: " : "对应连接："}{status.connectionName}</p> : null}
      <p>{disabled ? permissionMessage : status ? messages[status.state] : ""}</p>
      {disabled && failed ? <p>{messages[status.state]}</p> : null}
      {status?.state === "starting" && status.error ? <p>{en ? "Previous check: " : "上次检查："}{monitoringError(status.error, en)}</p> : null}
      {(status?.consecutiveFailures ?? 0) > 0 ? <p>{en ? "Consecutive failed checks: " : "连续检查失败："}{status!.consecutiveFailures}</p> : null}
      <p>{en ? "Last successful check: " : "最近成功检查："}{lastSuccessAt > 0
        ? <time dateTime={new Date(lastSuccessAt).toISOString()}>{relativeCheckTime(lastSuccessAt, now, en)}</time>
        : (en ? "Not yet confirmed" : "尚未成功检查")}</p>
      {actionError ? <p>{en ? "Unable to check or configure notifications. Try again." : "通知状态读取或设置失败，请重试。"}</p> : null}
      <div>
        <button type="button" className="secondary-button" disabled={busy} onClick={() => void perform(() => CodexRemoteNative.openNotificationSettings(
          !status?.enabled ? {} : !status.runningEnabled ? { channel: "running" } : !status.completedEnabled ? { channel: "completed" } : {},
        ))}>{disabled ? (en ? "Enable notifications" : "开启通知") : (en ? "Notification settings" : "通知设置")}</button>
        {status?.connectionId ? <button type="button" className="secondary-button" disabled={busy} onClick={() => void perform(() => CodexRemoteNative.retryMonitoring())}>{en ? "Check again" : "重新检查"}</button> : null}
      </div>
      <small>{en ? "This checks task notifications, not the chat connection. Only the last opened connection is checked. Lock screen visibility and sounds follow Android settings." : "此处只检查任务通知，不代表对话连接状态。仅检查最近打开的连接；锁屏显示和声音遵循 Android 系统设置。"}</small>
    </aside>
  );
}

function relativeCheckTime(timestamp: number, now: number, en: boolean) {
  const minutes = Math.max(0, Math.floor((now - timestamp) / 60_000));
  if (minutes === 0) return en ? "Just now" : "刚刚";
  return en ? `${minutes} min ago` : `${minutes} 分钟前`;
}

function monitoringError(code: string | undefined, en: boolean): string {
  const messages: Record<string, string> = {
    unauthorized: en ? "Task notification authentication failed. Check the connection password." : "任务通知鉴权失败，请检查连接密码。",
    "bridge-unavailable": en ? "The Mac gateway is reachable, but Codex Desktop is disconnected. Retrying automatically." : "已连上 Mac 网关，但 Mac 上的 Codex Desktop 暂未连接，正在自动重试。",
    timeout: en ? "The task status request timed out. Checking again automatically." : "任务状态请求超时，将自动重新检查。",
    dns: en ? "The notification check cannot resolve the connection address. Check the private network connection." : "任务通知的连接地址无法解析，请检查私网连接。",
    tls: en ? "The notification check could not establish a secure connection. Check the gateway certificate." : "任务通知安全连接失败，请检查网关证书。",
    "invalid-status": en ? "The gateway returned invalid status data. Retrying automatically." : "网关返回的状态数据无效，正在自动重试。",
    "start-failed": en ? "Task notification checks could not start. Reopen the connection and retry." : "任务通知检查启动失败，请重新打开连接后重试。",
  };
  if (code && /^http-\d{3}$/.test(code)) {
    return en ? `The status endpoint returned HTTP ${code.slice(5)}. Retrying automatically.` : `任务状态接口返回 HTTP ${code.slice(5)}，将自动重新检查。`;
  }
  return messages[code ?? ""] ?? (en ? "Task notification checks cannot reach the gateway. Messaging uses a separate connection." : "任务通知检查暂时无法连接网关；对话使用独立连接。");
}
