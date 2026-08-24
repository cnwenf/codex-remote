#!/bin/zsh

resolve_node_bin() {
  local candidate
  if [[ -n "${CODEX_NODE_BIN:-}" && -x "$CODEX_NODE_BIN" ]]; then
    print -r -- "$CODEX_NODE_BIN"
    return 0
  fi

  candidate=$(command -v node 2>/dev/null || true)
  if [[ -n "$candidate" && -x "$candidate" ]]; then
    print -r -- "$candidate"
    return 0
  fi

  for candidate in \
    "$HOME/.cache/codex-runtimes/codex-primary-runtime/dependencies/node/bin/node" \
    "/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node"
  do
    if [[ -x "$candidate" ]]; then
      print -r -- "$candidate"
      return 0
    fi
  done

  print -u2 "Could not locate an executable Node.js runtime"
  return 1
}

desktop_process_is_running() {
  local target=$1
  awk -v target="$target" '
    $1 == target { found = 1 }
    END { exit found ? 0 : 1 }
  '
}

wait_for_tcp_port_release() {
  local port=$1
  local max_attempts=${2:-40}
  local interval_seconds=${3:-0.25}

  for (( attempt = 1; attempt <= max_attempts; attempt++ )); do
    if ! lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then
      return 0
    fi
    sleep "$interval_seconds"
  done
  return 1
}
