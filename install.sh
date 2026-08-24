#!/bin/sh
set -eu

REPOSITORY="cnwenf/codex-remote"
ASSET="Codex-Remote-arm64.dmg"
BASE_URL="https://github.com/$REPOSITORY/releases/latest/download"
work_dir=""
mount_point=""
echo_disabled=false
cleanup() {
  if [ "$echo_disabled" = true ]; then stty echo </dev/tty 2>/dev/null || true; fi
  if [ -n "$mount_point" ]; then hdiutil detach "$mount_point" -quiet >/dev/null 2>&1 || true; fi
  if [ -n "$work_dir" ]; then rm -rf "$work_dir"; fi
}
trap cleanup EXIT HUP INT TERM

[ "$(uname -s)" = "Darwin" ] || { echo "Codex Remote only supports macOS." >&2; exit 1; }
[ "$(uname -m)" = "arm64" ] || { echo "This installer requires an Apple Silicon Mac." >&2; exit 1; }
[ -r /dev/tty ] || { echo "An interactive terminal is required." >&2; exit 1; }

addresses=$(ifconfig | awk '/^[a-z0-9]+:/{iface=$1; sub(":$", "", iface)} /inet / && $2 != "127.0.0.1" && $2 !~ /^169\.254\./ {print iface " " $2}')
[ -n "$addresses" ] || { echo "No usable private IPv4 address found." >&2; exit 1; }

echo "Select the Mac private IPv4 address Codex Remote should use:" >/dev/tty
index=1
echo "$addresses" | while IFS= read -r address; do echo "  $index) $address" >/dev/tty; index=$((index + 1)); done
printf "Choice: " >/dev/tty
IFS= read -r choice </dev/tty
bind_host=$(echo "$addresses" | sed -n "${choice}p" | awk '{print $2}')
[ -n "$bind_host" ] || { echo "Invalid address selection." >&2; exit 1; }

printf "Web login password: " >/dev/tty
stty -echo </dev/tty
echo_disabled=true
IFS= read -r token </dev/tty
stty echo </dev/tty
echo_disabled=false
printf "\n" >/dev/tty
[ -n "$token" ] || { echo "Password cannot be empty." >&2; exit 1; }

work_dir=$(mktemp -d "${TMPDIR:-/tmp}/codex-remote.XXXXXX")
mount_point="$work_dir/mount"

curl -fL --proto '=https' --tlsv1.2 "$BASE_URL/$ASSET" -o "$work_dir/$ASSET"
curl -fL --proto '=https' --tlsv1.2 "$BASE_URL/$ASSET.sha256" -o "$work_dir/$ASSET.sha256"
(cd "$work_dir" && shasum -a 256 -c "$ASSET.sha256")

mkdir -p "$mount_point"
hdiutil attach "$work_dir/$ASSET" -nobrowse -readonly -mountpoint "$mount_point" -quiet
codesign --verify --deep --strict "$mount_point/Codex Remote.app"
file "$mount_point/Codex Remote.app/Contents/MacOS/Codex Remote" | grep -q arm64
install_root="/Applications"
[ -w "$install_root" ] || install_root="$HOME/Applications"
mkdir -p "$install_root"
rm -rf "$install_root/Codex Remote.app"
ditto "$mount_point/Codex Remote.app" "$install_root/Codex Remote.app"

support="$HOME/Library/Application Support/Codex Remote"
mkdir -p "$support"
chmod 700 "$support"
tmp_token="$support/.token.$$"
umask 077
printf '%s' "$token" > "$tmp_token"
mv "$tmp_token" "$support/token"
chmod 600 "$support/token"
defaults write "$support/config" BindHost -string "$bind_host"
defaults write "$support/config" Port -int 4321
defaults write "$support/config" RemoteEnabled -bool true

"$install_root/Codex Remote.app/Contents/Resources/install-launch-agents.sh" "$install_root/Codex Remote.app"
open "$install_root/Codex Remote.app"

echo "Codex Remote installed."
echo "Open: http://$bind_host:4321"
echo "Login password: $token"
echo "Quit and reopen Codex Desktop once to enable its local bridge."
