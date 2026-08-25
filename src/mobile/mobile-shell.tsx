import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";
import { useEffect, useMemo, useState } from "react";
import packageInfo from "../../package.json";
import { App, type NativeRemoteSession } from "../web/app";
import { CapacitorConnectionPersistence } from "./capacitor-persistence";
import { ConnectionForm } from "./connection-form";
import { ConnectionList } from "./connection-list";
import { ConnectionStore, normalizeRemoteUrl } from "./connection-store";
import { parseMobileDeepLink, type MobileThreadTarget } from "./deep-link";
import { CodexRemoteNative } from "./native-bridge";
import { beginScannedPairing } from "./pair-connection";
import type { RemoteConnection, RemoteConnectionInput } from "./types";
import { findMobileUpdate, type MobilePlatform, type MobileUpdateStatus } from "./app-update";

type MobileView = "connections" | "form" | "remote";

export function MobileShell({ storeOverride }: { storeOverride?: ConnectionStore } = {}) {
  const store = useMemo(
    () => storeOverride ?? new ConnectionStore(new CapacitorConnectionPersistence()),
    [storeOverride],
  );
  const [connections, setConnections] = useState<RemoteConnection[]>([]);
  const [active, setActive] = useState<NativeRemoteSession>();
  const [editing, setEditing] = useState<RemoteConnection>();
  const [view, setView] = useState<MobileView>("connections");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [pendingTarget, setPendingTarget] = useState<MobileThreadTarget>();
  const [currentVersion, setCurrentVersion] = useState(packageInfo.version);
  const [updateStatus, setUpdateStatus] = useState<MobileUpdateStatus>({ state: "idle" });

  useEffect(() => {
    let disposed = false;
    const openTarget = (target: MobileThreadTarget) => {
      setPendingTarget(target);
      void openConnectionId(target.connectionId, target.threadId);
    };
    void store.list().then(async (values) => {
      if (disposed) return;
      setConnections(values);
      const launch = await CodexRemoteNative.getLaunchTarget().catch(() => ({}));
      if ("connectionId" in launch && "threadId" in launch) {
        openTarget(launch as MobileThreadTarget);
        return;
      }
      const selected = await store.getSelected();
      if (selected) await openConnectionId(selected.id);
    });
    const nativeListener = CodexRemoteNative.addListener("openThread", openTarget).catch(() => undefined);
    const urlListener = CapacitorApp.addListener("appUrlOpen", ({ url }) => {
      const target = parseMobileDeepLink(url);
      if (target) openTarget(target);
    }).catch(() => undefined);
    const notificationListener = LocalNotifications.addListener(
      "localNotificationActionPerformed",
      ({ notification }) => {
        const extra = notification.extra as Record<string, unknown> | undefined;
        const target = typeof extra?.connectionId === "string" && typeof extra.threadId === "string"
          ? { connectionId: extra.connectionId, threadId: extra.threadId }
          : typeof extra?.link === "string" ? parseMobileDeepLink(extra.link) : undefined;
        if (target) openTarget(target);
      },
    ).catch(() => undefined);
    void CapacitorApp.getLaunchUrl().then((launch) => {
      const target = launch?.url ? parseMobileDeepLink(launch.url) : undefined;
      if (target) openTarget(target);
    });
    return () => {
      disposed = true;
      void nativeListener.then((listener) => listener?.remove());
      void urlListener.then((listener) => listener?.remove());
      void notificationListener.then((listener) => listener?.remove());
    };
  }, [store]);

  useEffect(() => {
    void CapacitorApp.getInfo().then((info) => setCurrentVersion(info.version)).catch(() => undefined);
  }, []);

  async function reloadConnections() {
    setConnections(await store.list());
  }

  async function openConnectionId(id: string, requestedThreadId?: string) {
    try {
      const { connection, token } = await store.credentials(id);
      await store.select(id);
      setActive({
        connectionId: id,
        name: connection.name,
        baseUrl: connection.baseUrl,
        token,
        requestedThreadId,
        onManageConnections: () => setView("connections"),
      });
      setView("remote");
      await ensureNotificationPermission();
      await CodexRemoteNative.startMonitoring({
        connectionId: id,
        name: connection.name,
        baseUrl: connection.baseUrl,
        token,
      }).catch(() => undefined);
    } catch (cause) {
      setError(messageForError(cause));
      setView("connections");
    }
  }

  async function save(input: RemoteConnectionInput) {
    setBusy(true);
    setError(undefined);
    try {
      const token = input.token || (input.id ? (await store.credentials(input.id)).token : undefined);
      if (!token) throw new Error("remote-token-required");
      await verifyRemote(input.baseUrl, token);
      const connection = await store.save(input);
      await reloadConnections();
      setEditing(undefined);
      await openConnectionId(connection.id, pendingTarget?.connectionId === connection.id
        ? pendingTarget.threadId
        : undefined);
    } catch (cause) {
      setError(messageForError(cause));
    } finally {
      setBusy(false);
    }
  }

  async function remove(connection: RemoteConnection) {
    if (!window.confirm(`删除连接“${connection.name}”？`)) return;
    await CodexRemoteNative.stopMonitoring({ connectionId: connection.id }).catch(() => undefined);
    await store.remove(connection.id);
    await reloadConnections();
  }

  async function scanConnection() {
    setBusy(true);
    setError(undefined);
    try {
      const { value } = await CodexRemoteNative.scanConnection();
      const pairing = await beginScannedPairing(value, store, reloadConnections);
      void pairing.completion;
      setView("connections");
    } catch (cause) {
      setError(messageForError(cause));
      setView("connections");
    } finally {
      setBusy(false);
    }
  }

  async function checkUpdate() {
    const platform = Capacitor.getPlatform();
    if (platform !== "android" && platform !== "ios") return;
    setUpdateStatus({ state: "checking" });
    try {
      setUpdateStatus(await findMobileUpdate(currentVersion, platform as MobilePlatform));
    } catch {
      setUpdateStatus({ state: "error", message: "检查失败，请稍后重试" });
    }
  }

  async function downloadUpdate(url: string) {
    try {
      await CodexRemoteNative.openExternalUrl({ url });
    } catch {
      setUpdateStatus({ state: "error", message: "无法打开下载页面" });
    }
  }

  if (view === "remote" && active) {
    return <App key={`${active.connectionId}:${active.requestedThreadId ?? ""}`} remote={active} />;
  }
  if (view === "form") {
    return (
      <main className="mobile-connection-editor">
        <ConnectionForm
          connection={editing}
          busy={busy}
          error={error}
          onSave={save}
          onCancel={() => { setError(undefined); setEditing(undefined); setView("connections"); }}
        />
      </main>
    );
  }
  return (
    <ConnectionList
      connections={connections}
      onScan={() => void scanConnection()}
      onOpen={(connection) => void openConnectionId(connection.id)}
      onNew={() => { setEditing(undefined); setError(undefined); setView("form"); }}
      onEdit={(connection) => { setEditing(connection); setError(undefined); setView("form"); }}
      onRemove={(connection) => void remove(connection)}
      currentVersion={currentVersion}
      updateStatus={updateStatus}
      onCheckUpdate={() => void checkUpdate()}
      onDownloadUpdate={(url) => void downloadUpdate(url)}
    />
  );
}

