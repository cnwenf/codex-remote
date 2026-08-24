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

## Android and iPhone clients

Download the mobile artifacts from [GitHub Releases](https://github.com/cnwenf/codex-remote/releases):

- `Codex-Remote-android-arm64.apk` is an installable ARM64 Android build. Allow notifications on first launch.
- `Codex-Remote-iOS-Simulator.zip` is an unsigned iPhone Simulator build for development and verification.
- `Codex-Remote-iOS-unsigned.ipa` is a compiled ARM64 device build, but it must be re-signed with your own Apple Developer Team before installation. The repository never includes certificates or provisioning profiles.

The native clients reuse the Web conversation UI. Tap **New connection**, then enter a name, the Mac private-network URL (for example `http://192.168.1.20:4321`), and the Web password. You can save, open, edit, and delete multiple connections. Passwords are stored in Android Keystore or iOS Keychain instead of ordinary preferences.

Android displays a low-priority foreground notification listing running tasks and sends a completion or failure notification; tapping it opens that connection and task. iOS refreshes and notifies when the operating system grants background execution time. iOS does not guarantee polling intervals; production-grade immediate lock-screen notifications require connecting `CodexRemoteNativePlugin` to APNs.

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

Codex Remote appears in both the Dock and macOS menu bar. Clicking its Dock icon opens the current Remote Web page. The menu-bar app can enable or disable Remote, change the bind address and Web password, open the Web UI, show status and version, and check GitHub for updates.

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

Mobile clients only allow plain HTTP for numeric IP addresses, `localhost`, and `.local` hosts. The password is sent in the `Authorization` header and never placed in the URL.
