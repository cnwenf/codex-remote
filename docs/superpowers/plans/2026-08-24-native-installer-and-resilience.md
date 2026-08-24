# Native Installer and Resilience Implementation Plan

> Design: `docs/superpowers/specs/2026-08-24-native-installer-and-resilience-design.md`

## Objective

Ship Codex Remote as a self-contained macOS ARM64 application and DMG, provide an interactive checksum-verifying `curl | sh` installer, add a compact composer, and make browser sessions recover automatically from dropped connections.

## Task 0: Restore Todo List parity with Desktop

**Files:**

- Modify: `src/gateway/desktop-bridge-transport.ts`
- Modify: `src/gateway/desktop-bridge-transport.test.ts`
- Modify: `src/protocol/thread-store.ts`
- Modify: `src/protocol/thread-store.test.ts`
- Modify: `src/web/components/timeline.tsx`
- Modify: `src/web/components/timeline.test.tsx`
- Modify: `tests/e2e/codex-web.spec.ts`

**Steps:**

1. Capture a redacted event trace from the currently running Desktop task that visibly contains a Desktop Todo List but not a Web Todo List.
2. Identify whether the missing payload is lost during CDP event extraction, App Server normalization, history resume, thread-state reduction, or timeline selection.
3. Add the smallest failing fixture at the layer where the payload disappears, including live-update and reopened-history variants.
4. Preserve Todo identity, text, status, order, and replacement semantics without rendering raw protocol events twice.
5. Render the current Todo List as a single aggregated card matching Desktop semantics and keep it updated in place.
6. Verify with unit/E2E fixtures, then reload only the Web gateway and confirm the Todo List in the actual running task without restarting Desktop.

## Task 1: Browser socket reconnection contract

**Files:**

- Modify: `src/web/api/socket.ts`
- Modify: `src/web/api/socket.test.ts`
- Modify: `src/web/state/use-codex.ts`
- Modify: `src/web/state/use-codex.test.tsx`

**Steps:**

1. Add failing fake-socket tests for unexpected-close retries, capped exponential backoff, immediate online retry, deliberate disconnect, cookie-based reconnect, and no RPC replay.
2. Add a reconnecting session state and injectable scheduler/event hooks.
3. Preserve the last socket URL and authentication mode without retaining a plaintext login token after the session cookie is created.
4. Reconnect with the cookie, reject in-flight RPCs, and emit session lifecycle events.
5. Refresh the thread list and selected thread tail after `ready` without duplicating messages.
6. Run the focused Vitest files.

## Task 2: Gateway heartbeat and recovery E2E

**Files:**

- Modify: `src/gateway/server.ts`
- Modify: `src/gateway/server.test.ts`
- Modify: `tests/e2e/codex-web.spec.ts`
- Modify: `scripts/start-test-stack.ts`

**Steps:**

1. Add failing tests for pinging active controllers, terminating stale controllers, and timer cleanup.
2. Implement a bounded WebSocket heartbeat using native ping/pong frames.
3. Add a test-only disconnect control to the E2E stack without exposing it in production.
4. Add an E2E case that disconnects the browser socket, observes reconnecting state, then verifies selected-thread recovery and a successful subsequent request without reloading.
5. Run gateway tests and the focused Playwright test.

## Task 3: Compact composer interaction

**Files:**

- Modify: `src/web/components/composer.tsx`
- Modify: `src/web/components/composer.test.tsx`
- Modify: `src/web/components/conversation-viewport.tsx`
- Modify: `src/web/app.tsx`
- Modify: `src/web/styles.css`
- Modify: `tests/e2e/codex-web.spec.ts`

**Steps:**

1. Add failing component tests for default collapse, focus expansion, internal-control interaction, viewport collapse, multiline draft preservation, attachments, and running-state actions.
2. Make expanded state controlled by the thread view so the viewport can collapse it deterministically.
3. Render a one-line compact surface while preserving the existing textarea value and attachment state.
4. Keep settings and secondary actions mounted only while expanded; maintain keyboard and accessible labels.
5. Add responsive styles and mobile E2E coverage.
6. Run focused component and E2E tests.

## Task 4: Installer primitives and secure configuration

**Files:**

- Create: `install.sh`
- Create: `scripts/install-lib.sh`
- Create: `scripts/install.test.ts`
- Create: `scripts/render-native-launch-agents.sh`
- Create: `scripts/native-launch-agents.test.ts`
- Modify: `.gitignore`

**Steps:**

1. Add failing tests for private IPv4 filtering, active-route recommendation, `/dev/tty` reads, password non-disclosure, exact release asset names, checksum mismatch, architecture rejection, and idempotent file layout.
2. Implement POSIX shell helpers with a source guard so tests can call pure functions.
3. Use stable GitHub latest-release asset URLs and require both the DMG and checksum.
4. Write `config.plist` and the token through temporary mode-`0600` files followed by atomic rename.
5. Render explicit application and Desktop LaunchAgents. Assert that generated files contain no token and no `launchctl submit`.
6. Implement installation, update, mount, copy, migration, bootstrap, and final instructions with resolved paths and cleanup traps.
7. Run focused script tests and ShellCheck when available.