async function ensureNotificationPermission() {
  try {
    const current = await LocalNotifications.checkPermissions();
    if (current.display !== "granted") await LocalNotifications.requestPermissions();
  } catch {
    // The remote remains usable when notifications are unavailable or denied.
  }
}

async function verifyRemote(baseUrl: string, token: string) {
  const normalized = normalizeRemoteUrl(baseUrl);
  const response = await fetch(`${normalized}/api/mobile/status`, {
    headers: { authorization: `Bearer ${token}` },
  });
  if (response.status === 401) throw new Error("remote-auth-failed");
  if (!response.ok) throw new Error("remote-unreachable");
}

function messageForError(cause: unknown) {
  const value = cause instanceof Error ? cause.message : "remote-save-failed";
  if (value === "remote-auth-failed") return "登录密码不正确";
  if (value === "remote-unreachable" || value === "Failed to fetch") return "无法访问这个 Remote 地址";
  if (value === "remote-url-insecure-public-host") return "HTTP 只允许本地、VPN IP 或 .local 地址";
  if (value === "remote-token-required") return "请输入登录密码";
  if (value === "remote-token-not-found") return "连接尚未配对，请重新扫码";
  if (value.startsWith("pairing-")) return "二维码已失效或无法完成配对，请在 Mac 上重新生成";
  if (value.startsWith("remote-url-")) return "Remote 地址格式不正确";
  return value;
}
