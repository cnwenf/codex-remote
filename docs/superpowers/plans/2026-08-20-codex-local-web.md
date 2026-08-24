# Codex Remote Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a mobile-first local web client that drives an independent Codex App Server over an authenticated loopback gateway without touching the currently running Codex Desktop process.

**Architecture:** A React/Vite SPA communicates with a Node HTTP/WebSocket gateway. The gateway authenticates one controlling browser, owns a transport-neutral JSON-RPC bridge, and launches `codex app-server --listen stdio://` as a child process. A stable `CodexTransport` interface leaves room for a later Electron Desktop transport.

**Tech Stack:** TypeScript 5, React 19, Vite 7, Node 22, `ws`, Vitest, Testing Library, Playwright, CSS.

**Spec:** `docs/superpowers/specs/2026-08-20-codex-local-web-design.md`

## Global Constraints

- Do not restart, terminate, patch, inject into, or attach to the running Codex Desktop process in phase one.
- Bind to `127.0.0.1` by default; require explicit configuration for non-loopback binding.
- Require a capability token and validate WebSocket Origin before forwarding any App Server message.
- Launch child processes with argument arrays and no shell.
- Never log or persist the capability token, command bodies, file contents, or unredacted sensitive paths.
- Support one active controlling browser; reject a second controller.
- Unknown server requests fail closed.
- Follow red-green-refactor for every behavior.

---

## File map

- `package.json`: scripts and dependency versions.
- `tsconfig.json`, `vite.config.ts`, `vitest.config.ts`: TypeScript, production build, and test configuration.
- `src/protocol/types.ts`: gateway envelopes and transport contracts.
- `src/protocol/rpc-router.ts`: browser/App Server request-ID mapping and server-request handling.
- `src/protocol/thread-store.ts`: normalized thread and streaming item state reducer.
- `src/gateway/codex-binary.ts`: safe Codex binary resolution.
- `src/gateway/app-server-transport.ts`: owned App Server child lifecycle and JSONL framing.
- `src/gateway/auth.ts`: token comparison and Origin policy.
- `src/gateway/server.ts`: HTTP static server, WebSocket controller, and transport wiring.
- `src/gateway/index.ts`: environment parsing and process entrypoint.
- `src/web/api/socket.ts`: authenticated browser WebSocket client.
- `src/web/state/use-codex.ts`: RPC lifecycle and React state integration.
- `src/web/components/*`: task list, timeline, composer, approvals, and diff viewer.
- `src/web/styles.css`: responsive mobile and desktop visual system.
- `tests/fixtures/fake-codex.ts`: deterministic App Server fixture.
- `tests/e2e/codex-web.spec.ts`: Chrome desktop/mobile flows.

---

### Task 1: Workspace and test harness

**Files:**
- Create: `package.json`
- Create: `tsconfig.json`
- Create: `vite.config.ts`
- Create: `vitest.config.ts`
- Create: `index.html`
- Create: `src/web/main.tsx`
- Create: `src/web/app.tsx`
- Test: `src/web/app.test.tsx`

**Interfaces:**
- Produces: `App(): JSX.Element`, `pnpm test`, `pnpm build`, and `pnpm dev` entrypoints.

- [ ] **Step 1: Write the failing application smoke test**

```tsx
import { render, screen } from "@testing-library/react";
import { describe, expect, it } from "vitest";
import { App } from "./app";

describe("App", () => {
  it("renders the local Codex client heading", () => {
    render(<App />);
    expect(screen.getByRole("heading", { name: "Codex Remote" })).toBeVisible();
  });
});
```

- [ ] **Step 2: Run the test and verify RED**

Run: `pnpm test -- src/web/app.test.tsx`

Expected: FAIL because `src/web/app.tsx` does not exist.

- [ ] **Step 3: Add the minimal workspace and App component**

Use ESM, scripts `dev`, `gateway`, `test`, `build`, `e2e`, and `check`. Configure Vitest with `jsdom` and Testing Library cleanup. Implement:

```tsx
export function App() {
  return <main><h1>Codex Remote</h1></main>;
}
```

