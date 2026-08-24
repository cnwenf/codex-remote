# Codex Remote Parity Implementation Plan

> **Execution:** Use `superpowers:executing-plans` in this session. Implement every behavior red-green-refactor and preserve the running Desktop until the final restart gate.

**Goal:** Make the VPN-only browser client control the same Desktop-owned Codex threads and active turns, with official Remote-equivalent organization, status, controls, approvals, and configuration where the installed protocol supports them.

**Architecture:** Add a loopback CDP client and `DesktopBridgeTransport`, then route requests through a composite ownership-aware transport. Keep the current SQLite/rollout reader as read-only recovery and the independent App Server for explicitly web-owned work. Extend the normalized Thread -> Turn -> Item reducer and React UI from protocol capability data.

**Tech stack:** TypeScript 5, Node 22, React 19, Vite 7, `ws`, Vitest, Testing Library, Playwright.

**Spec:** `docs/superpowers/specs/2026-08-23-codex-remote-parity-design.md`

## Task 1: Installed Desktop capability manifest

**Files:**
- Create: `src/gateway/desktop-installation.ts`
- Create: `src/protocol/capabilities.ts`
- Test: `src/gateway/desktop-installation.test.ts`
- Test: `src/protocol/capabilities.test.ts`

- [ ] Write tests for installed app discovery, semantic version comparison, supported request/server-request sets, and incompatible-version failure.
- [ ] Run focused tests and record the expected missing-module failures.
- [ ] Implement read-only bundle metadata inspection and a versioned capability manifest without evaluating application code.
- [ ] Return an explicit compatibility result consumed by gateway session state.
- [ ] Run focused tests, type checking, and refactor duplicate method lists.

## Task 2: Loopback CDP client

**Files:**
- Create: `src/gateway/desktop-cdp-client.ts`
- Test: `src/gateway/desktop-cdp-client.test.ts`
- Create: `tests/fixtures/fake-cdp-server.ts`

- [ ] Write a fake HTTP discovery plus WebSocket CDP server covering renderer selection, Runtime enablement, binding events, evaluation calls, disconnect, and rejection of a non-loopback endpoint.
- [ ] Run the focused test and record RED.
- [ ] Implement bounded discovery and a request-correlated CDP client using only the Runtime domain operations required for the bridge.
- [ ] Install an idempotent renderer listener that forwards relevant Desktop messages through a named CDP binding.
- [ ] Ensure disconnect rejects pending calls, emits one state transition, and removes no Desktop-owned state.
- [ ] Run focused tests including malformed and hostile discovery responses.

## Task 3: Desktop bridge transport

**Files:**
- Create: `src/gateway/desktop-bridge-transport.ts`
- Test: `src/gateway/desktop-bridge-transport.test.ts`
- Modify: `src/protocol/types.ts`

- [ ] Write tests that assert the exact `mcp-request` envelope, `hostId: "local"` filtering, response correlation, notification forwarding, approval `mcp-response`, initialized-version state, and read-only transition.
- [ ] Run focused tests and record RED.
- [ ] Implement the transport on top of `DesktopCdpClient` without importing renderer-minified symbols.
- [ ] Validate every outgoing method against the capability manifest and fail closed for unknown methods.
- [ ] Keep approval/server-request IDs in a separate correlation map and reject stale or duplicate responses.
- [ ] Run focused tests and protocol type checking.

## Task 4: Ownership-aware composite gateway

**Files:**
- Create: `src/gateway/composite-transport.ts`
- Test: `src/gateway/composite-transport.test.ts`
- Modify: `src/gateway/server.ts`
- Modify: `src/gateway/index.ts`
- Modify: `src/gateway/desktop-state.ts`
- Modify: `src/protocol/rpc-router.ts`

- [ ] Write tests for `desktop-live`, `desktop-cold`, and `web-live` routing; bridge disconnect; merged reads; and prohibition on resuming a Desktop thread through the independent transport.
- [ ] Run focused tests and record RED.
- [ ] Add source ownership to normalized threads and route thread-scoped requests by authoritative ownership.
- [ ] Expose bridge health, version, capability flags, and read-only reasons in session envelopes.
- [ ] Preserve the current SQLite/global-state/rollout projection only as the `desktop-cold` source.
- [ ] Run gateway integration tests with simultaneous fake Desktop and fake App Server transports.

## Task 5: Authoritative Desktop metadata mutations

**Files:**
- Modify: `src/protocol/thread-store.ts`
- Modify: `src/web/state/use-codex.ts`
- Modify: `src/web/components/task-list.tsx`
- Test: corresponding reducer, hook, and component tests

