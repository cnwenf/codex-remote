import type { RemoteConnection } from "./types";
import type { MobileUpdateArtifact, MobileUpdateStatus } from "./app-update";
import { mobileCopy } from "./mobile-copy";
import type { MobileLanguage } from "./settings-store";

export function ConnectionList({
  connections,
  onOpen,
  onNew,
  onScan,
  onEdit,
  onRemove,
  currentVersion,
  updateStatus,
  onCheckUpdate,
  onDownloadUpdate,
  onSettings,
  language = "zh-CN",
}: {
  connections: RemoteConnection[];
  onOpen(connection: RemoteConnection): void;
  onNew(): void;
  onScan(): void;
  onEdit(connection: RemoteConnection): void;
  onRemove(connection: RemoteConnection): void;
  currentVersion?: string;
  updateStatus?: MobileUpdateStatus;
  onCheckUpdate?(): void;
  onDownloadUpdate?(artifact: MobileUpdateArtifact): void;
  onSettings?(): void;
  language?: MobileLanguage;
}) {
  const copy = mobileCopy(language);
  return (
    <main className="mobile-connections">
      <header className="mobile-remote-header">
        {onSettings ? (
          <button type="button" className="mobile-settings-button" aria-label={copy.settings} onClick={onSettings}>
            <span aria-hidden="true" />
          </button>
        ) : <span className="mobile-header-spacer" aria-hidden="true" />}
        <h1>Remote</h1>
        {currentVersion && updateStatus && onCheckUpdate && onDownloadUpdate ? (
          updateStatus.state === "available" ? (
            <button
              type="button"
              className="mobile-header-update"
              aria-label={copy.downloadVersion(updateStatus.latestVersion)}
              onClick={() => onDownloadUpdate({
                latestVersion: updateStatus.latestVersion,
                downloadUrl: updateStatus.downloadUrl,
                checksumUrl: updateStatus.checksumUrl,
              })}
            >
              <small>v{currentVersion}</small>
              <strong>{copy.downloadVersion(updateStatus.latestVersion)}</strong>
            </button>
          ) : updateStatus.state === "downloading" ? (
            <div
              className="mobile-header-update mobile-header-download-progress"
              role="progressbar"
              aria-label={copy.downloadingVersion(updateStatus.latestVersion)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={updateStatus.progress}
            >
              <small>v{updateStatus.latestVersion}</small>
              <strong>{updateStatus.progress}%</strong>
              <span style={{ "--download-progress": `${updateStatus.progress}%` } as React.CSSProperties} />
            </div>
          ) : updateStatus.state === "installing" ? (
            <div className="mobile-header-update" aria-live="polite">
              <small>v{updateStatus.latestVersion}</small>
              <strong>{copy.preparingInstall}</strong>
            </div>
          ) : (
            <button
              type="button"
              className="mobile-header-update"
              aria-label={updateStatus.state === "checking" ? copy.checking : copy.checkUpdate}
              disabled={updateStatus.state === "checking"}
              onClick={onCheckUpdate}
            >
              <small>v{currentVersion}</small>
              <strong>{updateStatus.state === "checking"
                ? copy.checking
                : updateStatus.state === "error" ? copy.retryUpdate : copy.checkUpdate}</strong>
            </button>
          )
        ) : <span className="mobile-header-spacer" aria-hidden="true" />}
      </header>
      {updateStatus?.state === "current" ? (
        <p className="mobile-update-feedback" role="status">{copy.latestVersion}</p>
      ) : updateStatus?.state === "error" ? (
        <p className="mobile-update-feedback mobile-update-error" role="status">{updateStatus.message}</p>
      ) : null}
      <div className="mobile-remote-actions" aria-label={copy.connectionActions}>
        <button type="button" className="connection-scan-button" onClick={onScan}>
          <span className="scan-icon" aria-hidden="true" />{copy.scanAdd}
        </button>
        <button type="button" className="connection-new-button" onClick={onNew} aria-label={copy.newConnection}>
          <span className="compose-icon" aria-hidden="true" />{copy.newConnection}
        </button>
      </div>
      <section className="connection-list-stage">
        <p className="eyebrow">{copy.devices}</p>
        <h2>{copy.chooseMac}</h2>
        {connections.length === 0 ? (
          <div className="connection-empty">
            <strong>{copy.noConnections}</strong>
            <p>{copy.noConnectionsDescription}</p>
            <button type="button" className="primary-button" onClick={onNew}>{copy.newConnection}</button>
            <button type="button" className="secondary-button" onClick={onScan}>{copy.scanAdd}</button>
          </div>
        ) : (
          <ul className="connection-list">
            {connections.map((connection) => (
              <li key={connection.id}>
                <button type="button" className="connection-open" onClick={() => onOpen(connection)}>
                  <span className="device-icon" aria-hidden="true" />
                  <span>
                    <strong>{connection.name}</strong>
                    <small>{connection.baseUrl}</small>
                    <ConnectionPairingStatus status={connection.pairingStatus} language={language} />
                  </span>
                  <span aria-hidden="true">›</span>
                </button>
                <div className="connection-row-actions">
                  <button type="button" onClick={() => onEdit(connection)}>{copy.edit}</button>
                  <button type="button" onClick={() => onRemove(connection)}>{copy.remove}</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function ConnectionPairingStatus({ status, language = "zh-CN" }: { status: RemoteConnection["pairingStatus"]; language?: MobileLanguage }) {
  const copy = mobileCopy(language);
  if (status === "pending") return <small className="connection-pairing-status pairing">{copy.pairing}</small>;
  if (status === "error") return <small className="connection-pairing-status error">{copy.unavailable}</small>;
  return null;
}