- [ ] **Step 4: Run the focused test and production build**

Run: `pnpm test -- src/web/app.test.tsx && pnpm build`

Expected: one passing test and Vite build exit code 0.

- [ ] **Step 5: Commit**

```bash
git add package.json pnpm-lock.yaml tsconfig.json vite.config.ts vitest.config.ts index.html src/web
git commit -m "build: scaffold Codex local web client"
```

---

### Task 2: Transport contracts and RPC correlation

**Files:**
- Create: `src/protocol/types.ts`
- Create: `src/protocol/rpc-router.ts`
- Test: `src/protocol/rpc-router.test.ts`

**Interfaces:**
- Produces: `GatewayEnvelope`, `RpcMessage`, `CodexTransport`, and `RpcRouter`.
- `CodexTransport.start(onMessage, onDiagnostic): Promise<void>` starts a transport.
- `CodexTransport.send(message): void` sends one JSON-RPC payload.
- `CodexTransport.stop(): Promise<void>` stops only resources owned by that transport.
- `RpcRouter.fromBrowser(clientId, message): RpcMessage` maps browser request IDs.
- `RpcRouter.fromServer(message): { clientId: string; message: RpcMessage } | { broadcast: RpcMessage }` reverses mappings.

- [ ] **Step 1: Write failing correlation tests**

```ts
it("maps overlapping browser ids to unique server ids", () => {
  const router = new RpcRouter();
  const first = router.fromBrowser("a", { id: 1, method: "thread/list", params: {} });
  const second = router.fromBrowser("b", { id: 1, method: "thread/list", params: {} });
  expect(first.id).not.toBe(second.id);
});

it("routes a server response back to the originating browser", () => {
  const router = new RpcRouter();
  const sent = router.fromBrowser("phone", { id: 7, method: "thread/list", params: {} });
  expect(router.fromServer({ id: sent.id, result: { data: [] } })).toEqual({
    clientId: "phone",
    message: { id: 7, result: { data: [] } },
  });
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm test -- src/protocol/rpc-router.test.ts`

Expected: FAIL because `RpcRouter` is missing.

- [ ] **Step 3: Implement monotonic IDs and bidirectional maps**

Implement request detection using own-property checks, a monotonic integer counter starting at 1, browser-to-server and server-to-browser maps, broadcast notifications without IDs, and safe rejection of unmapped responses.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `pnpm test -- src/protocol/rpc-router.test.ts`

Expected: all router tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/protocol
git commit -m "feat: add transport contracts and RPC routing"
```

---

### Task 3: Owned App Server child transport

**Files:**
- Create: `src/gateway/codex-binary.ts`
- Create: `src/gateway/app-server-transport.ts`
- Create: `tests/fixtures/fake-codex.mjs`
- Test: `src/gateway/codex-binary.test.ts`
- Test: `src/gateway/app-server-transport.test.ts`

**Interfaces:**
- Consumes: `CodexTransport`, `RpcMessage`.
- Produces: `resolveCodexBinary(env, pathExists): string` and `AppServerTransport`.
- `new AppServerTransport({ binary, cwd, env, argsPrefix? })` launches `<binary> [...argsPrefix, "app-server", "--listen", "stdio://"]` with `shell: false`; `argsPrefix` exists only to inject the deterministic test fixture.

- [ ] **Step 1: Write failing binary-resolution and framing tests**

```ts
it("prefers an explicit CODEX_BIN", () => {
  expect(resolveCodexBinary({ CODEX_BIN: "/tmp/codex" }, p => p === "/tmp/codex"))
    .toBe("/tmp/codex");
});

