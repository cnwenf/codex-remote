import { useState, type FormEvent } from "react";

export function TokenDialog({
  onConnect,
  busy,
  error,
}: {
  onConnect: (token: string) => Promise<void>;
  busy: boolean;
  error?: string;
}) {
  const [token, setToken] = useState("");

  async function submit(event: FormEvent) {
    event.preventDefault();
    if (!token || busy) return;
    await onConnect(token);
  }

  return (
    <section className="connect-panel" aria-labelledby="connect-heading">
      <div className="connect-mark" aria-hidden="true">C</div>
      <p className="eyebrow">Private connection</p>
      <h2 id="connect-heading">Control this Mac from your phone</h2>
      <p className="connect-copy">
        Enter the access token from the Mac. A private browser session will keep you signed in.
      </p>
      <form onSubmit={submit}>
        <label htmlFor="access-token">Access token</label>
        <input
          id="access-token"
          type="password"
          value={token}
          onChange={(event) => setToken(event.target.value)}
          autoComplete="off"
          autoCapitalize="none"
          spellCheck={false}
          placeholder="Paste token"
        />
        <button className="primary-button" type="submit" disabled={!token || busy}>
          {busy ? "Connecting…" : "Connect"}
        </button>
      </form>
      {error ? <p className="inline-error" role="alert">{error}</p> : null}
      <p className="privacy-note">VPN transport is managed outside this app.</p>
    </section>
  );
}
