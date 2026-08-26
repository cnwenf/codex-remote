#!/bin/zsh
set -euo pipefail

if (( $# != 7 )); then
  print -u2 "Usage: render-persistent-launch-agents.sh <output-dir> <project-dir> <app-path> <node-bin> <bind-host> <web-port> <cdp-port>"
  exit 2
fi

OUTPUT_DIR=$1
PROJECT_DIR=$2
APP_PATH=$3
NODE_BIN=$4
BIND_HOST=$5
WEB_PORT=$6
CDP_PORT=$7

if [[ "$OUTPUT_DIR" != /* || "$PROJECT_DIR" != /* || "$APP_PATH" != /* || "$NODE_BIN" != /* ]]; then
  print -u2 "output, project, app, and Node paths must be absolute"
  exit 2
fi
if [[ ! "$BIND_HOST" =~ '^([0-9]{1,3}\.){3}[0-9]{1,3}$' ]]; then
  print -u2 "bind host must be an IPv4 address"
  exit 2
fi
for octet in ${(s:.:)BIND_HOST}; do
  if (( octet < 0 || octet > 255 )); then
    print -u2 "bind host must be an IPv4 address"
    exit 2
  fi
done
for port in "$WEB_PORT" "$CDP_PORT"; do
  if [[ ! "$port" =~ '^[0-9]+$' ]] || (( port < 1024 || port > 65535 )); then
    print -u2 "ports must be integers between 1024 and 65535"
    exit 2
  fi
done

mkdir -p "$OUTPUT_DIR"
DESKTOP_PLIST="$OUTPUT_DIR/local.codex-web.desktop.plist"
GATEWAY_PLIST="$OUTPUT_DIR/local.codex-web.gateway.plist"
RUNTIME_DIR="$PROJECT_DIR/.runtime"

create_plist() {
  local plist_path=$1
  rm -f "$plist_path"
  plutil -create xml1 "$plist_path"
}

insert_argument() {
  local plist_path=$1
  local index=$2
  local value=$3
  plutil -insert "ProgramArguments.$index" -string "$value" "$plist_path"
}

create_plist "$DESKTOP_PLIST"
plutil -insert Label -string "local.codex-web.desktop" "$DESKTOP_PLIST"
plutil -insert ProgramArguments -json '[]' "$DESKTOP_PLIST"
insert_argument "$DESKTOP_PLIST" 0 "$PROJECT_DIR/scripts/launch-codex-desktop.sh"
plutil -insert EnvironmentVariables -json '{}' "$DESKTOP_PLIST"
plutil -insert EnvironmentVariables.CODEX_DESKTOP_APP_PATH -string "$APP_PATH" "$DESKTOP_PLIST"
plutil -insert EnvironmentVariables.CODEX_REMOTE_CDP_PORT -string "$CDP_PORT" "$DESKTOP_PLIST"
plutil -insert RunAtLoad -bool YES "$DESKTOP_PLIST"
plutil -insert KeepAlive -bool NO "$DESKTOP_PLIST"
plutil -insert LimitLoadToSessionType -string "Aqua" "$DESKTOP_PLIST"
plutil -insert ProcessType -string "Interactive" "$DESKTOP_PLIST"
plutil -insert ThrottleInterval -integer 10 "$DESKTOP_PLIST"
plutil -insert AssociatedBundleIdentifiers -json '["com.openai.codex"]' "$DESKTOP_PLIST"
plutil -insert StandardOutPath -string "$RUNTIME_DIR/desktop-agent.log" "$DESKTOP_PLIST"
plutil -insert StandardErrorPath -string "$RUNTIME_DIR/desktop-agent.err.log" "$DESKTOP_PLIST"

create_plist "$GATEWAY_PLIST"
plutil -insert Label -string "local.codex-web.gateway" "$GATEWAY_PLIST"
plutil -insert ProgramArguments -json '[]' "$GATEWAY_PLIST"
insert_argument "$GATEWAY_PLIST" 0 "$PROJECT_DIR/scripts/run-persistent-gateway.sh"
insert_argument "$GATEWAY_PLIST" 1 "$APP_PATH"
insert_argument "$GATEWAY_PLIST" 2 "$NODE_BIN"
insert_argument "$GATEWAY_PLIST" 3 "$BIND_HOST"
insert_argument "$GATEWAY_PLIST" 4 "$WEB_PORT"
insert_argument "$GATEWAY_PLIST" 5 "$CDP_PORT"
plutil -insert RunAtLoad -bool YES "$GATEWAY_PLIST"
plutil -insert KeepAlive -bool YES "$GATEWAY_PLIST"
plutil -insert LimitLoadToSessionType -string "Aqua" "$GATEWAY_PLIST"
plutil -insert ProcessType -string "Interactive" "$GATEWAY_PLIST"
plutil -insert ThrottleInterval -integer 10 "$GATEWAY_PLIST"
plutil -insert StandardOutPath -string "$RUNTIME_DIR/gateway.log" "$GATEWAY_PLIST"
plutil -insert StandardErrorPath -string "$RUNTIME_DIR/gateway.err.log" "$GATEWAY_PLIST"

plutil -lint "$DESKTOP_PLIST" "$GATEWAY_PLIST" >/dev/null
chmod 600 "$DESKTOP_PLIST" "$GATEWAY_PLIST"
