#!/bin/zsh
set -euo pipefail
APP_PATH=${CODEX_DESKTOP_APP_PATH:-/Applications/ChatGPT.app}
DESKTOP_BIN="$APP_PATH/Contents/MacOS/ChatGPT"
PS_BIN=${CODEX_REMOTE_PS_BIN:-/bin/ps}
WAIT_SECONDS=${CODEX_REMOTE_DESKTOP_WAIT_SECONDS:-1}
CDP_PORT=${CODEX_REMOTE_CDP_PORT:-9229}

desktop_is_running() {
  "$PS_BIN" -axo command= | /usr/bin/awk -v target="$DESKTOP_BIN" '
    $1 == target { found = 1 }
    END { exit found ? 0 : 1 }
  '
}

# Installing or upgrading Remote must not repeatedly activate an already-open
# Desktop app. Wait for the user's current process to exit, then start one
# debug-enabled instance. The LaunchAgent itself is deliberately not KeepAlive.
while desktop_is_running; do
  /bin/sleep "$WAIT_SECONDS"
done

exec "$DESKTOP_BIN" \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port="$CDP_PORT"
