#!/bin/zsh
set -euo pipefail

APP_PATH=${CODEX_DESKTOP_APP_PATH:-/Applications/ChatGPT.app}
DESKTOP_BIN="$APP_PATH/Contents/MacOS/ChatGPT"
CDP_PORT=${CODEX_REMOTE_CDP_PORT:-9229}
CDP_ENDPOINT="http://127.0.0.1:$CDP_PORT/json/list"
MODE=${1:---check}
CURL_BIN=${CODEX_REMOTE_CURL_BIN:-/usr/bin/curl}
OPEN_BIN=${CODEX_REMOTE_OPEN_BIN:-/usr/bin/open}

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
  "$CURL_BIN" -fsS --max-time 2 "$CDP_ENDPOINT" >/dev/null 2>&1
}

desktop_pids() {
  /bin/ps -axww -o uid=,pid=,comm= | /usr/bin/awk -v owner="$EUID" -v target="$DESKTOP_BIN" '
    {
      uid = $1; pid = $2
      sub(/^[[:space:]]*[0-9]+[[:space:]]+[0-9]+[[:space:]]+/, "")
      if (uid == owner && $0 == target) print pid
    }
  '
}

desktop_running() {
  [[ -n "$(desktop_pids)" ]]
}

if bridge_ready; then
  print "Desktop bridge is ready"
  exit 0
fi
[[ "$MODE" == "--execute" ]] || { print -u2 "Desktop bridge is unavailable"; exit 1; }

if desktop_running; then
  # The remote user has already confirmed. A normal quit can open Desktop's
  # own confirmation dialog, which cannot be answered from the phone.
  # Match only this user's exact main executable, including paths with spaces.
  for pid in ${(f)"$(desktop_pids)"}; do
    /bin/kill -KILL "$pid" 2>/dev/null || true
  done
  for _ in {1..80}; do
    desktop_running || break
    /bin/sleep 0.25
  done
  if desktop_running; then
    # The existing login launcher may have reopened Desktop before us.
    bridge_ready && { print "Desktop bridge is ready"; exit 0; }
    print -u2 "Codex Desktop could not be stopped"
    exit 1
  fi
fi

"$OPEN_BIN" -na "$APP_PATH" --args \
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
