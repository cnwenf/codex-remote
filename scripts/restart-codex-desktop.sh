#!/bin/zsh
set -euo pipefail

APP_PATH=${CODEX_DESKTOP_APP_PATH:-/Applications/ChatGPT.app}
DESKTOP_BIN="$APP_PATH/Contents/MacOS/ChatGPT"
CDP_PORT=${CODEX_REMOTE_CDP_PORT:-9229}
CDP_ENDPOINT="http://127.0.0.1:$CDP_PORT/json/list"
MODE=${1:---check}

[[ "$MODE" == "--check" || "$MODE" == "--execute" ]] || {
  print -u2 "Usage: restart-codex-desktop.sh [--check|--execute]"
  exit 2
}
[[ -x "$DESKTOP_BIN" ]] || { print -u2 "Codex Desktop executable is missing"; exit 2; }
[[ "$CDP_PORT" == <-> ]] && (( CDP_PORT >= 1024 && CDP_PORT <= 65535 )) || {
  print -u2 "Invalid Desktop debug port"
  exit 2
}

bridge_ready() {
  /usr/bin/curl -fsS --max-time 2 "$CDP_ENDPOINT" >/dev/null 2>&1
}

desktop_running() {
  /bin/ps -axo command= | /usr/bin/awk -v target="$DESKTOP_BIN" '
    $1 == target { found = 1 }
    END { exit found ? 0 : 1 }
  '
}

if bridge_ready; then
  print "Desktop bridge is ready"
  exit 0
fi
[[ "$MODE" == "--execute" ]] || { print -u2 "Desktop bridge is unavailable"; exit 1; }

if desktop_running; then
  /usr/bin/osascript -e 'tell application id "com.openai.codex" to quit'
  for _ in {1..80}; do
    desktop_running || break
    /bin/sleep 0.25
  done
  desktop_running && { print -u2 "Codex Desktop did not quit cleanly"; exit 1; }
fi

/usr/bin/open -na "$APP_PATH" --args \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port="$CDP_PORT"

for _ in {1..120}; do
  if bridge_ready; then
    print "Desktop bridge is ready"
    exit 0
  fi
  /bin/sleep 0.5
done
print -u2 "Codex Desktop restarted, but the loopback bridge did not become ready"
exit 1
