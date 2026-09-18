# Desktop bridge restart and recovery

The live bridge requires one Codex Desktop launch with Chromium DevTools bound to loopback. The signed app bundle is not modified.

## Durable checkpoint

- Repository: the local `codex-remote` checkout
- Branch: `codex/remote-parity`
- Design: `docs/superpowers/specs/2026-08-23-codex-remote-parity-design.md`
- Plan: `docs/superpowers/plans/2026-08-23-codex-remote-parity.md`
- Dry run: `scripts/launch-desktop-bridge.sh --dry-run`
- Execute directly from an independent Terminal: `BIND_HOST=<private-ip> scripts/persistent-bridge.sh --install`
- Verification output: `.runtime/desktop-bridge-evidence.json`
- Gateway log: `.runtime/gateway.log`
- Capability token: `.runtime/token`, owner-readable only

## Recovery

If this Codex conversation is interrupted by the restart:

1. Wait for Codex Desktop to reopen and restore its windows.
2. Read `.runtime/desktop-bridge-evidence.json`; `ok: true` and `transport: desktop-live` prove the renderer bridge can read Desktop's existing host.
3. Read `.runtime/gateway.log` and call `curl -fsS http://127.0.0.1:4321/health`. The gateway also listens on the configured VPN address for the phone.
4. Resume work on branch `codex/remote-parity`; do not repeat the Desktop restart if DevTools is already listening on `127.0.0.1:9229`.
5. Compare active `threadId` and `turnId` in the evidence with the restored Desktop conversation before testing a mutation.

The script never force-kills Desktop. If AppleScript cannot close it cleanly, the script exits and leaves the current process running.

## Native/mobile restart helper (v0.5.36+)

The native app and the mobile confirmation flow use `scripts/restart-codex-desktop.sh`, not the legacy persistent-bridge scripts above. Once the user confirms, this helper force-stops only the current user's exact Desktop main executable and reopens it with the loopback bridge enabled. It does not send an AppleScript quit request, so Codex's own quit confirmation cannot block remote recovery. Running work or unsaved changes may be lost. A healthy bridge check does not stop Desktop, and this is still a one-time action rather than an automatic restart loop.

## Automatic recovery

While Remote is enabled, the native app checks for a running Codex Desktop whose bridge remains unavailable. If its loopback CDP endpoint is absent for 20 seconds, it calls the same helper with `--recover <observed-pid>` once for that process. The helper rechecks the endpoint, exact executable and owner, and refuses to restart a replacement process or one already launched with a debugging-port argument. The replacement therefore cannot enter a restart loop if its port fails to open. Closing Desktop intentionally does not cause it to reopen. Automatic recovery may interrupt work in the process being restarted.

When CDP remains reachable but its renderer context is cleared or detached, the gateway discards both stale CDP connections and reinstalls its bridge through the existing reconnect path. No Desktop restart is needed in that case. The login LaunchAgents remain one-shot (`KeepAlive=false`).
