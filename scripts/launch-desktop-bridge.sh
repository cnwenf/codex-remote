#!/bin/zsh
set -euo pipefail

PROJECT_DIR=${0:A:h:h}
source "$PROJECT_DIR/scripts/runtime-support.sh"
APP_PATH=${CODEX_DESKTOP_APP_PATH:-/Applications/ChatGPT.app}
CDP_PORT=${CODEX_DESKTOP_CDP_PORT:-9229}
WEB_PORT=${PORT:-4321}
WEB_BIND_HOST=${BIND_HOST:-127.0.0.1}
ADDITIONAL_BIND_HOSTS=""
HEALTH_HOST="$WEB_BIND_HOST"
if [[ "$WEB_BIND_HOST" != "127.0.0.1" ]]; then
  ADDITIONAL_BIND_HOSTS=127.0.0.1
  HEALTH_HOST=127.0.0.1
fi
QUIT_MODE=${CODEX_DESKTOP_QUIT_MODE:-normal}
GATEWAY_MODE=${CODEX_DESKTOP_GATEWAY_MODE:-process}
RUNTIME_DIR="$PROJECT_DIR/.runtime"
TOKEN_FILE="$RUNTIME_DIR/token"
GATEWAY_LOG="$RUNTIME_DIR/gateway.log"
GATEWAY_ERR_LOG="$RUNTIME_DIR/gateway.err.log"
GATEWAY_PID_FILE="$RUNTIME_DIR/gateway.pid"
EVIDENCE_FILE="$RUNTIME_DIR/desktop-bridge-evidence.json"
NODE_BIN=$(resolve_node_bin)
TSX_CLI="$PROJECT_DIR/node_modules/tsx/dist/cli.mjs"
MODE=${1:---dry-run}

desktop_running() {
  ps -axo command= | desktop_process_is_running "$APP_PATH/Contents/MacOS/ChatGPT"
}

if [[ "$MODE" != "--dry-run" && "$MODE" != "--execute" ]]; then
  print -u2 "Usage: scripts/launch-desktop-bridge.sh [--dry-run|--execute]"
  exit 2
fi
if [[ "$QUIT_MODE" != "normal" && "$QUIT_MODE" != "term" ]]; then
  print -u2 "CODEX_DESKTOP_QUIT_MODE must be normal or term"
  exit 2
fi
if [[ "$GATEWAY_MODE" != "process" ]]; then
  print -u2 "The transient launchd mode was removed; use scripts/persistent-bridge.sh --install"
  exit 2
fi
if [[ ! -x "$APP_PATH/Contents/MacOS/ChatGPT" ]]; then
  print -u2 "Codex Desktop executable is missing"
  exit 2
fi
if [[ ! -x "$APP_PATH/Contents/Resources/codex" ]]; then
  print -u2 "Bundled codex executable is missing"
  exit 2
fi
if [[ ! -x "$NODE_BIN" || ! -f "$TSX_CLI" ]]; then
  print -u2 "Workspace Node/tsx runtime is missing"
  exit 2
fi
if ! [[ "$CDP_PORT" =~ '^[0-9]+$' ]] || (( CDP_PORT < 1024 || CDP_PORT > 65535 )); then
  print -u2 "CODEX_DESKTOP_CDP_PORT must be between 1024 and 65535"
  exit 2
fi
if ! [[ "$WEB_PORT" =~ '^[0-9]+$' ]] || (( WEB_PORT < 1024 || WEB_PORT > 65535 )); then
  print -u2 "PORT must be between 1024 and 65535"
  exit 2
fi

CODEX_VERSION=$(
  "$APP_PATH/Contents/Resources/codex" --version |
    sed -E 's/^codex-cli[[:space:]]+//'
)
CDP_ENDPOINT="http://127.0.0.1:$CDP_PORT"
ALLOWED_ORIGIN="http://$WEB_BIND_HOST:$WEB_PORT"
ALLOWED_ORIGINS="$ALLOWED_ORIGIN"
if [[ -n "$ADDITIONAL_BIND_HOSTS" ]]; then
  ALLOWED_ORIGINS="$ALLOWED_ORIGINS,http://$ADDITIONAL_BIND_HOSTS:$WEB_PORT"
fi

print "App: $APP_PATH"
print "App Server: $CODEX_VERSION"
print "DevTools: $CDP_ENDPOINT (loopback only)"
print "Web: $ALLOWED_ORIGIN"
if [[ -n "$ADDITIONAL_BIND_HOSTS" ]]; then
  print "Local Web: http://$ADDITIONAL_BIND_HOSTS:$WEB_PORT"
fi
print "Mode: $MODE"
print "Quit: $QUIT_MODE"
print "Gateway: $GATEWAY_MODE"

