# Codex Remote Parity Design

Date: 2026-08-23

## Outcome

`codex-remote` provides a VPN-only browser control surface for the Codex Desktop instance running on this Mac. When the Desktop bridge is available, the browser and Desktop operate on the same App Server host, thread, active turn, approvals, and configuration. A second App Server remains available only for explicitly web-owned work. SQLite and rollout files are read-only recovery inputs, never the authority for a live mutation.

## Correctness invariant

The browser may claim that it controls a Desktop conversation only when all of the following are true:

1. The bridge is attached to the current Desktop renderer over loopback CDP.
2. Desktop reports its initialized host and protocol version.
3. Requests are sent through Desktop's existing `window.electronBridge.sendMessageFromView` channel with host `local`.
4. The Web view and Desktop agree on the exact `threadId` and active `turnId`.
5. A mutation is acknowledged by Desktop's existing App Server and its resulting notification is visible to both renderers.

If any condition is missing, Desktop-owned conversations are visibly read-only. The gateway must not start another writer against that conversation or infer live state from SQLite.

## Architecture

```text
Phone browser over existing VPN
            |
            | authenticated HTTP and WebSocket
            v
Codex Remote gateway
            |
            +-- Composite transport router
                 |
                 +-- DesktopBridgeTransport
                 |     -> loopback CDP
                 |     -> Desktop renderer electronBridge
                 |     -> Desktop-owned App Server
                 |
                 +-- AppServerTransport
                       -> gateway-owned codex app-server
```

The gateway never exposes CDP or App Server directly. CDP listens on `127.0.0.1`, and only the gateway connects to it. Browser request IDs are replaced with gateway-owned IDs and correlated back to one authenticated controller.

## Desktop bridge

The installed preload exposes two useful primitives:

- `window.electronBridge.sendMessageFromView(message)` sends renderer messages to the Desktop main process.
- Desktop delivers host messages as `window` `message` events.

The Desktop renderer already uses the following envelope:

```ts
{
  type: "mcp-request",
  hostId: "local",
  request: { id, method, params },
  priority: "interactive",
  source: "remote_control"
}
```

Responses use `mcp-response`; notifications and server requests arrive through Desktop's existing message stream. Approval and user-input responses are returned through Desktop's `mcp-response` path, not as ordinary client requests.

`DesktopCdpClient` discovers an eligible renderer from the loopback DevTools endpoint, enables the Runtime domain, installs a named binding, and subscribes to relevant `window.message` events. It invokes the bridge through `Runtime.callFunctionOn` or an equivalent evaluated function with JSON data arguments. The injected listener contains no token or remote network address.

`DesktopBridgeTransport` owns correlation, host filtering, initialization state, version checks, event forwarding, and reconnect behavior. It never patches `app.asar` and never launches or terminates Desktop.

## Protocol compatibility

The gateway inspects the installed application version and the initialized App Server version. A version adapter declares supported request methods, notification shapes, and server-request response shapes. The currently inspected installation requires App Server `0.141.0` or newer and bundles `0.148.0-alpha.15`; these values are observations, not permanent constants.

Unknown notifications may be retained in redacted diagnostics. Unknown mutations and server requests fail closed. A detected incompatible schema produces an explicit unsupported-version state rather than silently falling back to a different writer.

## Ownership and routing

Each normalized thread carries a source:

- `desktop-live`: authoritative Desktop bridge; full control when attached.
- `desktop-cold`: read-only SQLite and rollout projection while the bridge is unavailable.
- `web-live`: gateway-owned App Server; full control through `AppServerTransport`.

Thread-scoped requests route by source. Host-scoped discovery requests may query both transports and are merged without changing source ownership. A Desktop thread must never be resumed by the web-owned transport merely because the bridge disconnected.

## Desktop metadata synchronization

