# Codex Remote Mobile Clients Implementation Plan

> Design: `docs/superpowers/specs/2026-08-24-mobile-clients-design.md`

## Objective

Deliver shared-code Android and iPhone clients with multi-remote connection management, protected credentials, background task-status notifications, notification deep links, reproducible release artifacts, and fixes for completed Todo visibility and duplicate live steer messages.

## Task 1: Existing Web regressions

**Files:**

- Modify: `src/web/components/timeline.tsx`
- Modify: `src/web/components/timeline.test.tsx`
- Modify: `src/protocol/thread-store.ts`
- Modify: `src/protocol/thread-store.test.ts`
- Modify: `src/web/state/use-codex.test.tsx`
- Modify: `tests/e2e/codex-web.spec.ts`

**Steps:**

1. Add a failing Todo component test for an all-completed plan.
2. Hide the Todo dock when no actionable item remains.
3. Add a failing reducer/hook test where an optimistic `web-steer-*` message is followed by an authoritative live user message with another ID.
4. Reconcile one matching optimistic item in place while preserving uploaded image IDs.
5. Add desktop and phone Playwright assertions for both regressions.

## Task 2: Gateway mobile status API

**Files:**

- Modify: `src/gateway/server.ts`
- Modify: `src/gateway/server.test.ts`
- Modify: `src/gateway/desktop-state.ts`
- Modify: `src/gateway/desktop-state.test.ts`
- Create: `src/gateway/mobile-status.ts`
- Create: `src/gateway/mobile-status.test.ts`

**Steps:**

1. Add failing tests for cookie and Bearer authentication, GET-only behavior, no-store headers, bounded output, and rejected invalid credentials.
2. Derive a minimal task-state projection from authoritative Desktop metadata.
3. Implement per-address bounded rate limiting and response size limits.
4. Ensure no messages, content, settings, paths, or tokens can enter the response.
5. Run focused gateway tests.

## Task 3: Shared native connection and notification domain

**Files:**

- Create: `src/mobile/types.ts`
- Create: `src/mobile/connection-store.ts`
- Create: `src/mobile/connection-store.test.ts`
- Create: `src/mobile/deep-link.ts`
- Create: `src/mobile/deep-link.test.ts`
- Create: `src/mobile/status-monitor.ts`
- Create: `src/mobile/status-monitor.test.ts`
- Create: `src/mobile/native-bridge.ts`

**Steps:**

1. Add failing tests for URL normalization, private-network HTTP handling, CRUD ordering, secret isolation, deep-link parsing, running-state snapshots, and single completion notification.
2. Implement platform-neutral connection metadata and monitoring transitions.
3. Define a narrow native-plugin API for secret storage, status monitoring, notification permission, and launch targets.
4. Provide a deterministic Web/test adapter without weakening browser authentication.

## Task 4: React mobile shell and multi-remote UX

**Files:**

- Create: `src/mobile/mobile-shell.tsx`
- Create: `src/mobile/connection-list.tsx`
- Create: `src/mobile/connection-form.tsx`
- Create: `src/mobile/mobile-shell.test.tsx`
- Modify: `src/web/main.tsx`
- Modify: `src/web/app.tsx`
- Modify: `src/web/api/socket.ts`
- Modify: `src/web/styles.css`

**Steps:**

1. Add failing tests for empty state, add, edit, select, delete confirmation, restored connection, and requested-task navigation.
2. Detect Capacitor at runtime and wrap the existing `App` with the mobile connection shell.
3. Pass selected base URL and token into the existing socket without using cookie login.
4. Preserve the browser and macOS Web flows byte-for-byte where possible.
5. Add connection switching, settings access, offline/retry states, and accessible phone layouts.

## Task 5: Capacitor projects and protected credentials

**Files:**

- Modify: `package.json`
- Modify: `pnpm-lock.yaml`
- Modify: `vite.config.ts`
- Create: `capacitor.config.ts`
- Create: `android/`
- Create: `ios/`
- Create: native secure-storage plugin implementations and tests

**Steps:**

1. Add Capacitor v8 and official App/Local Notifications dependencies.
2. Configure relative Vite assets, stable application ID, custom scheme, icon, and platform version metadata.
3. Add Android Keystore-backed encrypted token storage.
4. Add iOS Keychain token storage with device-only accessibility.
5. Configure private-network HTTP access without globally disabling network security.
6. Build and launch the shared Web bundle in both native shells.

## Task 6: Android foreground monitoring

**Files:**

- Create/modify: Android Kotlin service, plugin, manifest, resources, and tests

**Steps:**

1. Add failing tests for start/stop idempotency, active-task notification content, no-running-task teardown, completion notification deduplication, and deep-link intent extras.
2. Implement an explicit foreground monitoring service with a standard ongoing notification.
3. Poll only the bounded authenticated status endpoint with timeouts and backoff.
4. Request Android 13+ notification permission in context and expose denied state to React.
5. Open the selected remote/task from ongoing and completion notifications.

## Task 7: iOS background refresh and notifications

**Files:**

- Create/modify: iOS Swift plugin, background task handler, Keychain store, Info.plist, capabilities, and tests

**Steps:**

1. Add failing tests for background transition comparison, notification deduplication, Keychain round trip, and deep-link target restoration.
2. Schedule `BGAppRefreshTask` when active tasks exist and refresh immediately on foreground.
3. Generate local completion notifications and route notification taps to the corresponding task.
4. Reserve an APNs registration interface without embedding signing or provider credentials.
5. Document and surface the best-effort background limitation when APNs is not configured.

## Task 8: Cross-platform browser and native verification

**Files:**

- Modify: `tests/e2e/codex-web.spec.ts`
- Create: `tests/e2e/mobile-shell.spec.ts`
- Modify: `playwright.config.ts`

**Steps:**

1. Add desktop and phone projects with stable viewport fixtures.
2. Verify completed Todo removal, live steer deduplication, connection CRUD, reconnect, task navigation, and deep-link restoration.
3. Capture desktop and phone acceptance screenshots without real addresses or credentials.
4. Run unit, TypeScript, Vite, Android, iOS Simulator, and E2E suites.

## Task 9: Build, CI, documentation, and release

**Files:**

- Modify: `.github/workflows/release.yml`
- Create: mobile build/checksum scripts
- Modify: `README.md`
- Modify: `README_EN.md`
- Modify: `PRODUCT.md`
- Modify: `.gitignore`

**Steps:**

1. Build Android ARM64 APK and iOS Simulator app zip locally when toolchains are present.
2. Extend tagged release CI to publish macOS, Android, and iOS Simulator artifacts with SHA-256 sidecars.
3. Add optional signed IPA job guarded by Apple signing secrets.
4. Document connection setup, notification permissions, background differences, deep links, installation, and update behavior in Chinese and English.
5. Bump the shared release version.
6. Run a tracked-file privacy/secrets scan and dependency audit; ensure no local username, real private IP, token, key, or temporary artifact is committed.
7. Commit with the configured author email, push `main`, tag the release, wait for CI, and verify GitHub release assets.