if [[ "$MODE" == "--dry-run" ]]; then
  desktop_running || print "Warning: Codex Desktop is not currently running"
  lsof -nP -iTCP:"$CDP_PORT" -sTCP:LISTEN >/dev/null 2>&1 && {
    print -u2 "DevTools port $CDP_PORT is already in use"
    exit 2
  }
  print "Dry run passed; Desktop was not changed."
  exit 0
fi

mkdir -p "$RUNTIME_DIR"
chmod 700 "$RUNTIME_DIR"
if [[ ! -f "$TOKEN_FILE" ]]; then
  umask 077
  openssl rand -hex 24 > "$TOKEN_FILE"
fi
chmod 600 "$TOKEN_FILE"
CODEX_WEB_TOKEN=$(<"$TOKEN_FILE")

if [[ -f "$GATEWAY_PID_FILE" ]]; then
  OLD_GATEWAY_PID=$(<"$GATEWAY_PID_FILE")
  if [[ "$OLD_GATEWAY_PID" =~ '^[0-9]+$' ]] && kill -0 "$OLD_GATEWAY_PID" 2>/dev/null; then
    kill -TERM "$OLD_GATEWAY_PID"
    for _ in {1..20}; do
      kill -0 "$OLD_GATEWAY_PID" 2>/dev/null || break
      sleep 0.25
    done
  fi
fi

rm -f "$EVIDENCE_FILE"
nohup "$NODE_BIN" "$TSX_CLI" "$PROJECT_DIR/scripts/verify-desktop-bridge.ts" \
  --endpoint "$CDP_ENDPOINT" \
  --app-server-version "$CODEX_VERSION" \
  --output "$EVIDENCE_FILE" \
  --timeout-ms 90000 \
  > "$RUNTIME_DIR/verifier.log" 2>&1 &
VERIFIER_PID=$!
print "$VERIFIER_PID" > "$RUNTIME_DIR/verifier.pid"

if [[ "$QUIT_MODE" == "term" ]]; then
  DESKTOP_PID=$(
    ps -axo pid=,command= | awk -v target="$APP_PATH/Contents/MacOS/ChatGPT" '
      $2 == target { print $1 }
    '
  )
  if [[ ! "$DESKTOP_PID" =~ '^[0-9]+$' ]]; then
    print -u2 "Could not resolve exactly one Codex Desktop main process"
    exit 1
  fi
  print "Sending SIGTERM to Codex Desktop main process $DESKTOP_PID"
  kill -TERM "$DESKTOP_PID"
else
  osascript -e 'tell application id "com.openai.codex" to quit'
fi
for _ in {1..80}; do
  desktop_running || break
  sleep 0.25
done
if desktop_running; then
  print -u2 "Codex Desktop did not quit cleanly; no forced termination was used"
  exit 1
fi

open -na "$APP_PATH" --args \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port="$CDP_PORT"

CDP_READY=0
for _ in {1..120}; do
  if curl -fsS "$CDP_ENDPOINT/json/list" >/dev/null 2>&1; then
    CDP_READY=1
    break
  fi
  sleep 0.5
done
if (( CDP_READY == 0 )); then
  print -u2 "Codex Desktop restarted, but the loopback DevTools endpoint did not become ready"
  exit 1
fi

cd "$PROJECT_DIR"
nohup env \
  CODEX_WEB_TOKEN="$CODEX_WEB_TOKEN" \
  CODEX_DESKTOP_CDP_ENDPOINT="$CDP_ENDPOINT" \
  CODEX_DESKTOP_APP_SERVER_VERSION="$CODEX_VERSION" \
  BIND_HOST="$WEB_BIND_HOST" \
  ADDITIONAL_BIND_HOSTS="$ADDITIONAL_BIND_HOSTS" \
  PORT="$WEB_PORT" \
  ALLOWED_ORIGINS="$ALLOWED_ORIGINS" \
  "$NODE_BIN" "$TSX_CLI" src/gateway/index.ts \
  > "$GATEWAY_LOG" 2>&1 &
print $! > "$GATEWAY_PID_FILE"

WEB_READY=0
for _ in {1..60}; do
  if curl -fsS "http://$HEALTH_HOST:$WEB_PORT/health" >/dev/null 2>&1; then
    WEB_READY=1
    break
  fi
  sleep 0.5
done
if (( WEB_READY == 0 )); then
  print -u2 "Desktop bridge is up, but the Web gateway did not become healthy"
  exit 1
fi

if ! wait "$VERIFIER_PID"; then
  print -u2 "Desktop bridge verifier failed; see $RUNTIME_DIR/verifier.log"
  exit 1
fi

print "Desktop bridge and Web gateway are healthy."
print "Evidence: $EVIDENCE_FILE"
print "Token file: $TOKEN_FILE"
