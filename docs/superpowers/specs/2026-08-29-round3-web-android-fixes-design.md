# Round 3 Web and Android Fixes Design

## Goal

Fix the six failures reproduced against the released 0.5.21 Web and Android clients without regressing idle progress, image upload, queue ordering, or cross-client synchronization.

## Approved behavior

- Uploaded images open in an in-app preview that preserves the active conversation.
- Only valid HTTP(S) conversation links are interactive. Invalid, relative, executable, and file-style links render as text.
- Android delegates valid HTTP(S), including APK downloads, to the system browser and surfaces native failures in the current UI.
- User-visible message text removes Codex attachment envelopes and local absolute paths while preserving the ordinary prompt and authenticated image references.
- Queue promotion never clicks Desktop DOM controls. While a turn is active it uses the Desktop thread-owner steer RPC; after Stop or an idle race it starts a new turn. The queued item is removed exactly once and restored only when delivery fails.
- The gateway accepts PNG, JPEG, GIF, and WebP only when the uploaded bytes match the declared format. Corrupt or spoofed files return a clear upload failure and never create a user message.
- Android/Web acceptance uses an isolated test gateway/port and must not stop or replace the App-managed production gateway on port 4321.

## Evidence and release gate

- Each behavior starts with a focused failing test and finishes with that test passing.
- Run `pnpm check`, production build, Playwright, Android unit/build checks, Web interaction, and Android emulator interaction.
- Re-run client-to-Web and Web-to-client image synchronization, image preview, valid/invalid links, queue promotion, Stop with queued work, task progress, disconnect/reconnect, and exactly-once assertions.
- Release versions must align across package.json, Android, iOS, and tag.
- A release is complete only after official assets are downloaded and independently verified.
