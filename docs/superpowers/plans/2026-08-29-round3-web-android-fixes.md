# Round 3 Web and Android Fixes Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Ship 0.5.22 with safe image/link navigation, private-path redaction, reliable Android external links, and exactly-once queued delivery across Stop and idle races.

**Architecture:** Keep navigation policy in the shared React timeline, platform delegation in the mobile shell/native plugin, message normalization at both live-event and persisted-rollout boundaries, and queue delivery inside the Desktop bridge transport. Queue promotion removes the shared queued record transactionally, calls thread-owner steer while active, falls back to thread-owner start for terminal races, and restores only on a confirmed delivery failure.

**Tech Stack:** React 19, TypeScript, Vitest, Playwright, Capacitor 8, Android Java/Gradle, Swift/iOS packaging, Node gateway.

**Spec:** `docs/superpowers/specs/2026-08-29-round3-web-android-fixes-design.md`

## Global Constraints

- Preserve the App-managed production gateway on port 4321 during acceptance.
- Do not restart Codex Desktop.
- Never expose real tokens, private addresses, usernames, or local image paths in logs, tests, commits, or release notes.
- Keep package, Android, iOS, and tag versions aligned at 0.5.22.

---

### Task 1: Safe conversation navigation and message rendering

**Files:**
- Modify: `src/web/components/timeline.tsx`
- Modify: `src/web/components/timeline.test.tsx`
- Modify: `src/web/styles.css`
- Modify: `src/gateway/server.ts`
- Modify: `src/gateway/server.test.ts`
- Modify: `src/gateway/desktop-state.ts`
- Modify: `src/gateway/desktop-state.test.ts`

**Interfaces:**
- Consumes: `Timeline` image IDs and optional `onOpenExternalUrl(url)` callback.
- Produces: non-navigating image preview, safe external-link rendering, and normalized user-message text with preserved `imageIds`.

- [ ] Add failing timeline tests proving image clicks open a dialog without an anchor/navigation and unsafe/relative links have no link role.
- [ ] Add failing live-event and persisted-rollout tests proving `<image ... path="...">` envelopes and closing tags are absent from user-visible text.
- [ ] Implement a shared safe HTTP(S) predicate, in-app preview dialog, and non-interactive rendering for invalid links.
- [ ] Normalize live and persisted user-message text while retaining authenticated image IDs.
- [ ] Run `pnpm exec vitest run src/web/components/timeline.test.tsx src/gateway/server.test.ts src/gateway/desktop-state.test.ts`.
- [ ] Commit the focused rendering/navigation change.

### Task 2: Android system-browser delegation and visible errors

**Files:**
- Modify: `src/mobile/mobile-shell.tsx`
- Modify: `src/mobile/mobile-shell.test.tsx`
- Modify: `android/app/src/main/AndroidManifest.xml`
- Modify: `android/app/src/main/java/com/cnwenf/codexremote/CodexRemoteNativePlugin.java`

**Interfaces:**
- Consumes: `CodexRemoteNative.openExternalUrl({ url })`.
- Produces: package-visible HTTP(S) system-browser launch and a localized current-page error when native opening fails.

- [ ] Add a failing mobile-shell test that rejects `openExternalUrl` and expects a visible localized error without leaving the active Remote view.
- [ ] Add Android HTTP/HTTPS browser intent queries and keep the allowlist limited to HTTP(S).
- [ ] Preserve native rejection details at the bridge boundary and map them to a user-actionable mobile error.
- [ ] Run the focused React test and Android unit tests.
- [ ] Commit the Android external-link change.

### Task 3: Exactly-once Queue, Steer, and Stop delivery

**Files:**
- Modify: `src/gateway/desktop-bridge-transport.ts`
- Modify: `src/gateway/desktop-bridge-transport.test.ts`
- Modify: `src/gateway/desktop-cdp-client.ts`
- Modify: `src/gateway/desktop-cdp-client.test.ts`

**Interfaces:**
- Consumes: `desktop/queue/steer`, Desktop shared queued state, `thread-follower-steer-turn`, and `thread-follower-start-turn`.
- Produces: `{ messageId }` after one accepted delivery; restores the queued item only when both active-turn steer and idle-turn start fail.

- [ ] Replace the existing DOM-click expectation with a failing test that requires direct thread-owner steer after the queue removal write.
- [ ] Add a failing Stop/idle-race test that makes steer return `no active turn to steer` and requires one thread-owner start without restoring the queue.
- [ ] Add a failing start-error test that requires one queue restore and one client-visible error.
- [ ] Remove the Desktop DOM promotion method and route active/idle delivery through owner RPCs.
- [ ] Run the focused Desktop bridge/CDP tests and mutation-check exactly-once behavior.
- [ ] Commit the queue state-machine change.

### Task 4: Content validation and isolated acceptance

**Files:**
- Modify: `src/gateway/server.test.ts`
- Modify: `src/web/api/socket.test.ts`
- Modify: `scripts/start-test-stack.ts`
- Create: `scripts/verify-android-test-gateway.ts`

**Interfaces:**
- Consumes: gateway image-upload endpoint and test-stack port configuration.
- Produces: clear 415 client error for spoofed image bytes and a test gateway that refuses production port 4321.

- [ ] Strengthen the spoofed-image test to assert no uploaded image can be read or referenced after rejection.
- [ ] Add a failing test for the client-visible 415 message when extension/MIME claim PNG but bytes are invalid.
- [ ] Add an isolated Android acceptance preflight that rejects port 4321 and verifies the chosen port was free before launch.
- [ ] Run the focused gateway/socket/test-stack tests.
- [ ] Commit the validation and acceptance-isolation change.

### Task 5: Full regression and 0.5.22 release

**Files:**
- Modify: `package.json`
- Modify: `android/app/build.gradle`
- Modify: `ios/App/App.xcodeproj/project.pbxproj`
- Modify: release notes only if the existing workflow requires them.

**Interfaces:**
- Consumes: repository release workflow for `v0.5.22`.
- Produces: aligned macOS, Android, iOS, Web, tag, and published assets.

- [ ] Run `pnpm check`, `pnpm build`, `pnpm e2e`, Android unit/build checks, `pnpm build:mac`, and native installer tests.
- [ ] Run real Web and Android emulator regression for preview, links, image synchronization, queue/Steer/Stop, Todo idle cleanup, and reconnect exactly-once behavior while port 4321 stays healthy.
- [ ] Update all platform versions to 0.5.22 and increment Android/iOS build numbers.
- [ ] Re-run version-alignment and package checks, then scan the explicit diff for credentials, private addresses, usernames, runtime data, and generated artifacts.
- [ ] Commit, push `main`, create/push `v0.5.22`, and wait for the release workflow.
- [ ] Download every official asset to a fresh temporary directory; verify checksums, DMGs, signatures, architectures, APK signing, and iOS archives.
- [ ] Upgrade the local Codex Remote app without restarting Desktop and verify the official gateway, Web page, and Android connection.
