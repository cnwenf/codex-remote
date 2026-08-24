# Codex Remote Native Installer and Resilience Design

## Status

Approved on 2026-08-24.

## Goals

- Install Codex Remote with one `curl | sh` command and no source checkout or package-manager setup.
- Let the installer enumerate local private IPv4 addresses, then ask the user which address to bind.
- Read the Web login password without echoing it or exposing it in arguments, URLs, logs, plists, or Git.
- Distribute an ad-hoc signed macOS ARM64 DMG with a SHA-256 sidecar.
- Provide one native AppKit application with both a Dock icon and a menu-bar status item.
- Let the application enable or disable Remote, change the bind address and login password, show its version, and install updates.
- Preserve the existing Codex Desktop bridge and require exactly one user-initiated Desktop restart after initial installation.
- Make browser connections recover from transient network changes without requiring a page refresh.
- Keep the composer compact until the user interacts with it.

## Non-goals

- Apple Developer ID signing or notarization in the first release.
- Public Internet exposure, TLS termination, VPN provisioning, or router configuration.
- Replacing Codex Desktop or rendering its Electron bundle directly in Chrome.
- Automatically replaying mutating RPC calls after a network disconnect.
- Automatically quitting or repeatedly restarting Codex Desktop during installation.

## Chosen Architecture

### Native application

`Codex Remote.app` is a single AppKit process with regular activation policy. It owns a settings window, a Dock icon, and an `NSStatusItem` menu. The application launches and supervises the bundled gateway as a child process. Closing the settings window does not terminate the application.

The app bundle contains:

- an ARM64 Swift executable;
- the production Web bundle;
- the compiled gateway runtime and production dependencies;
- a pinned ARM64 Node.js runtime;
- install, migration, launchd, and update helpers;
- an `.icns` application icon and menu-bar template image.

Application state lives outside the bundle under `~/Library/Application Support/Codex Remote`. The authentication token is stored in a separate mode-`0600` file. Logs and update downloads live under the user's Library directories and never include the token.

### Process lifecycle

An explicit per-user LaunchAgent starts `Codex Remote.app` at login. The plist has a fixed program path, `RunAtLoad=true`, and an explicit restart policy. Installation never uses `launchctl submit`.

The existing Desktop launch configuration is migrated to a Codex Remote-owned explicit LaunchAgent that starts Codex Desktop with CDP bound only to `127.0.0.1:9229`. Loading the configuration must not quit Desktop. The installer tells the user to restart Codex Desktop once; after that restart, the bridge becomes live.

Turning Remote off stops the gateway and closes its private-IP listener immediately while the native app and menu remain available. It does not quit Codex Desktop. Turning Remote on starts the gateway from persisted configuration.

### Installer

The documented installation command is:

```sh
curl -fsSL https://raw.githubusercontent.com/cnwenf/codex-remote/main/install.sh | sh
```

Because the script arrives on standard input, every interactive prompt reads from `/dev/tty`. The installer:

1. verifies macOS and ARM64;
2. enumerates non-loopback IPv4 addresses and recommends the address on the active default route;
3. asks the user to select one address;
4. reads and confirms a non-empty login password with terminal echo disabled;
5. queries the latest GitHub Release;
6. downloads the ARM64 DMG and its SHA-256 sidecar to a private temporary directory;
7. verifies the exact asset digest before mounting it;
8. installs or updates `/Applications/Codex Remote.app`;
9. writes configuration and the protected token file without placing secrets in process arguments;
10. starts the app and prints the access URL plus a reminder to restart Codex Desktop once.

Installation is idempotent. Migration removes only obsolete Codex Remote launchd labels after resolving their exact names. It never creates an inferred one-shot launchd job.

### Updates

The native app checks the repository's GitHub Releases API. The Update button downloads the matching ARM64 DMG and checksum, verifies it, then invokes a bundled updater that replaces the app after the current process exits and relaunches it. A failed download, digest check, mount, or copy leaves the installed app untouched.

### Browser connection recovery

The browser socket becomes a supervised connection rather than a single-use socket:

- unexpected close triggers exponential backoff with jitter and a bounded maximum delay;
- `online` and `visibilitychange` trigger an immediate retry;
- the gateway sends WebSocket ping frames and terminates clients that stop responding;
- reconnect authenticates with the existing HttpOnly session cookie;
- after the gateway reports `ready`, the Web app refreshes thread metadata and resumes the selected thread's tail;
- pending RPC promises fail immediately on disconnect;
- mutating requests are never replayed automatically, preventing duplicate messages or approvals;
- connection state distinguishes connecting, reconnecting, ready, and offline.

The gateway-to-Desktop recovery remains independent. A browser reconnect must work whether the Desktop transport is live, temporarily read-only, or recovering.

### Compact composer

The selected-thread composer has collapsed and expanded presentation states:

- collapsed is the default and displays one input line plus the primary send/steer action;
- focusing or tapping the composer expands the textarea, attachments, permission, model, reasoning controls, stop action, and validation messages;
- interacting with any composer child keeps it expanded;
- tapping the conversation viewport collapses it;
- a draft, queued attachments, an open picker, or an active error is never discarded when collapsed;
- changing threads preserves per-thread drafts as today;
- keyboard and screen-reader focus behavior remains usable on mobile and desktop.

## Security

- The gateway remains bound only to the user-selected private address plus loopback.
- CDP remains loopback-only.
- Password material is read from `/dev/tty`, stored mode `0600`, and passed to the gateway through a protected file/environment only inside the supervised child process.
- Release downloads are HTTPS and digest-verified before execution or mounting.
- Update and install paths reject unexpected asset names, architectures, mount contents, symlinks, and traversal.
- Logs redact authentication values and configuration views never display the saved password in clear text.
- The installer avoids broad deletes and operates only on resolved temporary, application, configuration, and known LaunchAgent paths.

## Verification

- Unit tests cover socket retry timing, immediate online recovery, no mutation replay, heartbeat cleanup, composer focus/collapse behavior, and draft preservation.
- Script tests cover IPv4 filtering, `/dev/tty` prompting, hidden password handling, checksum mismatch, idempotent installation, and explicit launchd definitions.
- Swift build checks verify ARM64 binaries, app metadata, Dock/menu-bar assets, configuration validation, child-process lifecycle, and update state transitions.
- Packaging smoke tests build, ad-hoc sign, verify with `codesign`, create and mount the DMG, verify SHA-256, inspect the copied bundle, and launch it against a temporary configuration.
- Browser E2E deliberately closes a live WebSocket and confirms automatic reconnection and selected-thread recovery without a page reload.
- Final acceptance includes a secrets/privacy scan, full unit/build/E2E runs, and a stable-process observation that confirms no repeated Desktop restart loop.
