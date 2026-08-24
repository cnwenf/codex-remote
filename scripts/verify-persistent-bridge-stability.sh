#!/bin/zsh
set -euo pipefail

OBSERVE_SECONDS=${1:-30}
if [[ ! "$OBSERVE_SECONDS" =~ '^[0-9]+$' ]]; then
  print -u2 "observation time must be a non-negative integer"
  exit 2
fi

PROJECT_DIR=${0:A:h:h}
RUNTIME_DIR=${CODEX_RUNTIME_DIR:-$PROJECT_DIR/.runtime}
INSTALL_LOG="$RUNTIME_DIR/persistent-install.log"
LAUNCHCTL_BIN=${CODEX_LAUNCHCTL_BIN:-/bin/launchctl}
CURL_BIN=${CODEX_CURL_BIN:-/usr/bin/curl}
WEB_PORT=${PORT:-4321}
CDP_PORT=${CODEX_DESKTOP_CDP_PORT:-9229}
DOMAIN="gui/$(id -u)"
INSTALL_LABEL=local.codex-web.install-once
DESKTOP_LABEL=local.codex-web.desktop
GATEWAY_LABEL=local.codex-web.gateway

assert_installer_absent() {
  if "$LAUNCHCTL_BIN" print "$DOMAIN/$INSTALL_LABEL" >/dev/null 2>&1; then
    print -u2 "unsafe installer job is still loaded: $INSTALL_LABEL"
    return 1
  fi
}

job_snapshot() {
  local label=$1
  local output runs pid
  if ! output=$("$LAUNCHCTL_BIN" print "$DOMAIN/$label" 2>&1); then
    print -u2 "persistent job is not loaded: $label"
    return 1
  fi
  runs=$(print -r -- "$output" | awk '$1 == "runs" && $2 == "=" { print $3; exit }')
  pid=$(print -r -- "$output" | awk '$1 == "pid" && $2 == "=" { print $3; exit }')
  if [[ ! "$runs" =~ '^[0-9]+$' || ! "$pid" =~ '^[0-9]+$' ]]; then
    print -u2 "could not read runs and pid for: $label"
    return 1
  fi
  print -r -- "$label:$runs:$pid"
}

install_log_snapshot() {
  if [[ -f "$INSTALL_LOG" ]]; then
    stat -f '%z:%m' "$INSTALL_LOG"
  else
    print "missing"
  fi
}

assert_healthy() {
  "$CURL_BIN" -fsS "http://127.0.0.1:$CDP_PORT/json/version" >/dev/null
  "$CURL_BIN" -fsS "http://127.0.0.1:$WEB_PORT/health" >/dev/null
}

assert_installer_absent
assert_healthy
BEFORE_DESKTOP=$(job_snapshot "$DESKTOP_LABEL")
BEFORE_GATEWAY=$(job_snapshot "$GATEWAY_LABEL")
BEFORE_LOG=$(install_log_snapshot)

sleep "$OBSERVE_SECONDS"

assert_installer_absent
assert_healthy
AFTER_DESKTOP=$(job_snapshot "$DESKTOP_LABEL")
AFTER_GATEWAY=$(job_snapshot "$GATEWAY_LABEL")
AFTER_LOG=$(install_log_snapshot)

if [[ "$BEFORE_DESKTOP" != "$AFTER_DESKTOP" ]]; then
  print -u2 "Desktop LaunchAgent changed during observation: $BEFORE_DESKTOP -> $AFTER_DESKTOP"
  exit 1
fi
if [[ "$BEFORE_GATEWAY" != "$AFTER_GATEWAY" ]]; then
  print -u2 "Gateway LaunchAgent changed during observation: $BEFORE_GATEWAY -> $AFTER_GATEWAY"
  exit 1
fi
if [[ "$BEFORE_LOG" != "$AFTER_LOG" ]]; then
  print -u2 "installer log changed during observation: $BEFORE_LOG -> $AFTER_LOG"
  exit 1
fi

print "Persistent bridge stayed stable for $OBSERVE_SECONDS seconds."
