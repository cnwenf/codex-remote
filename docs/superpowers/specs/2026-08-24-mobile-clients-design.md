# Codex Remote Mobile Clients Design

## Status

Approved by the user's direct implementation request on 2026-08-24.

## Goals

- Ship Android and iPhone clients from the existing React Web application instead of maintaining a second conversation UI.
- Let users add, select, edit, and remove multiple Codex Remote connections.
- Store every connection token in the platform credential store rather than Web storage, source files, logs, or URLs.
- Restore the last connection and selected task when the app is reopened.
- Show currently running tasks while the device is locked and notify when a task completes.
- Open the matching connection and task when a notification or `codex-remote://` link is tapped.
- Keep the browser application and macOS application behavior unchanged.
- Fix two existing Web regressions in the same release: hide a fully completed Todo dock and reconcile optimistic steer messages with Desktop's authoritative live message.
- Produce repeatable Android and iOS build artifacts through GitHub Actions.

## Non-goals and Platform Boundaries

- The mobile client does not expose the Mac to the public Internet or configure the user's VPN.
- Plain HTTP is accepted only because the product is intended for a user-managed private network. HTTPS remains supported and recommended.
- An unsigned iOS build cannot be installed on a physical iPhone. Device distribution and guaranteed background completion delivery require an Apple Developer signing identity and APNs credentials.
- iOS does not permit an arbitrary app to keep a WebSocket or polling loop alive indefinitely after lock. Without APNs, the client uses best-effort system background refresh and refreshes immediately when foregrounded.
- Android uses a standard foreground-service notification for active monitoring. It does not misuse Android promoted Live Updates, which are not intended for chat messages.

## Shared Application Architecture

Capacitor wraps the existing Vite/React bundle for both Android and iOS. The same `App`, timeline, composer, approvals, Todo dock, Markdown renderer, attachments, and WebSocket client run on Web, Android, and iOS.

Native code is limited to capabilities that a browser cannot safely or reliably provide:

- platform credential storage;
- background task-status refresh;
- Android foreground service and notification updates;
- iOS background refresh scheduling;
- local notifications and notification actions;
- custom-scheme deep-link delivery.

The Web build keeps the current same-origin cookie login. The native build starts at a connection manager and creates a token-authenticated WebSocket directly against the selected remote.

## Connection Model

Non-secret metadata is represented as:

```text
RemoteConnection {
  id
  name
  baseUrl
  lastUsedAt
}
```

The token is keyed by connection ID in Android Keystore-backed encrypted preferences and iOS Keychain. It is never returned in connection-list snapshots and is only passed to the socket or native background monitor when needed.

URLs must be `http:` or `https:`, must not contain username/password credentials, query strings, or fragments, and are normalized without a trailing slash. The add/edit form verifies `/health` and authentication before saving. Editing a remote replaces the saved secret atomically.

## Mobile Status Contract

The gateway adds an authenticated, read-only `GET /api/mobile/status` endpoint. It accepts the existing HttpOnly session cookie for browsers or `Authorization: Bearer <token>` for native background requests and returns only bounded task metadata:

```json
{
  "version": 1,
  "generatedAt": 0,
  "threads": [
    { "id": "...", "title": "...", "status": "running", "updatedAt": 0 }
  ]
}
```

The response never includes messages, prompts, filesystem content, model output, settings, tokens, or uploaded images. The gateway derives it from the same authoritative Desktop state used by the Web task list.

The native monitor compares each refresh with the last stored status. A `running -> idle|error` transition produces one completion notification. Stable states are idempotent and do not repeat notifications.

## Android Lifecycle

When at least one task is running, the app starts an explicit foreground service. The service periodically calls the bounded mobile-status endpoint for the selected connection and maintains one ongoing notification that lists the running-task count and titles. The notification remains visible on the lock screen and in the notification shade, subject to the user's notification privacy settings.

Each task and completion notification carries a `PendingIntent` with a `codex-remote://connection/<connection-id>/thread/<thread-id>` deep link. Tapping it launches the existing activity, selects the connection, reconnects, and opens that task.

Android 13+ notification permission is requested in context. If permission is denied, foreground UI monitoring still works and the connection screen explains that lock-screen completion notifications are disabled.

## iOS Lifecycle

The app maintains live WebSocket state while foregrounded. When it enters the background, it schedules a `BGAppRefreshTask` and stores the last known running tasks. Each allowed refresh calls the bounded status endpoint, updates local state, emits completion notifications, and schedules the next refresh.

Notification taps use the same custom deep-link model as Android. The app processes both cold-start URLs and runtime URL events.

This best-effort mode cannot guarantee immediate completion notifications while locked. The native/gateway interfaces reserve APNs registration and event fields so a later signed build can add push delivery without replacing the React application or connection model. The README states this boundary explicitly.

## Todo and Live Message Corrections

The Todo dock is present only while at least one item is `pending` or `inProgress`. Once the authoritative plan reports every item `completed`, it is removed on desktop and mobile layouts.

For a running task, Web inserts one optimistic user message before `turn/steer` returns. When Desktop emits the authoritative `item/started` or `item/completed` user message, the reducer matches the oldest same-turn optimistic message with the same normalized text, removes that optimistic ID, and inserts the authoritative ID in the same position. Uploaded image IDs are retained until the authoritative snapshot contains them. This makes the live view stable without waiting for polling or refresh.

## Deep Links and Navigation

The canonical link is:

```text
codex-remote://connection/<connection-id>/thread/<thread-id>
```

The parser rejects malformed paths and unknown connection IDs. A valid link changes the selected connection, establishes authentication, refreshes the thread list, and selects the requested task. If the connection is temporarily unavailable, the app keeps the requested task pending and exposes an explicit retry instead of silently opening another task.

## Security

- Native secrets use Keychain/Keystore-backed storage and never `localStorage`.
- Mobile status requests use authorization headers, never URL parameters.
- The status endpoint is read-only, bounded, authenticated, non-cacheable, and rate-limited per source address.
- Notification text contains only user-visible task titles and can be hidden by OS lock-screen privacy controls.
- Release workflows do not embed test addresses, usernames, credentials, Apple signing materials, or local absolute paths.
- Android network-security configuration permits cleartext only for user-entered private-network hosts; iOS ATS exceptions are limited to local networking.

## Release Artifacts

The release workflow publishes:

- existing macOS ARM64 DMG and checksum;
- an installable Android ARM64 debug APK for direct GitHub distribution, plus SHA-256;
- an iOS Simulator `.app.zip`, plus SHA-256;
- an optional signed iPhone IPA only when the repository is configured with Apple signing and APNs secrets.

The version is shared across `package.json`, Android, iOS, macOS packaging, and release notes.

## Verification

- Unit tests cover URL validation, connection CRUD, credential API boundaries, deep links, status transitions, notification deduplication, completed Todo hiding, and live optimistic-message reconciliation.
- Gateway tests cover authentication, response minimization, method restrictions, rate limiting, and no secret leakage.
- Playwright covers browser desktop and phone viewports, completed Todo removal, steer-message single rendering, connection-manager navigation, and notification deep-link routing through a native adapter fixture.
- Android tests cover service lifecycle, ongoing-notification content, permission fallback, transition notifications, and deep-link intents.
- iOS tests cover Keychain storage, background refresh transition logic, local notifications, and deep-link restoration.
- CI builds all available artifacts from a clean checkout, verifies checksums, and scans tracked files and packages for secrets and local private data.
