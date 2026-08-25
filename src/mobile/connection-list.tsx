import type { RemoteConnection } from "./types";
import type { MobileUpdateArtifact, MobileUpdateStatus } from "./app-update";

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
}) {
  return (
    <main className="mobile-connections">
      <header className="mobile-remote-header">
        <span className="mobile-header-spacer" aria-hidden="true" />
        <h1>Remote</h1>
        {currentVersion && updateStatus && onCheckUpdate && onDownloadUpdate ? (
          updateStatus.state === "available" ? (
            <button
              type="button"
              className="mobile-header-update"
              aria-label={`下载 ${updateStatus.latestVersion}`}
              onClick={() => onDownloadUpdate({
                latestVersion: updateStatus.latestVersion,
                downloadUrl: updateStatus.downloadUrl,
                checksumUrl: updateStatus.checksumUrl,
              })}
            >
              <small>v{currentVersion}</small>
              <strong>下载 {updateStatus.latestVersion}</strong>
            </button>
          ) : updateStatus.state === "downloading" ? (
            <div
              className="mobile-header-update mobile-header-download-progress"
              role="progressbar"
              aria-label={`正在下载 ${updateStatus.latestVersion}`}
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
              <strong>准备安装…</strong>
            </div>
          ) : (
            <button
              type="button"
              className="mobile-header-update"
              aria-label={updateStatus.state === "checking" ? "检查中" : "检查更新"}
              disabled={updateStatus.state === "checking"}
              onClick={onCheckUpdate}
            >
              <small>v{currentVersion}</small>
              <strong>{updateStatus.state === "checking"
                ? "检查中…"
                : updateStatus.state === "error" ? "重试更新" : "检查更新"}</strong>
            </button>
          )
        ) : <span className="mobile-header-spacer" aria-hidden="true" />}
      </header>
      {updateStatus?.state === "current" ? (
        <p className="mobile-update-feedback" role="status">已是最新版本</p>
      ) : updateStatus?.state === "error" ? (
        <p className="mobile-update-feedback mobile-update-error" role="status">{updateStatus.message}</p>
      ) : null}
      <div className="mobile-remote-actions" aria-label="连接操作">
        <button type="button" className="connection-scan-button" onClick={onScan}>
          <span className="scan-icon" aria-hidden="true" />扫码添加
        </button>
        <button type="button" className="connection-new-button" onClick={onNew} aria-label="新建连接">
          <span className="compose-icon" aria-hidden="true" />新建连接
        </button>
      </div>
      <section className="connection-list-stage">
        <p className="eyebrow">设备</p>
        <h2>选择一台 Mac</h2>
        {connections.length === 0 ? (
          <div className="connection-empty">
            <strong>还没有连接</strong>
            <p>添加 Mac 的本地私网地址和 Codex Remote 登录密码。</p>
            <button type="button" className="primary-button" onClick={onNew}>新建连接</button>
            <button type="button" className="secondary-button" onClick={onScan}>扫码添加</button>
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
                    <ConnectionPairingStatus status={connection.pairingStatus} />
                  </span>
                  <span aria-hidden="true">›</span>
                </button>
                <div className="connection-row-actions">
                  <button type="button" onClick={() => onEdit(connection)}>修改</button>
                  <button type="button" onClick={() => onRemove(connection)}>删除</button>
                </div>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}

function ConnectionPairingStatus({ status }: { status: RemoteConnection["pairingStatus"] }) {
  if (status === "pending") return <small className="connection-pairing-status pairing">正在配对…</small>;
  if (status === "error") return <small className="connection-pairing-status error">连接不可用，请重新扫码</small>;
  return null;
}
