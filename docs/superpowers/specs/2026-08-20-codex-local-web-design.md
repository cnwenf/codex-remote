# Codex Remote Design

Date: 2026-08-20

## Context

The official Codex Remote experience is too slow for the intended mobile workflow. The replacement should run entirely between a phone browser and this Mac over an existing VPN. It must not configure or depend on a specific VPN product.

The installed Codex Desktop is an Electron application. Its renderer is packaged as HTML and JavaScript, but it depends on Electron preload APIs and cannot run as a standalone browser application. Codex App Server is the supported rich-client protocol and provides conversation history, streamed agent events, approvals, and task control over JSON-RPC.

The current Codex Desktop process cannot be restarted during phase one. Therefore phase one must not modify, inject into, attach to, or interrupt that process.

## Goals

1. Provide a fast, mobile-first web client for Codex on this Mac.
2. List and read persisted Codex threads.
3. Start, resume, steer, interrupt, and observe tasks created through the web client.
4. Stream agent output and status changes without polling.
5. Present approval requests and return approve or deny decisions.
6. Display changed files and diffs when the protocol provides them.
7. Bind locally by default and support access through the user's existing VPN.
8. Keep the transport boundary replaceable so phase two can attach to the live Codex Desktop renderer after a permitted restart.

## Non-goals

- Configuring the user's VPN, DNS, certificates, or router.
- Publishing the service to the public internet.
- Reusing or modifying the signed Codex Desktop application bundle.
- Reproducing every Desktop setting, plugin screen, terminal feature, or native menu in phase one.
- Claiming live control of a task currently owned by the already-running Desktop process in phase one.
- Implementing the undocumented Remote relay or device-pairing protocol in phase one.

## Delivery phases

### Phase one: independent App Server transport

Create the complete web UI, browser-to-gateway protocol, gateway process, tests, and Chrome validation. The gateway starts an independent `codex app-server --listen stdio://` child process using the existing local Codex account and configuration.

This phase can read persisted Desktop thread history. Tasks started or resumed through this App Server instance are fully live in the web client. An active task still owned by the Desktop process is visible only to the extent that its state has been persisted.

### Phase two: live Desktop transport

After the user permits a Desktop restart, launch Codex Desktop with a Chromium DevTools endpoint bound only to loopback. Add a `DesktopTransport` implementation that attaches to the existing renderer and proxies its host message stream. This allows the web client to observe and control the same live task as Desktop without using the official Remote relay.

Phase two must not patch the application bundle. The DevTools endpoint and the web gateway remain loopback-only.

## Architecture

The project is a TypeScript workspace with three independently testable layers:

1. `web`: a React and Vite single-page application optimized for phone screens.
2. `gateway`: a Node.js HTTP and WebSocket server that serves the built web application, authenticates clients, and owns a Codex transport.
3. `protocol`: transport-neutral JSON-RPC types, request correlation, notification reduction, and normalized application state.

```text
Phone Chrome or Safari
        |
        | existing VPN, HTTP(S) + WebSocket
        v
Local Web Gateway
        |
        | authenticated local session
        v
CodexTransport interface
        |
        +-- Phase 1: AppServerTransport -> codex app-server over stdio
        |
        +-- Phase 2: DesktopTransport -> Electron renderer over loopback CDP
```

The UI depends only on `CodexTransport` messages and normalized state. It must not contain App Server child-process logic or Electron-specific code.

## App Server lifecycle

The gateway resolves the Codex binary in this order:

1. `CODEX_BIN` when explicitly configured.
2. `codex` from the gateway's inherited `PATH`.
3. The bundled binary in `/Applications/ChatGPT.app/Contents/Resources/codex` when present.

The gateway launches `codex app-server --listen stdio://` with explicit argument arrays and no shell. Standard input and output carry newline-delimited JSON-RPC messages. Standard error is captured as structured diagnostics with secrets removed.

On startup, the protocol client sends `initialize` and waits for a successful response before accepting browser RPC. The gateway terminates only the child process it created. Unexpected exits produce a visible disconnected state and an explicit restart action; they do not trigger an unbounded automatic restart loop.

## Browser protocol

The browser connects to a gateway WebSocket endpoint. Phase one supports one active controlling browser session. A second connection is rejected with a clear `controller-already-connected` error instead of creating request-ID collisions or ambiguous approvals.

The gateway wraps App Server frames in a small envelope:

- `session`: connection readiness and gateway errors.
- `rpc`: App Server request, response, or notification payload.
- `diagnostic`: redacted, user-safe process diagnostics.

