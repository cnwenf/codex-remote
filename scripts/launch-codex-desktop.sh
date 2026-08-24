#!/bin/zsh
set -euo pipefail
APP_PATH=${CODEX_DESKTOP_APP_PATH:-/Applications/ChatGPT.app}
exec "$APP_PATH/Contents/MacOS/ChatGPT" \
  --remote-debugging-address=127.0.0.1 \
  --remote-debugging-port=9229