it("emits each complete JSONL frame", async () => {
  const received: unknown[] = [];
  const transport = new AppServerTransport({ binary: process.execPath, argsPrefix: [fixture] });
  await transport.start(message => received.push(message), () => undefined);
  transport.send({ id: 1, method: "initialize", params: {} });
  await waitFor(() => received.length === 1);
  expect(received[0]).toMatchObject({ id: 1, result: { ready: true } });
  await transport.stop();
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm test -- src/gateway/codex-binary.test.ts src/gateway/app-server-transport.test.ts`

Expected: FAIL because transport modules are missing.

- [ ] **Step 3: Implement safe resolution, spawn, JSONL buffering, diagnostics, and owned shutdown**

Use `spawn(binary, [...argsPrefix, "app-server", "--listen", "stdio://"], { shell: false })`. Buffer stdout until newline, parse each non-empty line, redact stderr diagnostics to length and category, reject malformed JSON, and on stop send SIGTERM only to the stored child PID followed by a bounded SIGKILL fallback.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `pnpm test -- src/gateway/codex-binary.test.ts src/gateway/app-server-transport.test.ts`

Expected: all transport tests pass with no orphan fixture process.

- [ ] **Step 5: Commit**

```bash
git add src/gateway tests/fixtures
git commit -m "feat: manage an owned Codex App Server transport"
```

---

### Task 4: Authenticated single-controller gateway

**Files:**
- Create: `src/gateway/auth.ts`
- Create: `src/gateway/server.ts`
- Create: `src/gateway/index.ts`
- Test: `src/gateway/auth.test.ts`
- Test: `src/gateway/server.test.ts`

**Interfaces:**
- Consumes: `CodexTransport`, `RpcRouter`.
- Produces: `createGateway(options): { start(): Promise<AddressInfo>; stop(): Promise<void> }`.
- Options include `host`, `port`, `token`, `allowedOrigins`, `staticDir`, and `transport`.
- WebSocket authentication uses the `Sec-WebSocket-Protocol` values `codex-local` and `token.<base64url>`; tokens never appear in URLs.

- [ ] **Step 1: Write failing auth and controller tests**

```ts
it("rejects the wrong token using constant-time comparison", () => {
  expect(isAuthorized("wrong", "correct")).toBe(false);
});

it("rejects a second controlling websocket", async () => {
  const first = await connectGateway({ token });
  await expect(connectGateway({ token })).rejects.toThrow(/controller-already-connected/);
  first.close();
});

it("defaults to loopback", async () => {
  const gateway = createGateway({ port: 0, token, transport });
  const address = await gateway.start();
  expect(address.address).toBe("127.0.0.1");
  await gateway.stop();
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm test -- src/gateway/auth.test.ts src/gateway/server.test.ts`

Expected: FAIL because gateway modules are missing.

- [ ] **Step 3: Implement HTTP health/static serving and authenticated WebSocket forwarding**

Use Node `http.createServer`, `ws.WebSocketServer({ noServer: true })`, `crypto.timingSafeEqual`, exact Origin allowlisting, one controller slot, frame size limit of 2 MiB, JSON-only messages, and graceful close codes. Call transport `start` once with gateway startup and `stop` once with gateway shutdown.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `pnpm test -- src/gateway/auth.test.ts src/gateway/server.test.ts`

Expected: loopback, auth, origin, forwarding, and controller tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/gateway
git commit -m "feat: add authenticated local WebSocket gateway"
```

---

### Task 5: Browser socket client and normalized thread state

**Files:**
- Create: `src/web/api/socket.ts`
- Create: `src/protocol/thread-store.ts`
- Create: `src/web/state/use-codex.ts`
- Test: `src/web/api/socket.test.ts`
- Test: `src/protocol/thread-store.test.ts`

**Interfaces:**
- Produces: `CodexSocket`, `reduceCodexState(state, rpc)`, and `useCodex()`.
- `CodexSocket.request(method, params): Promise<unknown>` correlates browser IDs.
- `CodexSocket.notify(method, params): void` sends notifications.
- `CodexSocket.subscribe(listener): () => void` receives server notifications and requests.

- [ ] **Step 1: Write failing socket and reducer tests**

```ts
it("resolves a request when its response arrives", async () => {
  const socket = new CodexSocket(fakeWebSocketFactory);
  const result = socket.request("thread/list", { limit: 20 });
  fakeServer.send({ id: 1, result: { data: [{ id: "t1" }] } });
  await expect(result).resolves.toEqual({ data: [{ id: "t1" }] });
});

it("appends streamed agent text", () => {
  const next = reduceCodexState(initialState, {
    method: "item/agentMessage/delta",
    params: { threadId: "t1", itemId: "i1", delta: "hello" },
  });
  expect(next.threads.t1.items.i1.text).toBe("hello");
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm test -- src/web/api/socket.test.ts src/protocol/thread-store.test.ts`

Expected: FAIL because socket and reducer are missing.

- [ ] **Step 3: Implement socket lifecycle, no mutation replay, and immutable reducer updates**

Use an incrementing browser request ID, reject all pending promises on disconnect, never replay requests, normalize thread IDs and item IDs, append deltas, and mark state stale until `thread/read` refreshes it.

- [ ] **Step 4: Run tests and verify GREEN**

Run: `pnpm test -- src/web/api/socket.test.ts src/protocol/thread-store.test.ts`

Expected: correlation, disconnect, streaming, status, and stale-state tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/protocol src/web/api src/web/state
git commit -m "feat: add browser RPC client and Codex state reducer"
```

---

### Task 6: Mobile task list, timeline, and composer

**Files:**
- Create: `src/web/components/task-list.tsx`
- Create: `src/web/components/timeline.tsx`
- Create: `src/web/components/composer.tsx`
- Create: `src/web/components/token-dialog.tsx`
- Create: `src/web/styles.css`
- Modify: `src/web/app.tsx`
- Test: `src/web/components/task-list.test.tsx`
- Test: `src/web/components/composer.test.tsx`
- Test: `src/web/app.test.tsx`

**Interfaces:**
- Consumes: `useCodex()` thread state and operations.
- Produces: accessible task navigation, streamed timeline, token entry, and start/steer/interrupt controls.

- [ ] **Step 1: Write failing interaction tests**

```tsx
it("opens a selected task", async () => {
  render(<TaskList threads={[thread]} onSelect={onSelect} />);
  await user.click(screen.getByRole("button", { name: /Fix login race/ }));
  expect(onSelect).toHaveBeenCalledWith("t1");
});

it("sends composer text and clears only after success", async () => {
  render(<Composer onSend={onSend} running={false} />);
  await user.type(screen.getByRole("textbox"), "Run the tests");
  await user.click(screen.getByRole("button", { name: "Send" }));
  expect(onSend).toHaveBeenCalledWith("Run the tests");
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm test -- src/web/components src/web/app.test.tsx`

Expected: FAIL because components are missing.

- [ ] **Step 3: Implement the responsive application shell**

Use semantic buttons and lists, 44-pixel touch targets, CSS grid for desktop, a single navigation stack below 760px, `env(safe-area-inset-*)`, system light/dark colors, reduced-motion media query, persistent composer placement, and no horizontal body scrolling.

- [ ] **Step 4: Run component tests and build**

Run: `pnpm test -- src/web && pnpm build`

Expected: UI tests pass and production build succeeds.

- [ ] **Step 5: Commit**

```bash
git add src/web index.html
git commit -m "feat: build the mobile Codex task experience"
```

---

### Task 7: Approval and diff review surfaces

**Files:**
- Create: `src/web/components/approval-sheet.tsx`
- Create: `src/web/components/diff-viewer.tsx`
- Modify: `src/web/app.tsx`
- Modify: `src/protocol/thread-store.ts`
- Test: `src/web/components/approval-sheet.test.tsx`
- Test: `src/web/components/diff-viewer.test.tsx`

**Interfaces:**
- Consumes: mapped server requests and diff notifications.
- Produces: `ApprovalDecision = "accept" | "decline"`, explicit response actions, and safe unified-diff rendering.

- [ ] **Step 1: Write failing deny-by-default and diff tests**

```tsx
it("does not approve without an explicit accept click", async () => {
  render(<ApprovalSheet request={request} onResolve={onResolve} />);
  expect(screen.getByRole("button", { name: "Deny" })).toHaveFocus();
  expect(onResolve).not.toHaveBeenCalled();
});

it("renders diff text as text rather than HTML", () => {
  render(<DiffViewer diff={'<script>alert("x")</script>'} />);
  expect(screen.getByText(/<script>/)).toBeVisible();
  expect(document.querySelector("script")).toBeNull();
});
```

- [ ] **Step 2: Run tests and verify RED**

Run: `pnpm test -- src/web/components/approval-sheet.test.tsx src/web/components/diff-viewer.test.tsx`

Expected: FAIL because review components are missing.

- [ ] **Step 3: Implement explicit approvals and escaped diff rendering**

Render command and file-change summaries as plain text, focus Deny on open, require a separate Accept click, resolve exactly once, display added/deleted/context lines with CSS classes, and cap in-memory rendered diff size with a visible truncation notice.

- [ ] **Step 4: Run review tests and accessibility checks**

Run: `pnpm test -- src/web/components/approval-sheet.test.tsx src/web/components/diff-viewer.test.tsx`

Expected: all approval and diff tests pass.

- [ ] **Step 5: Commit**

```bash
git add src/web src/protocol/thread-store.ts
git commit -m "feat: add explicit approvals and diff review"
```

---

### Task 8: Real Chrome E2E, real App Server smoke test, and runbook

**Files:**
- Create: `playwright.config.ts`
- Create: `tests/e2e/codex-web.spec.ts`
- Create: `scripts/start-test-stack.mjs`
- Create: `scripts/smoke-app-server.mjs`
- Create: `.env.example`
- Create: `.gitignore`
- Create: `README.md`

**Interfaces:**
- Consumes: production gateway, fake fixture, installed Codex binary.
- Produces: repeatable `pnpm e2e`, `pnpm smoke:app-server`, and documented `pnpm dev` flows.

- [ ] **Step 1: Write the failing Playwright flow**

```ts
test("mobile controller opens a task, streams output, and denies approval", async ({ page }) => {
  await page.goto("/");
  await page.getByLabel("Access token").fill("e2e-token");
  await page.getByRole("button", { name: "Connect" }).click();
  await page.getByRole("button", { name: /Fixture task/ }).click();
  await page.getByRole("textbox").fill("Run checks");
  await page.getByRole("button", { name: "Send" }).click();
  await expect(page.getByText("Checks complete")).toBeVisible();
  await page.getByRole("button", { name: "Deny" }).click();
  await expect(page.getByText("Request denied")).toBeVisible();
});
```

- [ ] **Step 2: Run E2E and verify RED**

Run: `pnpm e2e`

Expected: FAIL until the deterministic fixture and webServer command exist.

- [ ] **Step 3: Implement deterministic test stack and App Server smoke client**

Start the gateway with the fake Codex fixture and `CODEX_WEB_TOKEN=e2e-token`. Configure Playwright projects for installed Chrome desktop and a mobile Chrome viewport. The smoke script launches the installed App Server in a temporary working directory, sends `initialize`, sends `thread/list`, validates responses, then stops only its child process.

- [ ] **Step 4: Run the complete verification matrix**

Run:

```bash
pnpm check
pnpm build
pnpm e2e
pnpm smoke:app-server
git diff --check
```

Expected: all unit/integration/component tests pass, TypeScript and Vite builds exit 0, Chrome desktop/mobile flows pass, real App Server initializes and lists threads, and Git reports no whitespace errors.

- [ ] **Step 5: Manually open installed Chrome and inspect both viewports**

Start the test stack, open its local URL in the user's installed Chrome, confirm no horizontal scrolling at a phone viewport, send a fixture instruction, deny an approval, inspect the diff, and capture a screenshot under `artifacts/`.

- [ ] **Step 6: Commit**

```bash
git add playwright.config.ts tests scripts .env.example .gitignore README.md package.json pnpm-lock.yaml
git commit -m "test: verify Codex local web in Chrome"
```

---

## Phase-two follow-up boundary

Phase two begins only after the user permits a Codex Desktop restart. It will add `src/gateway/desktop-transport.ts` behind the existing `CodexTransport` interface, bind CDP to loopback, authenticate the gateway before exposing any renderer event, and add regression tests proving that App Server transport behavior remains unchanged. No phase-one file may assume CDP is present.