Browser request IDs are mapped to gateway-owned IDs before forwarding. Server-initiated request IDs are mapped back to the controlling browser so approvals can be resolved safely.

The first supported protocol operations are:

- `initialize`
- `thread/list`
- `thread/read`
- `thread/start`
- `thread/resume`
- `turn/start`
- `turn/steer`
- `turn/interrupt`
- relevant thread, turn, item, diff, and status notifications
- server-request resolution for command, file-change, permission, and user-input requests

Unknown notifications are ignored but retained in debug diagnostics. Unknown server requests are denied safely with an unsupported-operation explanation.

## Mobile user interface

The visual language follows Codex Desktop without copying its bundled assets or minified implementation.

The main mobile flow has four surfaces:

1. **Task list**: search, status, project path, updated time, pinned indicator, and a new-task action.
2. **Task view**: streamed conversation timeline with compact tool and reasoning summaries.
3. **Composer**: multiline input with send, steer, and interrupt states.
4. **Review sheet**: approval details, changed files, and unified diff content in a bottom sheet or full-screen mobile panel.

Desktop Chrome uses a two-column layout. Narrow screens use a single-column navigation stack. The interface must support light and dark color schemes, visible focus states, reduced motion, safe-area insets, and touch targets of at least 44 CSS pixels.

The UI is installable as a PWA only after the core online flow works. Offline task mutation is not supported; when disconnected, the UI becomes read-only and shows the last in-memory state.

## Security

- Default bind address is `127.0.0.1`; non-loopback binding requires an explicit `BIND_HOST` value.
- A random capability token is required for every browser WebSocket connection, including VPN connections.
- The token is read from an owner-readable file or environment variable and is never printed, committed, placed in a URL, or stored in browser local storage.
- The browser enters the token once per tab; it is held in memory or session storage only.
- WebSocket Origin is checked against configured allowed origins.
- Child processes are launched without a shell and with fixed executable arguments.
- File paths and command contents are treated as sensitive and excluded from routine gateway logs.
- Approval UI defaults to deny, clearly displays the requested action, and never offers an automatic-approve option.
- Production use over a routed VPN should terminate TLS before the gateway or use a VPN-provided HTTPS endpoint. Plain WebSocket is allowed only for loopback development and Chrome tests.

## Error handling and recovery

- Connection loss retains the visible thread timeline and marks it stale.
- Reconnection creates a new protocol session, reruns `initialize`, refreshes the selected thread, and does not replay mutation requests automatically.
- Request timeouts surface retry actions only for idempotent reads.
- Mutating operations remain in an unknown state after transport loss until refreshed from App Server.
- App Server schema or method mismatches produce an explicit unsupported-version screen rather than silent failure.

## Testing strategy

Implementation follows red-green-refactor.

1. **Protocol unit tests**: request correlation, server-request mapping, notification reduction, timeout behavior, and redaction.
2. **Gateway unit tests**: bind defaults, token authentication, origin checks, single-controller enforcement, binary resolution, and child-process shutdown ownership.
3. **Gateway integration tests**: a fake newline-delimited App Server process verifies initialization, streaming, approvals, malformed messages, and crash handling.
4. **Web component tests**: task list, timeline streaming updates, composer states, approval deny-by-default, diff rendering, and disconnected mode.
5. **Chrome E2E tests**: desktop and mobile viewports cover connection, task selection, streamed output, sending instructions, approval handling, interruption, and reconnection using the fake App Server fixture.
6. **Real App Server smoke test**: start the installed Codex App Server in an isolated temporary working directory, initialize it, list threads, and run one explicitly labeled test task without touching the active Desktop process.

No completion claim is made until unit tests, integration tests, production build, and real Chrome E2E tests all pass in a fresh run.

## Acceptance criteria

- The project lives in its own `codex-remote` Git repository.
- One documented command starts the development gateway and web client.
- Chrome can open the application locally and complete the phase-one end-to-end flow.
- A mobile Chrome viewport is usable without horizontal page scrolling.
- The gateway does not listen beyond loopback unless explicitly configured.
- Unauthenticated and wrong-origin WebSocket clients are rejected.
- An approval request cannot execute without an explicit browser approval.
- Stopping the gateway stops only the App Server child it owns.
- The running Codex Desktop process is not restarted, terminated, patched, or attached during phase one.
- Phase-two live Desktop integration is represented by a stable transport interface and a documented follow-up, not placeholder production behavior.
