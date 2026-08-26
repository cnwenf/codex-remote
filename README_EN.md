[简体中文](README.md) | [English](README_EN.md)

# Codex Remote

View and control Codex Desktop on your Mac from a phone or another computer. Projects, tasks, status, Todo lists, approvals, models, permissions, images, and live output come from the local Codex installation.

## Requirements

- Apple Silicon (ARM64) or Intel (x86_64) Mac, macOS 13 or later.
- Codex Desktop installed and signed in at `/Applications/ChatGPT.app`.
- Private mode requires a trusted local network. An experimental public HTTPS mode is also available.

## One-line installation

Run in Terminal:

```bash
curl -fsSL https://raw.githubusercontent.com/cnwenf/codex-remote/main/install.sh | sh
```

The installer detects `arm64` or `x86_64`, downloads the matching DMG, and verifies its SHA-256 checksum. It asks whether to use a private network or public HTTPS, securely prompts for the Web password, installs the app, and configures login startup. Private mode offers local IPv4 addresses; public mode requires neither a public IP nor port forwarding.

When installation finishes, quit and reopen Codex Desktop once. This enables its loopback-only endpoint at `127.0.0.1:9229`; the port is never exposed to the phone.

Private mode prints a URL such as `http://192.168.1.20:4321`. Public mode starts a Cloudflare Quick Tunnel and displays a random `https://…trycloudflare.com` URL and pairing QR in the menu-bar app. The login cookie lasts 30 days and multiple browsers may connect simultaneously.

## Android and iPhone clients

Download the mobile artifacts from [GitHub Releases](https://github.com/cnwenf/codex-remote/releases):

- `Codex-Remote-android-arm64.apk` is an installable ARM64 Android build. Allow notifications on first launch.
- `Codex-Remote-iOS-Simulator.zip` is an unsigned iPhone Simulator build for development and verification.
- `Codex-Remote-iOS-unsigned.ipa` is a compiled ARM64 device build, but it must be re-signed with your own Apple Developer Team before installation. The repository never includes certificates or provisioning profiles.

The native clients reuse the Web conversation UI. Tap **Scan QR** to scan the Mac app's five-minute, single-use pairing code; it does not contain the long-term password. You can also tap **New connection** and enter a private or HTTPS URL manually. You can save, open, edit, and delete multiple connections. Passwords are stored in Android Keystore or iOS Keychain instead of ordinary preferences.

Android displays a low-priority foreground notification listing running tasks and sends a completion or failure notification; tapping it opens that connection and task. iOS refreshes and notifies when the operating system grants background execution time. iOS does not guarantee polling intervals; production-grade immediate lock-screen notifications require connecting `CodexRemoteNativePlugin` to APNs.

## Install through a Codex conversation

Copy this prompt into Codex:

```text
Install Codex Remote on my Mac.

GitHub repository: git@github.com:cnwenf/codex-remote.git

1. Read the repository README, detect ARM64 or x86_64, and ask whether I want private networking or public HTTPS. For private mode list non-loopback IPv4 addresses; public mode must not require a public IP.
2. Ask me for the Web login password. Never put it in a URL, log, Git, LaunchAgent plist, or command-line argument.
3. Follow the README curl | sh flow exactly and answer its interactive prompts with my selections.
4. Verify the DMG SHA-256, ad-hoc signature, matching CPU architecture, login startup configuration, and local health endpoint.
5. Tell me to quit and reopen Codex Desktop exactly once. Do not repeatedly restart Desktop.
6. Report the complete access URL, my chosen password, and whether every verification passed. Clearly report failures.
```

## App controls

Codex Remote appears in both the Dock and macOS menu bar. Clicking its Dock icon opens the current Remote Web page. The menu-bar app can enable or disable Remote, choose private or public HTTPS, change the bind address and Web password, open the Web UI, show a mobile pairing QR, show status and version, and install the latest GitHub release in place. In-app updates download the matching architecture DMG, verify SHA-256, signature, and architecture, and restore the previous app if the new version does not start successfully.

The password is stored at `~/Library/Application Support/Codex Remote/token` with mode `0600`; its directory uses mode `0700`.

## Login startup

The installer creates two explicit user LaunchAgents:

- `local.codex-remote.app` starts the native app at login but does not repeatedly relaunch it after the user deliberately quits.
- `local.codex-remote.desktop` starts Desktop once at login with `--remote-debugging-address=127.0.0.1 --remote-debugging-port=9229`. It never uses `KeepAlive` to relaunch Desktop repeatedly; during installation or an upgrade, an already-running Desktop is left alone until the user exits it normally, then one debug-enabled instance is started.

```bash
launchctl print "gui/$(id -u)/local.codex-remote.app"
launchctl print "gui/$(id -u)/local.codex-remote.desktop"
curl -fsS http://127.0.0.1:4321/health
```

## Security

The current DMG uses ad-hoc signing, so macOS may ask for confirmation on first launch. Installation proceeds only after checksum verification. Keep ports `4321` and `9229` off the public Internet; `9229` must remain loopback-only.

Mobile clients only allow plain HTTP for numeric IP addresses, `localhost`, and `.local` hosts. Public mode uses a checksum-verified Cloudflare Quick Tunnel over HTTPS and still requires a strong Web password. Quick Tunnel URLs change after reconnection, are intended for testing/development, have no SLA, and Cloudflare does not support SSE on them. Codex Remote uses WebSocket, but public mode must still be validated on a dedicated machine before use. The password is sent in the `Authorization` header and never placed in the URL.
