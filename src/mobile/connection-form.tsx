import { useState, type FormEvent } from "react";
import type { RemoteConnection, RemoteConnectionInput } from "./types";

export function ConnectionForm({
  connection,
  busy,
  error,
  onSave,
  onCancel,
}: {
  connection?: RemoteConnection;
  busy?: boolean;
  error?: string;
  onSave(input: RemoteConnectionInput): Promise<void>;
  onCancel(): void;
}) {
  const [name, setName] = useState(connection?.name ?? "");
  const [baseUrl, setBaseUrl] = useState(connection?.baseUrl ?? "");
  const [token, setToken] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    await onSave({ id: connection?.id, name, baseUrl, token: token || undefined });
  }

  return (
    <form className="mobile-connection-form" onSubmit={(event) => void submit(event)}>
      <header>
        <p className="eyebrow">CODEX REMOTE</p>
        <h2>{connection ? "修改连接" : "新建连接"}</h2>
      </header>
      <label>
        名称
        <input value={name} onChange={(event) => setName(event.target.value)} placeholder="我的 Mac" required />
      </label>
      <label>
        Remote 地址
        <input
          value={baseUrl}
          onChange={(event) => setBaseUrl(event.target.value)}
          placeholder="http://192.168.1.10:4321"
          inputMode="url"
          autoCapitalize="none"
          required
        />
      </label>
      <label>
        登录密码
        <input
          value={token}
          onChange={(event) => setToken(event.target.value)}
          placeholder={connection ? "留空则保持原密码" : "输入 Web 登录密码"}
          type="password"
          autoComplete="new-password"
          required={!connection}
        />
      </label>
      {error ? <p className="connection-form-error" role="alert">{error}</p> : null}
      <div className="connection-form-actions">
        <button type="button" className="secondary-button" onClick={onCancel}>取消</button>
        <button type="submit" className="primary-button" disabled={busy}>{busy ? "验证中…" : "保存并连接"}</button>
      </div>
    </form>
  );
}
