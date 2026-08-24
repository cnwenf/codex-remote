#!/bin/zsh
set -euo pipefail

APP_PATH=${1:?Usage: install-launch-agents.sh <app-path>}
UID_VALUE=$(id -u)
DOMAIN="gui/$UID_VALUE"
LAUNCHCTL_BIN=${CODEX_LAUNCHCTL_BIN:-/bin/launchctl}
AGENTS="$HOME/Library/LaunchAgents"
APP_PLIST="$AGENTS/local.codex-remote.app.plist"
DESKTOP_PLIST="$AGENTS/local.codex-remote.desktop.plist"
mkdir -p "$AGENTS"

render() {
  local target=$1 label=$2
  shift 2
  /usr/bin/plutil -create xml1 "$target"
  /usr/bin/plutil -insert Label -string "$label" "$target"
  /usr/bin/plutil -insert RunAtLoad -bool true "$target"
  /usr/bin/plutil -insert KeepAlive -bool true "$target"
  /usr/bin/plutil -insert ProgramArguments -json '[]' "$target"
  local index=0
  for argument in "$@"; do
    /usr/bin/plutil -insert "ProgramArguments.$index" -string "$argument" "$target"
    index=$((index + 1))
  done
}

render "$APP_PLIST" local.codex-remote.app "$APP_PATH/Contents/MacOS/Codex Remote"
render "$DESKTOP_PLIST" local.codex-remote.desktop \
  "$APP_PATH/Contents/Resources/launch-codex-desktop.sh"

for label in local.codex-remote.app local.codex-remote.desktop; do
  "$LAUNCHCTL_BIN" bootout "$DOMAIN/$label" >/dev/null 2>&1 || true
  "$LAUNCHCTL_BIN" bootstrap "$DOMAIN" "$AGENTS/$label.plist"
done