- [ ] Write tests for pin ordering, rename, archive/unarchive, delete, settings update, and protocol-confirmed optimistic state rollback.
- [ ] Run focused tests and record RED.
- [ ] Route all Desktop-owned mutations through the bridge and wait for authoritative response/notification.
- [ ] Remove the disabled local pin implementation and any second pin-state authority.
- [ ] Surface bridge-unavailable reasons while keeping cold content readable.
- [ ] Run focused and integration tests.

## Task 6: Complete turn and item model

**Files:**
- Modify: `src/protocol/types.ts`
- Modify: `src/protocol/thread-store.ts`
- Modify: `src/web/components/timeline.tsx`
- Modify: `src/web/state/use-codex.ts`
- Test: corresponding protocol and component tests

- [ ] Add failing reducer tests for interleaved turns, deltas, reasoning, commands, file changes, MCP/tool calls, search, plans/goals, reviews, compaction, errors, terminal output, and completion status.
- [ ] Add tests for queued follow-up, steer, interrupt, reconnect replay of reads only, and exact active `turnId` preservation.
- [ ] Implement stable item identity and aggregation inside each turn.
- [ ] Render GFM Markdown without raw HTML and collapse execution details into one expandable turn process region.
- [ ] Run focused tests and verify no duplicate streamed cards.

## Task 7: New conversation and Remote controls

**Files:**
- Modify: `src/web/components/new-conversation.tsx`
- Modify: `src/web/components/composer.tsx`
- Modify: `src/web/app.tsx`
- Modify: `src/web/styles.css`
- Test: corresponding React tests

- [ ] Write tests for project/direct selection, cwd, branch/worktree, model, reasoning effort, permission profile, sandbox/approval settings, and capability-disabled controls.
- [ ] Write tests for running, queued, waiting-for-approval, failed, interrupted, and completed status indicators.
- [ ] Implement controls from server-provided choices rather than hardcoded Desktop-looking values.
- [ ] Make project list, conversation, diff, and approval surfaces independently scrollable at desktop and mobile widths.
- [ ] Run accessibility-focused component tests for labels, focus order, touch targets, and reduced motion.

## Task 8: Approvals, diff, review, and terminal surfaces

**Files:**
- Modify: `src/web/components/approval-sheet.tsx`
- Modify: `src/web/components/diff-viewer.tsx`
- Create: `src/web/components/review-panel.tsx`
- Create: `src/web/components/terminal-panel.tsx`
- Test: corresponding component and hook tests

- [ ] Write tests for every supported server-request shape, explicit deny default, duplicate/stale response rejection, review findings, changed files, inline feedback, and bounded terminal output.
- [ ] Run focused tests and record RED.
- [ ] Implement capability-gated surfaces and authoritative response handling.
- [ ] Redact sensitive diagnostics and prevent raw ANSI/HTML execution.
- [ ] Run focused and gateway integration tests.

## Task 9: Security and Chrome E2E

**Files:**
- Modify: `src/gateway/auth.ts`
- Modify: `src/gateway/server.test.ts`
- Modify: `tests/e2e/codex-web.spec.ts`
- Modify: `scripts/start-test-stack.ts`

- [ ] Add negative tests for wrong token, wrong Origin, second controller, non-loopback CDP, unknown method, unsupported version, unknown approval, oversized frame, and reconnect mutation replay.
- [ ] Add desktop and mobile Chrome scenarios for projects/direct chats, pin sync, Markdown, grouped events, model/effort/permission choices, live run states, steering, interruption, approvals, diff, and bridge loss.
- [ ] Run `pnpm check`, `pnpm build`, `pnpm e2e`, and `git diff --check` with the bundled workspace runtime on `PATH`.
- [ ] Inspect screenshots at desktop and phone sizes and correct visible clipping or scroll traps.

## Task 10: One controlled Desktop restart and same-writer proof

**Files:**
- Create: `scripts/launch-desktop-bridge.sh`
- Create: `scripts/verify-desktop-bridge.ts`
- Create: `docs/desktop-restart-recovery.md`
- Test: script dry-run and verifier tests

- [ ] Resolve the exact running app bundle, process ownership, current branch, test status, loopback port availability, and recovery paths without changing Desktop.
- [ ] Write tests for launch argument construction, loopback enforcement, bounded verifier exit, and redacted evidence output.
- [ ] Create a durable checkpoint and recovery note before touching the process.
- [ ] Start a detached bounded verifier, then perform one explicit Desktop restart with the loopback DevTools port.
- [ ] Verify Desktop session restoration, bridge `desktop-live`, exact selected `threadId`, exact active `turnId`, and the same read notification on Desktop and Web.
- [ ] Run the final fresh verification suite and report any installed-version capability gaps without simulating them.
