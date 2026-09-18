#!/bin/zsh
set -euo pipefail

APP_PATH=${CODEX_DESKTOP_APP_PATH:-/Applications/ChatGPT.app}
DESKTOP_BIN="$APP_PATH/Contents/MacOS/ChatGPT"
CDP_PORT=${CODEX_REMOTE_CDP_PORT:-9229}
CDP_ENDPOINT="http://127.0.0.1:$CDP_PORT/json/list"
MODE=${1:---check}
CURL_BIN=${CODEX_REMOTE_CURL_BIN:-/usr/bin/curl}
OPEN_BIN=${CODEX_REMOTE_OPEN_BIN:-/usr/bin/open}
PS_BIN=${CODEX_REMOTE_PS_BIN:-/bin/ps}

[[ "$MODE" == "--check" || "$MODE" == "--execute" || "$MODE" == "--recover" ]] || {
  print -u2 "Usage: restart-codex-desktop.sh [--check|--execute|--recover <pid>]"
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
  "$PS_BIN" -axww -o uid=,pid=,comm= | /usr/bin/awk -v owner="$EUID" -v target="$DESKTOP_BIN" '
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
[[ "$MODE" != "--check" ]] || { print -u2 "Desktop bridge is unavailable"; exit 1; }

if [[ "$MODE" == "--recover" ]]; then
  RECOVERY_PID=${2:-}
  [[ "$RECOVERY_PID" == <-> ]] || { print -u2 "Recovery requires a Desktop PID"; exit 2; }
  # Recheck the exact observed process after the native app's startup grace period.
  # Never reopen an intentionally closed app or restart the replacement process.
  [[ "$(desktop_pids)" == "$RECOVERY_PID" ]] || exit 0
  DESKTOP_ARGUMENTS=$("$PS_BIN" -ww -p "$RECOVERY_PID" -o args=)
  # A debug-enabled replacement that fails to start its bridge needs diagnosis,
  # not another automatic restart. This also prevents restart loops after updates.
  [[ "$DESKTOP_ARGUMENTS" != *" --remote-debugging-port="* &&
     "$DESKTOP_ARGUMENTS" != *" --remote-debugging-port "* ]] || exit 0
fi

stopped_target=false
if desktop_running; then
  # The user requested a restart or automatic recovery. A normal quit can open Desktop's
  # own confirmation dialog, which cannot be answered from the phone.
  # Match only this user's exact main executable, including paths with spaces.
  for pid in ${(f)"$(desktop_pids)"}; do
    [[ "$MODE" != "--recover" || "$pid" == "$RECOVERY_PID" ]] || continue
    if /bin/kill -KILL "$pid" 2>/dev/null; then stopped_target=true; fi
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

[[ "$MODE" != "--recover" || "$stopped_target" == true ]] || exit 0

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
