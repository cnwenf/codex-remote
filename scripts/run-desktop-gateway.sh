#!/bin/zsh
set -euo pipefail

PROJECT_DIR=${0:A:h:h}
source "$PROJECT_DIR/scripts/runtime-support.sh"
RUNTIME_DIR="$PROJECT_DIR/.runtime"
TOKEN_FILE="$RUNTIME_DIR/token"
NODE_BIN=$(resolve_node_bin)
TSX_CLI="$PROJECT_DIR/node_modules/tsx/dist/cli.mjs"

if (( $# != 6 )); then
  print -u2 "Usage: run-desktop-gateway.sh <cdp-endpoint> <version> <bind-host> <port> <additional-hosts> <origins>"
  exit 2
fi
if [[ ! -r "$TOKEN_FILE" ]]; then
  print -u2 "Gateway token file is missing"
  exit 2
fi

CODEX_WEB_TOKEN=$(<"$TOKEN_FILE")
cd "$PROJECT_DIR"
exec env \
  CODEX_WEB_TOKEN="$CODEX_WEB_TOKEN" \
  CODEX_DESKTOP_CDP_ENDPOINT="$1" \
  CODEX_DESKTOP_APP_SERVER_VERSION="$2" \
  BIND_HOST="$3" \
  PORT="$4" \
  ADDITIONAL_BIND_HOSTS="$5" \
  ALLOWED_ORIGINS="$6" \
  "$NODE_BIN" "$TSX_CLI" src/gateway/index.ts
