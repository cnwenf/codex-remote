[简体中文](README.md) | [English](README_EN.md)

# Codex Remote

View and control Codex Desktop on your Mac from a phone or another computer. Projects, tasks, status, Todo lists, approvals, models, permissions, images, and live output come from the local Codex installation.

## Requirements

- Apple Silicon Mac (ARM64), macOS 13 or later.
- Codex Desktop installed and signed in at `/Applications/ChatGPT.app`.
- A trusted private network through which your phone or computer can reach the Mac.
- Never expose Codex Remote to the public Internet.

## One-line installation

Run in Terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/cnwenf/codex-remote/main/install.sh | sh
```

The installer lists usable non-loopback IPv4 addresses for you to select, securely prompts for the Web password, downloads the latest ARM64 DMG, verifies its SHA-256 checksum, installs the app, and configures login startup. It never uses a temporary `launchctl submit` job.

When installation finishes, quit and reopen Codex Desktop once. This enables its loopback-only endpoint at `127.0.0.1:9229`; the port is never exposed to the phone.

Open the URL printed by the installer, for example `http://192.168.1.20:4321`, and enter your password. The login cookie lasts 30 days and multiple browsers may connect simultaneously.

## Install through a Codex conversation

Copy this prompt into Codex:

```text
Install Codex Remote on my Apple Silicon Mac.

GitHub repository: git@github.com:cnwenf/codex-remote.git

1. Read the repository README first. List every non-loopback IPv4 address with its interface and ask me which address to use. Never guess and never use 127.0.0.1 for remote access.
2. Ask me for the Web login password. Never put it in a URL, log, Git, LaunchAgent plist, or command-line argument.
3. Follow the README curl | sh flow exactly and answer its interactive prompts with my selections.
4. Verify the DMG SHA-256, ad-hoc signature, ARM64 architecture, login startup configuration, and local health endpoint.
5. Tell me to quit and reopen Codex Desktop exactly once. Do not repeatedly restart Desktop.
6. Report the complete access URL, my chosen password, and whether every verification passed. Clearly report failures.
```

## App controls

Codex Remote appears in both the Dock and macOS menu bar. It can enable or disable Remote, change the bind address and Web password, open the Web UI, show status and version, and check GitHub for updates.

The password is stored at `~/Library/Application Support/Codex Remote/token` with mode `0600`; its directory uses mode `0700`.

## Login startup

The installer creates two explicit user LaunchAgents:

- `local.codex-remote.app` starts and keeps the native app running.
- `local.codex-remote.desktop` starts Desktop with `--remote-debugging-address=127.0.0.1 --remote-debugging-port=9229`.

```bash
launchctl print "gui/$(id -u)/local.codex-remote.app"
launchctl print "gui/$(id -u)/local.codex-remote.desktop"
curl -fsS http://127.0.0.1:4321/health
```

## Security

The current DMG uses ad-hoc signing, so macOS may ask for confirmation on first launch. Installation proceeds only after checksum verification. Keep ports `4321` and `9229` off the public Internet; `9229` must remain loopback-only.
