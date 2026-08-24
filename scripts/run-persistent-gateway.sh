#!/bin/zsh
set -euo pipefail

if (( $# != 5 )); then
  print -u2 "Usage: run-persistent-gateway.sh <app-path> <node-bin> <bind-host> <web-port> <cdp-port>"
  exit 2
fi

PROJECT_DIR=${0:A:h:h}
APP_PATH=$1
NODE_BIN=$2
BIND_HOST=$3
WEB_PORT=$4
CDP_PORT=$5
CURL_BIN=${CODEX_CURL_BIN:-/usr/bin/curl}
RUN_GATEWAY_SCRIPT=${CODEX_RUN_GATEWAY_SCRIPT:-$PROJECT_DIR/scripts/run-desktop-gateway.sh}
CDP_ENDPOINT="http://127.0.0.1:$CDP_PORT"

if [[ ! -x "$APP_PATH/Contents/Resources/codex" ]]; then
  print -u2 "Bundled Codex executable is missing"
  exit 2
fi
if [[ ! -x "$NODE_BIN" ]]; then
  print -u2 "Node.js runtime is missing"
  exit 2
fi

ready=false
for _ in {1..120}; do
  if "$CURL_BIN" -fsS "$CDP_ENDPOINT/json/list" >/dev/null 2>&1; then
    ready=true
    break
  fi
  sleep 0.5
done
if [[ "$ready" != true ]]; then
  print -u2 "Codex Desktop DevTools endpoint did not become ready"
  exit 1
fi

CODEX_VERSION=$(
  "$APP_PATH/Contents/Resources/codex" --version |
    sed -E 's/^codex-cli[[:space:]]+//'
)
if [[ -z "$CODEX_VERSION" ]]; then
  print -u2 "Could not resolve the bundled Codex version"
  exit 1
fi

ADDITIONAL_HOSTS=""
ALLOWED_ORIGINS="http://$BIND_HOST:$WEB_PORT"
if [[ "$BIND_HOST" != "127.0.0.1" ]]; then
  ADDITIONAL_HOSTS="127.0.0.1"
  ALLOWED_ORIGINS="$ALLOWED_ORIGINS,http://127.0.0.1:$WEB_PORT"
fi

exec env CODEX_NODE_BIN="$NODE_BIN" "$RUN_GATEWAY_SCRIPT" \
  "$CDP_ENDPOINT" "$CODEX_VERSION" "$BIND_HOST" "$WEB_PORT" \
  "$ADDITIONAL_HOSTS" "$ALLOWED_ORIGINS"
