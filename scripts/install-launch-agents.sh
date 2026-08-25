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

# Remove launchd jobs used by releases before the codex-remote rename. A loaded
# job can survive after its plist is deleted, so boot it out by label first.
for legacy_label in local.codex-web.desktop local.codex-web.gateway; do
  "$LAUNCHCTL_BIN" bootout "$DOMAIN/$legacy_label" >/dev/null 2>&1 || true
  /bin/rm -f "$AGENTS/$legacy_label.plist"
done

render() {
  local target=$1 label=$2 keep_alive=$3
  shift 3
  /usr/bin/plutil -create xml1 "$target"
  /usr/bin/plutil -insert Label -string "$label" "$target"
  /usr/bin/plutil -insert RunAtLoad -bool true "$target"
  /usr/bin/plutil -insert KeepAlive -bool "$keep_alive" "$target"
  /usr/bin/plutil -insert ProgramArguments -json '[]' "$target"
  local index=0
  for argument in "$@"; do
    /usr/bin/plutil -insert "ProgramArguments.$index" -string "$argument" "$target"
    index=$((index + 1))
  done
}

render "$APP_PLIST" local.codex-remote.app false "$APP_PATH/Contents/MacOS/Codex Remote"
render "$DESKTOP_PLIST" local.codex-remote.desktop true \
  "$APP_PATH/Contents/Resources/launch-codex-desktop.sh"

for label in local.codex-remote.app local.codex-remote.desktop; do
  "$LAUNCHCTL_BIN" bootout "$DOMAIN/$label" >/dev/null 2>&1 || true
  "$LAUNCHCTL_BIN" bootstrap "$DOMAIN" "$AGENTS/$label.plist"
done
