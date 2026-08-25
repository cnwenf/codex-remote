import { useRef, useState, type FormEvent, type TouchEvent } from "react";
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
  const swipeOrigin = useRef<{ x: number; y: number } | null>(null);

  async function submit(event: FormEvent) {
    event.preventDefault();
    await onSave({ id: connection?.id, name, baseUrl, token: token || undefined });
  }

  function beginSwipe(event: TouchEvent) {
    const touch = event.touches[0];
    swipeOrigin.current = touch && touch.clientX <= 40
      ? { x: touch.clientX, y: touch.clientY }
      : null;
  }

  function finishSwipe(event: TouchEvent) {
    const origin = swipeOrigin.current;
    swipeOrigin.current = null;
    const touch = event.changedTouches[0];
    if (!origin || !touch) return;
    const horizontal = touch.clientX - origin.x;
    const vertical = Math.abs(touch.clientY - origin.y);
    if (horizontal >= 72 && vertical <= Math.max(48, horizontal * 0.5)) onCancel();
  }

  return (
    <form
      className="mobile-connection-form"
      onSubmit={(event) => void submit(event)}
      onTouchStart={beginSwipe}
      onTouchEnd={finishSwipe}
    >
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