Pin, rename, archive, unarchive, delete, thread settings, model, reasoning effort, approval policy, sandbox policy, cwd, branch, and worktree choices use App Server requests through Desktop when the thread is Desktop-owned. The global-state JSON and SQLite databases are read only for cold projection and ordering recovery.

The Web UI must not maintain a second independent pin list. A pin mutation is successful only after the authoritative Desktop state or corresponding protocol notification reflects it.

## Remote feature surface

The browser surface follows the official Thread -> Turn -> Item model and includes:

- Projects plus direct conversations, search, pin, rename, archive, and run-state indicators.
- New conversation project/cwd, branch or worktree, model, reasoning effort, permission profile, and sandbox/approval settings supported by the installed protocol.
- Turn start, queued follow-up, steer, interrupt, compact, fork, resume, and reconnect.
- Streamed user and assistant messages rendered as GitHub-flavored Markdown without raw HTML execution.
- Aggregated reasoning, command, file change, MCP/tool, search, image, plan/goal, review, compaction, and error items with expandable details.
- Explicit command/file/permission/user-input approvals that default to deny.
- Changed-file list, unified diff, review findings, terminal output, and inline feedback where supplied by the protocol.
- Attachments and installed skills/plugins only when the installed Desktop protocol exposes them safely.

Unavailable features are shown as unavailable for the detected version. They are not simulated locally.

## Browser experience

Desktop Chrome uses a fixed navigation rail and a scrollable conversation column. Mobile uses a navigation stack with independent scrolling for projects, conversation, approvals, and diffs. The composer remains reachable above safe-area insets. Status is shown at project, thread, and active-turn levels.

The layout follows the user's Codex Desktop screenshots: pinned conversations and projects are separate, active states appear beside conversations, and execution events are grouped inside their turn instead of appended as unrelated cards.

## Security

- Default gateway and CDP addresses are loopback only.
- Non-loopback HTTP binding requires explicit configuration and a capability token.
- WebSocket Origin is allowlisted; browser IDs never pass through unchanged.
- One controller is allowed. A second controller is rejected, not downgraded to an ambiguous co-controller.
- Token comparison is constant-time. Tokens are not logged, committed, placed in URLs, or sent to Desktop/CDP.
- Renderer discovery rejects non-Codex pages. CDP methods are limited to the Runtime operations required by the bridge.
- Browser input is treated as untrusted. RPC methods and parameter envelopes are allowlisted per capability manifest.
- Approvals default to deny, time out visibly, and cannot be auto-approved.
- Diagnostics redact tokens, commands, file contents, and sensitive paths.
- The signed app bundle and Desktop databases are never modified directly.

## Restart and recovery contract

No Desktop restart occurs until implementation, unit tests, fake-CDP integration tests, build, and normal Chrome E2E pass. Before the one controlled restart, the repository contains:

1. a committed or otherwise durable checkpoint of all source changes;
2. a restart command that relaunches only the verified Codex application with a loopback DevTools port;
3. a detached, bounded verifier that records bridge health without depending on this conversation continuing;
4. a recovery note containing the branch, test command, verifier output path, and next action.

The restart is successful only when the original Desktop session restores, the bridge reports `desktop-live`, the selected active thread and turn IDs match, and a harmless state read is observed in both Desktop and Web. A live mutation test requires explicit confirmation that the running task can tolerate it.

## Acceptance criteria

- Desktop-owned threads use Desktop's existing App Server writer when the bridge is healthy.
- Disconnecting the bridge makes Desktop threads read-only without starting another writer.
- Pin, rename, archive, configuration, turn control, approvals, and notifications are routed by ownership and reflected by Desktop.
- Projects, direct conversations, run states, Markdown, grouped events, model, effort, and permissions match the authoritative Desktop protocol/state.
- Wrong token, wrong Origin, second controller, unknown mutation, incompatible version, and unknown approval all fail closed.
- Unit, integration, production build, desktop/mobile Chrome E2E, and `git diff --check` pass in a fresh run.
- The final controlled restart does not patch the app and exposes CDP only on loopback.
