#!/bin/zsh
set -euo pipefail

PROJECT_DIR=${0:A:h:h}
source "$PROJECT_DIR/scripts/runtime-support.sh"

MODE=${1:---status}
APP_PATH=${CODEX_DESKTOP_APP_PATH:-/Applications/ChatGPT.app}
WEB_BIND_HOST=${BIND_HOST:-127.0.0.1}
WEB_PORT=${PORT:-4321}
CDP_PORT=${CODEX_DESKTOP_CDP_PORT:-9229}
LAUNCH_AGENTS_DIR=${CODEX_LAUNCH_AGENTS_DIR:-$HOME/Library/LaunchAgents}
RUNTIME_DIR="$PROJECT_DIR/.runtime"
TOKEN_FILE="$RUNTIME_DIR/token"
DESKTOP_LABEL=local.codex-web.desktop
GATEWAY_LABEL=local.codex-web.gateway
DESKTOP_PLIST="$LAUNCH_AGENTS_DIR/$DESKTOP_LABEL.plist"
GATEWAY_PLIST="$LAUNCH_AGENTS_DIR/$GATEWAY_LABEL.plist"
LAUNCHCTL_BIN=${CODEX_LAUNCHCTL_BIN:-/bin/launchctl}
CURL_BIN=${CODEX_CURL_BIN:-/usr/bin/curl}
OSASCRIPT_BIN=${CODEX_OSASCRIPT_BIN:-/usr/bin/osascript}
OPEN_BIN=${CODEX_OPEN_BIN:-/usr/bin/open}
DOMAIN="gui/$(id -u)"

usage() {
  print -u2 "Usage: scripts/persistent-bridge.sh [--dry-run|--install|--status|--uninstall]"
}

job_loaded() {
  "$LAUNCHCTL_BIN" print "$DOMAIN/$1" >/dev/null 2>&1
}

bootout_job() {
  local label=$1
  if job_loaded "$label"; then
    "$LAUNCHCTL_BIN" bootout "$DOMAIN/$label"
  fi
}

desktop_running() {
  ps -axo command= | desktop_process_is_running "$APP_PATH/Contents/MacOS/ChatGPT"
}

wait_for_url() {
  local url=$1
  local attempts=${2:-120}
  for _ in {1..$attempts}; do
    if "$CURL_BIN" -fsS "$url" >/dev/null 2>&1; then
      return 0
    fi
    sleep 0.5
  done
  return 1
}

case "$MODE" in
  --status)
    if job_loaded "$DESKTOP_LABEL"; then
      print "Desktop LaunchAgent: loaded"
    else
      print "Desktop LaunchAgent: not loaded"
    fi
    if job_loaded "$GATEWAY_LABEL"; then
      print "Gateway LaunchAgent: loaded"
    else
      print "Gateway LaunchAgent: not loaded"
    fi
    if "$CURL_BIN" -fsS "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null 2>&1; then
      print "Desktop DevTools: ready on loopback"
    else
      print "Desktop DevTools: unavailable"
    fi
    if "$CURL_BIN" -fsS "http://127.0.0.1:$WEB_PORT/health" >/dev/null 2>&1; then
      print "Web gateway: healthy"
    else
      print "Web gateway: unavailable"
    fi
    exit 0
    ;;
  --uninstall)
    bootout_job "$GATEWAY_LABEL"
    bootout_job "$DESKTOP_LABEL"
    rm -f "$GATEWAY_PLIST" "$DESKTOP_PLIST"
    if [[ -x "$APP_PATH/Contents/MacOS/ChatGPT" ]]; then
      "$OPEN_BIN" -na "$APP_PATH"
    fi
    print "Persistent bridge removed. Codex Desktop was reopened normally."
    exit 0
    ;;
  --dry-run|--install) ;;
  *)
    usage
    exit 2
    ;;
esac

if [[ -z "${CODEX_NODE_BIN:-}" && -x "$APP_PATH/Contents/Resources/cua_node/bin/node" ]]; then
  NODE_BIN="$APP_PATH/Contents/Resources/cua_node/bin/node"
