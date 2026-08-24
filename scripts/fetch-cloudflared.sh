#!/bin/zsh
set -euo pipefail

ARCH=${1:?Usage: fetch-cloudflared.sh <arm64|x86_64> <destination>}
DEST=${2:?Usage: fetch-cloudflared.sh <arm64|x86_64> <destination>}
case "$ARCH" in
  arm64) ASSET=cloudflared-darwin-arm64.tgz ;;
  x86_64) ASSET=cloudflared-darwin-amd64.tgz ;;
  *) print -u2 "Unsupported architecture: $ARCH"; exit 1 ;;
esac

work=$(mktemp -d "${TMPDIR:-/tmp}/codex-remote-cloudflared.XXXXXX")
trap 'rm -rf "$work"' EXIT
/usr/bin/curl -fsSL --proto '=https' --tlsv1.2 \
  https://api.github.com/repos/cloudflare/cloudflared/releases/latest -o "$work/release.json"
metadata=$(/usr/bin/python3 - "$work/release.json" "$ASSET" <<'PY'
import json, sys
release = json.load(open(sys.argv[1]))
asset = next((item for item in release.get("assets", []) if item.get("name") == sys.argv[2]), None)
if not asset or not asset.get("browser_download_url") or not asset.get("digest", "").startswith("sha256:"):
    raise SystemExit("cloudflared release asset or SHA-256 digest not found")
print(asset["browser_download_url"])
print(asset["digest"].split(":", 1)[1])
PY
)
url=${metadata%%$'\n'*}
digest=${metadata##*$'\n'}
/usr/bin/curl -fsSL --proto '=https' --tlsv1.2 "$url" -o "$work/$ASSET"
actual=$(/usr/bin/shasum -a 256 "$work/$ASSET" | /usr/bin/awk '{print $1}')
[[ "$actual" == "$digest" ]] || { print -u2 "cloudflared SHA-256 mismatch"; exit 1; }
/usr/bin/tar -xzf "$work/$ASSET" -C "$work"
mkdir -p "${DEST:h}"
/bin/cp "$work/cloudflared" "$DEST"
/bin/chmod 755 "$DEST"
/usr/bin/file "$DEST" | /usr/bin/grep -q "$ARCH\|x86_64" || { print -u2 "cloudflared architecture mismatch"; exit 1; }
