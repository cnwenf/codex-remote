import type { RemoteConnection } from "./types";

export function ConnectionList({
  connections,
  onOpen,
  onNew,
  onEdit,
  onRemove,
}: {
  connections: RemoteConnection[];
  onOpen(connection: RemoteConnection): void;
  onNew(): void;
  onEdit(connection: RemoteConnection): void;
  onRemove(connection: RemoteConnection): void;
}) {
  return (
    <main className="mobile-connections">
      <header className="topbar">
        <div className="brand-lockup">
          <span className="brand-glyph" aria-hidden="true">C</span>
          <h1>Codex Remote</h1>
        </div>
        <button type="button" className="connection-new-button" onClick={onNew} aria-label="新建连接">+</button>
      </header>
      <section className="connection-list-stage">
        <p className="eyebrow">REMOTES</p>
        <h2>选择一台 Mac</h2>
        {connections.length === 0 ? (
          <div className="connection-empty">
            <strong>还没有连接</strong>
            <p>添加 Mac 的本地私网地址和 Codex Remote 登录密码。</p>
            <button type="button" className="primary-button" onClick={onNew}>新建连接</button>
          </div>
        ) : (
          <ul className="connection-list">
            {connections.map((connection) => (
              <li key={connection.id}>
                <button type="button" className="connection-open" onClick={() => onOpen(connection)}>
                  <span className="connection-icon" aria-hidden="true">C</span>
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
      </section>
    </main>
  );
}
