import { App as CapacitorApp } from "@capacitor/app";
import { Capacitor, CapacitorHttp } from "@capacitor/core";
import { LocalNotifications } from "@capacitor/local-notifications";
import { useEffect, useMemo, useRef, useState } from "react";
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
const CONNECTION_STATUS_TIMEOUT_MS = 8_000;
const CONNECTION_STATUS_REFRESH_MS = 15_000;

type ConnectionStatusCheck = {
  controller: AbortController;
  timeout: number;
  reject(reason: Error): void;
};

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
  const connectionOpenGeneration = useRef(0);
  const connectionStatusGeneration = useRef(0);
  const connectionStatusChecks = useRef(new Set<ConnectionStatusCheck>());
  const connectionOpenQueue = useRef<Promise<void>>(Promise.resolve());

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
    void store.list().then(async () => {
      if (disposed) return;
      const launch = await CodexRemoteNative.getLaunchTarget().catch(() => ({}));
      if ("connectionId" in launch && "threadId" in launch) {
        openTarget(launch as MobileThreadTarget);
      }
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
      connectionStatusGeneration.current += 1;
      abortConnectionStatusChecks();
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
    if (view === "connections") {
      let disposed = false;
      const refresh = () => {
        void store.list().then((values) => {
          if (!disposed) refreshConnectionStatuses(values);
        }).catch(() => undefined);
      };
      refresh();
      const timer = window.setInterval(refresh, CONNECTION_STATUS_REFRESH_MS);
      const appStateListener = CapacitorApp.addListener("appStateChange", ({ isActive }) => {
        if (isActive) refresh();
      }).catch(() => undefined);
      const visibilityListener = () => {
        if (document.visibilityState === "visible") refresh();
      };
      document.addEventListener("visibilitychange", visibilityListener);
      return () => {
        disposed = true;
        window.clearInterval(timer);
        document.removeEventListener("visibilitychange", visibilityListener);
        connectionStatusGeneration.current += 1;
        abortConnectionStatusChecks();
        void appStateListener.then((handle) => handle?.remove());
      };
    }
    if (view !== "form" && view !== "settings" && view !== "remote") return;
    const listener = CapacitorApp.addListener("backButton", () => {
      if (view === "remote") {
        const remoteView = (window.history.state as Record<string, unknown> | null)?.codexRemoteView;
        if (remoteView === "thread" || remoteView === "new") {
          window.history.back();
          return;
        }
      }
      setError(undefined);
      setEditing(undefined);
      setView("connections");
    }).catch(() => undefined);
    return () => { void listener.then((handle) => handle?.remove()); };
  }, [view]);

  async function reloadConnections() {
    refreshConnectionStatuses(await store.list());
  }

  function refreshConnectionStatuses(values: RemoteConnection[]) {
    const generation = connectionStatusGeneration.current + 1;
    connectionStatusGeneration.current = generation;
    abortConnectionStatusChecks();
    setConnections((current) => values.map((connection) => ({
      ...connection,
      connectionStatus: current.find((existing) => existing.id === connection.id)?.connectionStatus ?? "checking",
    })));
    for (const connection of values) {
      // Pairing history and live reachability are separate signals. Older app
      // versions could leave `pairingStatus=error` behind even though a valid
      // token was already stored, so credentials decide whether we can probe.
      if (connection.pairingStatus === "pending") continue;
      const controller = new AbortController();
      let rejectTimeout!: (reason: Error) => void;
      const timeoutPromise = new Promise<never>((_resolve, reject) => { rejectTimeout = reject; });
      const check: ConnectionStatusCheck = {
        controller,
        timeout: window.setTimeout(() => {
          controller.abort();
          rejectTimeout(new Error("remote-status-timeout"));
        }, CONNECTION_STATUS_TIMEOUT_MS),
        reject: rejectTimeout,
      };
      connectionStatusChecks.current.add(check);
      void Promise.race([
        store.credentials(connection.id)
          .then(({ token }) => verifyRemote(connection.baseUrl, token, controller.signal)),
        timeoutPromise,
      ])
        .then(() => setConnectionStatus(connection.id, "available", generation))
        .catch(() => setConnectionStatus(connection.id, "unavailable", generation))
        .finally(() => {
          window.clearTimeout(check.timeout);
          connectionStatusChecks.current.delete(check);
        });
    }
  }

  function abortConnectionStatusChecks() {
    for (const check of connectionStatusChecks.current) {
      window.clearTimeout(check.timeout);
      check.controller.abort();
      check.reject(new Error("remote-status-cancelled"));
    }
    connectionStatusChecks.current.clear();
  }

  function setConnectionStatus(
    connectionId: string,
    connectionStatus: NonNullable<RemoteConnection["connectionStatus"]>,
    generation: number,
  ) {
    if (generation !== connectionStatusGeneration.current) return;
    setConnections((current) => current.map((connection) => connection.id === connectionId
      ? { ...connection, connectionStatus }
      : connection));
  }

  function openConnectionId(id: string, requestedThreadId?: string) {
    const generation = connectionOpenGeneration.current + 1;
    connectionOpenGeneration.current = generation;
    const request = connectionOpenQueue.current.then(() => performOpenConnection(id, requestedThreadId, generation));
    connectionOpenQueue.current = request.catch(() => undefined);
    return request;
  }

  async function performOpenConnection(id: string, requestedThreadId: string | undefined, generation: number) {
    try {
      const { connection, token } = await store.credentials(id);
      if (generation !== connectionOpenGeneration.current) return;
      await store.select(id);
      if (generation !== connectionOpenGeneration.current) return;
      const availableConnections = await store.list();
      if (generation !== connectionOpenGeneration.current) return;
      await ensureNotificationPermission();
      if (generation !== connectionOpenGeneration.current) return;
      if (!requestedThreadId) {
        const historyState = window.history.state && typeof window.history.state === "object"
          ? window.history.state as Record<string, unknown>
          : {};
        window.history.replaceState({
          ...historyState,
          codexRemoteView: "list",
          codexRemoteThreadId: undefined,
        }, "");
      }
      setConnections(availableConnections);
      setActive({
        connectionId: id,
        name: connection.name,
        baseUrl: connection.baseUrl,
        token,
        requestedThreadId,
        language: settings.language,
        messageSendMode: settings.messageSendMode,
        connections: availableConnections.map(({ id: connectionId, name, pairingStatus }) => ({
          id: connectionId,
          name,
          pairingStatus,
        })),
        onManageConnections: () => {
          setView("connections");
        },
        onOpenConnection: (connectionId) => { void openConnectionId(connectionId); },
        onOpenExternalUrl: (url) => {
          if (!window.confirm(mobileCopy(settings.language).openExternalConfirmation(externalUrlHost(url)))) return;
          void CodexRemoteNative.openExternalUrl({ url }).catch(() => undefined);
        },
      });
      setView("remote");
      await CodexRemoteNative.startMonitoring({
        connectionId: id,
        name: connection.name,
        baseUrl: connection.baseUrl,
        token,
      }).catch(() => undefined);
    } catch (cause) {
      if (generation !== connectionOpenGeneration.current) return;
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
        currentVersion={currentVersion}
        updateStatus={updateStatus}
        onCheckUpdate={() => void checkUpdate()}
        onDownloadUpdate={(artifact) => void downloadUpdate(artifact)}
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
      updateStatus={updateStatus}
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

function externalUrlHost(url: string) {
  try {
    return new URL(url).host || url;
  } catch {
    return url;
  }
}

async function verifyRemote(baseUrl: string, token: string, signal?: AbortSignal) {
  const normalized = normalizeRemoteUrl(baseUrl);
  const url = `${normalized}/api/mobile/status`;
  if (Capacitor.isNativePlatform()) {
    const response = await CapacitorHttp.get({
      url,
      headers: { authorization: `Bearer ${token}` },
      connectTimeout: CONNECTION_STATUS_TIMEOUT_MS,
      readTimeout: CONNECTION_STATUS_TIMEOUT_MS,
    });
    if (response.status === 401) throw new Error("remote-auth-failed");
    if (response.status < 200 || response.status >= 300) throw new Error("remote-unreachable");
    return;
  }
  const response = await fetch(url, {
    headers: { authorization: `Bearer ${token}` },
    signal,
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
