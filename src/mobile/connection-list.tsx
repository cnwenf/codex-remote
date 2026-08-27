import type { RemoteConnection } from "./types";
import type { MobileUpdateStatus } from "./app-update";
import { mobileCopy } from "./mobile-copy";
import type { MobileLanguage } from "./settings-store";

export function ConnectionList({
  connections,
  onOpen,
  onNew,
  onScan,
  onEdit,
  onRemove,
  updateStatus,
  onSettings,
  language = "zh-CN",
}: {
  connections: RemoteConnection[];
  onOpen(connection: RemoteConnection): void;
  onNew(): void;
  onScan(): void;
  onEdit(connection: RemoteConnection): void;
  onRemove(connection: RemoteConnection): void;
  updateStatus?: MobileUpdateStatus;
  onSettings?(): void;
  language?: MobileLanguage;
}) {
  const copy = mobileCopy(language);
  return (
    <main className="mobile-connections">
      <header className="mobile-remote-header">
        <span className="mobile-header-spacer" aria-hidden="true" />
        <h1>Remote</h1>
        {updateStatus?.state === "downloading" ? (
            <div
              className="mobile-header-control mobile-header-update mobile-header-progress-ring"
              role="progressbar"
              aria-label={copy.downloadingVersion(updateStatus.latestVersion)}
              aria-valuemin={0}
              aria-valuemax={100}
              aria-valuenow={updateStatus.progress}
              style={{ "--download-progress": `${updateStatus.progress * 3.6}deg` } as React.CSSProperties}
            >
              <span className="mobile-header-control-label">{updateStatus.progress}%</span>
            </div>
          ) : updateStatus?.state === "installing" ? (
            <div
              className="mobile-header-control mobile-header-update is-complete"
              role="status"
              aria-label={copy.preparingInstall}
              aria-live="polite"
            >
              <span className="mobile-header-complete" aria-hidden="true">✓</span>
            </div>
          ) : onSettings ? (
            <button type="button" className="mobile-header-control mobile-header-flat-control mobile-settings-button" aria-label={copy.settings} onClick={onSettings}>
              <svg data-icon="settings-sliders" aria-hidden="true" viewBox="0 0 24 24">
                <path d="M4 7h10M18 7h2M4 17h2M10 17h10M14 4v6M7 14v6" />
                <circle cx="14" cy="7" r="2" />
                <circle cx="7" cy="17" r="2" />
              </svg>
              {updateStatus?.state === "available" ? <span className="mobile-update-available-dot" aria-hidden="true" /> : null}
            </button>
          ) : <span className="mobile-header-spacer" aria-hidden="true" />
        }
      </header>
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
                  <span className="connection-device">
                    <span className="device-icon" aria-hidden="true" />
                    <ConnectionStatusDot connection={connection} language={language} />
                  </span>
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

function ConnectionStatusDot({ connection, language = "zh-CN" }: { connection: RemoteConnection; language?: MobileLanguage }) {
  const copy = mobileCopy(language);
  const status = connection.connectionStatus ?? (
    connection.pairingStatus === "error" ? "unavailable" : "checking"
  );
  const label = status === "available"
    ? copy.connectionAvailable
    : status === "unavailable"
      ? copy.connectionUnavailable
      : copy.connectionChecking;
  return (
    <span
      className={`connection-reachability connection-status-${status}`}
      role="img"
      aria-label={label}
    />
  );
}

function ConnectionPairingStatus({ status, language = "zh-CN" }: { status: RemoteConnection["pairingStatus"]; language?: MobileLanguage }) {
  const copy = mobileCopy(language);
  if (status === "pending") return <small className="connection-pairing-status pairing">{copy.pairing}</small>;
  if (status === "error") return <small className="connection-pairing-status error">{copy.unavailable}</small>;
  return null;
}