## Task 5: Native App core and UI

**Files:**

- Create: `macos/CodexRemoteApp/Package.swift`
- Create: `macos/CodexRemoteApp/Sources/CodexRemoteCore/Configuration.swift`
- Create: `macos/CodexRemoteApp/Sources/CodexRemoteCore/Release.swift`
- Create: `macos/CodexRemoteApp/Sources/CodexRemoteCore/GatewaySupervisor.swift`
- Create: `macos/CodexRemoteApp/Sources/CodexRemoteApp/main.swift`
- Create: `macos/CodexRemoteApp/Tests/CodexRemoteCoreTests/ConfigurationTests.swift`
- Create: `macos/CodexRemoteApp/Tests/CodexRemoteCoreTests/ReleaseTests.swift`
- Create: `macos/CodexRemoteApp/Tests/CodexRemoteCoreTests/GatewaySupervisorTests.swift`

**Steps:**

1. Add failing Swift tests for configuration validation, atomic persistence, password-file permissions, release selection, checksum parsing, and supervisor state transitions.
2. Implement the testable Foundation core.
3. Implement one AppKit application with regular activation policy, settings window, Dock icon, menu-bar status, Remote toggle, address selector, password update, version display, open-browser action, update action, and quit.
4. Supervise the bundled Node gateway, redact environment/log output, and stop it cleanly on disable or termination.
5. Poll local health and reflect starting/running/offline/error status in both the menu and settings window.
6. Run `swift test` and a release ARM64 build.

## Task 6: App assets and self-contained packaging

**Files:**

- Create: `assets/app-icon.svg`
- Create: `scripts/render-app-icon.sh`
- Create: `scripts/build-macos-app.sh`
- Create: `scripts/package-macos-dmg.sh`
- Create: `scripts/package-macos.test.ts`
- Modify: `package.json`
- Modify: `pnpm-lock.yaml`

**Steps:**

1. Add failing packaging-contract tests for Info.plist identity/version, icon presence, ARM64 executable, bundled Node/gateway/Web files, update helper, ad-hoc signature, DMG name, and checksum format.
2. Add a pinned Node version and SHA-256 manifest. Verify the runtime archive before extraction.
3. Bundle the Vite output and an esbuild-produced gateway executable module.
4. Render `.icns` and a template menu icon from the project artwork.
5. Build the Swift executable for ARM64, assemble `Codex Remote.app`, generate Info.plist, and ad-hoc sign nested binaries followed by the app.
6. Create `Codex-Remote-arm64.dmg` and `Codex-Remote-arm64.dmg.sha256` reproducibly in `release/`.
7. Mount the DMG read-only, inspect the bundle, run `codesign --verify --deep --strict`, and verify every Mach-O architecture.

## Task 7: In-app update transaction

**Files:**

- Create: `scripts/update-installed-app.sh`
- Modify: `macos/CodexRemoteApp/Sources/CodexRemoteCore/Release.swift`
- Modify: `macos/CodexRemoteApp/Sources/CodexRemoteApp/main.swift`
- Modify: `macos/CodexRemoteApp/Tests/CodexRemoteCoreTests/ReleaseTests.swift`
- Modify: `scripts/install.test.ts`

**Steps:**

1. Add failing tests for semantic-version comparison, GitHub asset filtering, digest verification failure, rollback-safe replacement, and relaunch arguments.
2. Implement release checking and download progress without sending local configuration to GitHub.
3. Reuse the same verified install primitive for interactive install and updates.
4. Ensure replacement occurs only after the old app exits and preserves user configuration.
5. Verify a local fixture update and a no-update state.

## Task 8: Documentation, migration, and release validation

**Files:**

- Modify: `README.md`
- Modify: `README_EN.md`
- Modify: `.env.example`
- Modify: `PRODUCT.md`

**Steps:**

1. Replace manual source installation with the single `curl | sh` command and explain the interactive choices, one-time Desktop restart, menu controls, updates, uninstall, and ad-hoc signing behavior.
2. Keep Chinese and English documents equivalent and free of local usernames, real private addresses, passwords, tokens, and absolute development paths.
3. Add migration notes only where required for correct use; do not include incident narratives.
4. Run `pnpm check`, `pnpm build`, `pnpm e2e`, `swift test`, packaging tests, shell syntax checks, DMG verification, and a repository secrets/privacy scan.
5. Install the locally built DMG into a temporary application directory, launch against a temporary config, verify health and Remote toggling, and observe launchd PIDs/run counts for at least 30 seconds without restarting Codex Desktop.
6. Commit with `cnwenf@outlook.com`, push `main`, create a GitHub Release with the DMG and checksum, then verify the documented `curl | sh` flow resolves the published assets.
