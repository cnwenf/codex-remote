#!/bin/zsh
set -euo pipefail
RESOURCES=${0:A:h}
BIND_HOST=${1:-127.0.0.1}
PORT=${2:-4321}
APP_PATH=${CODEX_DESKTOP_APP_PATH:-/Applications/ChatGPT.app}
CDP_ENDPOINT=http://127.0.0.1:9229
TOKEN_FILE=${ACCESS_TOKEN_FILE:-$HOME/Library/Application Support/Codex Remote/token}
PID_FILE=${CODEX_REMOTE_GATEWAY_PID_FILE:-$HOME/Library/Application Support/Codex Remote/gateway.pid}
DIAGNOSTIC_FILE=${CODEX_REMOTE_DIAGNOSTIC_FILE:-$HOME/Library/Logs/Codex Remote/gateway-diagnostics.log}

if [[ -f "$PID_FILE" ]]; then
  OLD_PID=$(<"$PID_FILE")
  if [[ "$OLD_PID" == <-> ]] && /bin/kill -0 "$OLD_PID" >/dev/null 2>&1; then
    OLD_COMMAND=$(/bin/ps -p "$OLD_PID" -o command= 2>/dev/null || true)
    if [[ "$OLD_COMMAND" == *"$RESOURCES/gateway/index.mjs"* ]]; then
      /bin/kill -TERM "$OLD_PID"
      for _ in {1..30}; do
        /bin/kill -0 "$OLD_PID" >/dev/null 2>&1 || break
        sleep 0.1
      done
      /bin/kill -0 "$OLD_PID" >/dev/null 2>&1 && {
        print -u2 "The previous bundled gateway did not stop"
        exit 1
      }
    fi
  fi
fi
umask 077
print -r -- "$$" > "$PID_FILE.tmp"
/bin/mv -f "$PID_FILE.tmp" "$PID_FILE"

CODEX_VERSION=$("$APP_PATH/Contents/Resources/codex" --version | /usr/bin/sed -E 's/^codex-cli[[:space:]]+//')
ADDITIONAL_HOSTS=""
ORIGINS="http://$BIND_HOST:$PORT"
if [[ "$BIND_HOST" != 127.0.0.1 ]]; then
  ADDITIONAL_HOSTS=127.0.0.1
  ORIGINS="$ORIGINS,http://127.0.0.1:$PORT"
fi
exec env \
  ACCESS_TOKEN_FILE="$TOKEN_FILE" \
  BIND_HOST="$BIND_HOST" PORT="$PORT" \
  ADDITIONAL_BIND_HOSTS="$ADDITIONAL_HOSTS" ALLOWED_ORIGINS="$ORIGINS" \
  CODEX_DESKTOP_CDP_ENDPOINT="$CDP_ENDPOINT" \
  CODEX_DESKTOP_APP_SERVER_VERSION="$CODEX_VERSION" \
  CODEX_REMOTE_DIAGNOSTIC_FILE="$DIAGNOSTIC_FILE" \
  CODEX_REMOTE_DESKTOP_RESTART_SCRIPT="$RESOURCES/restart-codex-desktop.sh" \
  STATIC_DIR="$RESOURCES/web" \
  "$RESOURCES/bin/node" "$RESOURCES/gateway/index.mjs"
