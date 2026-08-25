import type { RemoteConnection } from "./types";
import type { MobileUpdateStatus } from "./app-update";

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
  onDownloadUpdate?(url: string): void;
}) {
  return (
    <main className="mobile-connections">
      <header className="mobile-remote-header">
        <span className="mobile-header-spacer" aria-hidden="true" />
        <h1>Remote</h1>
        <button type="button" className="mobile-overflow-button" onClick={onNew} aria-label="新建连接">
          <span aria-hidden="true">•••</span>
        </button>
      </header>
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
                  <span><strong>{connection.name}</strong><small>{connection.baseUrl}</small></span>
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
        {currentVersion && updateStatus && onCheckUpdate && onDownloadUpdate ? (
          <section className="mobile-update-card" aria-label="客户端更新">
            <div>
              <strong>版本 {currentVersion}</strong>
              <small>{updateMessage(updateStatus)}</small>
            </div>
            {updateStatus.state === "available" ? (
              <button type="button" onClick={() => onDownloadUpdate(updateStatus.downloadUrl)}>
                下载 {updateStatus.latestVersion}
              </button>
            ) : (
              <button type="button" disabled={updateStatus.state === "checking"} onClick={onCheckUpdate}>
                {updateStatus.state === "checking" ? "检查中…" : "检查更新"}
              </button>
            )}
          </section>
        ) : null}
      </section>
    </main>
  );
}

function updateMessage(status: MobileUpdateStatus) {
  if (status.state === "current") return "已是最新版本";
  if (status.state === "available") return `发现新版本 ${status.latestVersion}`;
  if (status.state === "error") return status.message;
  return "从 GitHub Releases 获取更新";
}