else
  NODE_BIN=$(resolve_node_bin)
fi
TSX_CLI="$PROJECT_DIR/node_modules/tsx/dist/cli.mjs"
if [[ ! -x "$APP_PATH/Contents/MacOS/ChatGPT" ]]; then
  print -u2 "Codex Desktop executable is missing"
  exit 2
fi
if [[ ! -x "$APP_PATH/Contents/Resources/codex" ]]; then
  print -u2 "Bundled codex executable is missing"
  exit 2
fi
if [[ ! -x "$NODE_BIN" || ! -f "$TSX_CLI" ]]; then
  print -u2 "Workspace Node/tsx runtime is missing; run pnpm install first"
  exit 2
fi

TEMP_DIR=$(mktemp -d "${TMPDIR:-/tmp}/codex-remote-launch-agents.XXXXXX")
trap 'rm -rf "$TEMP_DIR"' EXIT
"$PROJECT_DIR/scripts/render-persistent-launch-agents.sh" \
  "$TEMP_DIR" "$PROJECT_DIR" "$APP_PATH" "$NODE_BIN" \
  "$WEB_BIND_HOST" "$WEB_PORT" "$CDP_PORT"

print "Desktop: persistent, DevTools limited to 127.0.0.1:$CDP_PORT"
print "Web: http://$WEB_BIND_HOST:$WEB_PORT"
if [[ "$WEB_BIND_HOST" != "127.0.0.1" ]]; then
  print "Local Web: http://127.0.0.1:$WEB_PORT"
fi

if [[ "$MODE" == "--dry-run" ]]; then
  print "Dry run passed; no LaunchAgents were changed."
  exit 0
fi

mkdir -p "$RUNTIME_DIR" "$LAUNCH_AGENTS_DIR"
chmod 700 "$RUNTIME_DIR"
if [[ ! -f "$TOKEN_FILE" ]]; then
  umask 077
  openssl rand -hex 24 > "$TOKEN_FILE"
fi
chmod 600 "$TOKEN_FILE"

bootout_job "$GATEWAY_LABEL"
bootout_job "$DESKTOP_LABEL"

if desktop_running; then
  "$OSASCRIPT_BIN" -e 'tell application id "com.openai.codex" to quit'
  for _ in {1..80}; do
    desktop_running || break
    sleep 0.25
  done
  if desktop_running; then
    print -u2 "Codex Desktop did not quit cleanly; no forced termination was used"
    exit 1
  fi
fi

if ! wait_for_tcp_port_release "$WEB_PORT" 40 0.25; then
  print -u2 "Port $WEB_PORT is still in use; stop the old gateway and retry"
  exit 1
fi
if ! wait_for_tcp_port_release "$CDP_PORT" 40 0.25; then
  print -u2 "Port $CDP_PORT is still in use; stop the old Desktop process and retry"
  exit 1
fi

/bin/cp "$TEMP_DIR/$DESKTOP_LABEL.plist" "$DESKTOP_PLIST"
/bin/cp "$TEMP_DIR/$GATEWAY_LABEL.plist" "$GATEWAY_PLIST"
chmod 600 "$DESKTOP_PLIST" "$GATEWAY_PLIST"
plutil -lint "$DESKTOP_PLIST" "$GATEWAY_PLIST" >/dev/null

"$LAUNCHCTL_BIN" bootstrap "$DOMAIN" "$DESKTOP_PLIST"
if ! wait_for_url "http://127.0.0.1:$CDP_PORT/json/list" 120; then
  print -u2 "Desktop LaunchAgent loaded, but DevTools did not become ready"
  exit 1
fi

"$LAUNCHCTL_BIN" bootstrap "$DOMAIN" "$GATEWAY_PLIST"
if ! wait_for_url "http://127.0.0.1:$WEB_PORT/health" 120; then
  print -u2 "Gateway LaunchAgent loaded, but its health check failed"
  exit 1
fi

print "Persistent Desktop bridge and Web gateway are healthy."
print "Use scripts/persistent-bridge.sh --status to check them."
