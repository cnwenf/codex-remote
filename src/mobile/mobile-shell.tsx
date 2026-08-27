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
import { SettingsPage } from "./settings-page";
import {
  applyMobileSettings,
  CapacitorMobileSettingsPersistence,
  DEFAULT_MOBILE_SETTINGS,
  type MobileSettings,
  MobileSettingsStore,
} from "./settings-store";
import {
  findMobileUpdate,
  type MobilePlatform,
  type MobileUpdateArtifact,
  type MobileUpdateStatus,
} from "./app-update";
import { mobileCopy } from "./mobile-copy";

type MobileView = "connections" | "form" | "remote" | "settings";

export function MobileShell({
  storeOverride,
  settingsStoreOverride,
}: {
  storeOverride?: ConnectionStore;
  settingsStoreOverride?: MobileSettingsStore;
} = {}) {
  const store = useMemo(
    () => storeOverride ?? new ConnectionStore(new CapacitorConnectionPersistence()),
    [storeOverride],
  );
  const settingsStore = useMemo(
    () => settingsStoreOverride ?? new MobileSettingsStore(new CapacitorMobileSettingsPersistence()),
    [settingsStoreOverride],
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
  const [settings, setSettings] = useState<MobileSettings>(DEFAULT_MOBILE_SETTINGS);

  useEffect(() => {
    let disposed = false;
    void settingsStore.read().then((value) => {
      if (disposed) return;
      setSettings(value);
      applyMobileSettings(value);
    });
    return () => { disposed = true; };
  }, [settingsStore]);

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

  useEffect(() => {
    void checkUpdate();
  }, [currentVersion]);

  useEffect(() => {
    const listener = CodexRemoteNative.addListener("updateDownloadProgress", (event) => {
      setUpdateStatus((current) => {
        const latestVersion = "latestVersion" in current ? current.latestVersion : "";
        if (event.state === "downloading") {
          return { state: "downloading", latestVersion, progress: Math.max(0, Math.min(100, event.progress ?? 0)) };
        }
        if (event.state === "installing") return { state: "installing", latestVersion };
        return { state: "error", message: event.message || mobileCopy(settings.language).downloadFailed };
      });
    }).catch(() => undefined);
    return () => { void listener.then((handle) => handle?.remove()); };
  }, [settings.language]);

  useEffect(() => {
    if (view !== "form" && view !== "settings") return;
    const listener = CapacitorApp.addListener("backButton", () => {
      setError(undefined);
      setEditing(undefined);
      setView("connections");
    }).catch(() => undefined);
    return () => { void listener.then((handle) => handle?.remove()); };
  }, [view]);

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
        language: settings.language,
        messageSendMode: settings.messageSendMode,
        onManageConnections: () => setView("connections"),
        onOpenExternalUrl: (url) => {
          void CodexRemoteNative.openExternalUrl({ url }).catch(() => undefined);
        },
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
      setError(messageForError(cause, settings.language));
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
      setError(messageForError(cause, settings.language));
    } finally {
      setBusy(false);
    }
  }

  async function remove(connection: RemoteConnection) {
    if (!window.confirm(mobileCopy(settings.language).deleteConfirmation(connection.name))) return;
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
      setError(messageForError(cause, settings.language));
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
      setUpdateStatus({ state: "error", message: mobileCopy(settings.language).checkFailed });
    }
  }

  async function downloadUpdate(artifact: MobileUpdateArtifact) {
    if (Capacitor.getPlatform() !== "android") {
      try {
        await CodexRemoteNative.openExternalUrl({ url: artifact.downloadUrl });
      } catch {
        setUpdateStatus({ state: "error", message: mobileCopy(settings.language).openDownloadFailed });
      }
      return;
    }
    setUpdateStatus({ state: "downloading", latestVersion: artifact.latestVersion, progress: 0 });
    try {
      await CodexRemoteNative.downloadAndInstallUpdate({
        url: artifact.downloadUrl,
        checksumUrl: artifact.checksumUrl || "",
        version: artifact.latestVersion,
      });
    } catch {
      setUpdateStatus((current) => current.state === "error"
        ? current
        : { state: "error", message: mobileCopy(settings.language).downloadFailed });
    }
  }

  async function updateSettings(next: MobileSettings) {
    const saved = await settingsStore.write(next);
    setSettings(saved);
    applyMobileSettings(saved);
    setActive((current) => current ? {
      ...current,
      language: saved.language,
      messageSendMode: saved.messageSendMode,
    } : current);
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
          language={settings.language}
          onCancel={() => { setError(undefined); setEditing(undefined); setView("connections"); }}
        />
      </main>
    );
  }
  if (view === "settings") {
    return (
      <SettingsPage
        settings={settings}
        onChange={(next) => void updateSettings(next)}
        onBack={() => setView("connections")}
      />
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
      onSettings={() => setView("settings")}
      language={settings.language}
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

function messageForError(cause: unknown, language: MobileSettings["language"] = "zh-CN") {
  const copy = mobileCopy(language);
  const value = cause instanceof Error ? cause.message : "remote-save-failed";
  if (value === "remote-auth-failed") return copy.loginIncorrect;
  if (value === "remote-unreachable" || value === "Failed to fetch") return copy.addressUnavailable;
  if (value === "remote-url-insecure-public-host") return copy.insecureAddress;
  if (value === "remote-token-required") return copy.passwordRequired;
  if (value === "remote-token-not-found") return copy.pairingRequired;
  if (value.startsWith("pairing-")) return copy.pairingFailed;
  if (value.startsWith("remote-url-")) return copy.invalidAddress;
  return value;
}
