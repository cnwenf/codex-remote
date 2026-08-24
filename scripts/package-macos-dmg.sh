#!/bin/zsh
set -euo pipefail
ROOT=${0:A:h:h}
OUTPUT=${OUTPUT_DIR:-$ROOT/artifacts}
VERSION=${VERSION:-$(node -p "require('$ROOT/package.json').version")}
VERSION="$VERSION" OUTPUT_DIR="$OUTPUT" "$ROOT/scripts/build-macos-app.sh"
staging=$(mktemp -d "${TMPDIR:-/tmp}/codex-remote-dmg.XXXXXX")
trap 'rm -rf "$staging"' EXIT
cp -R "$OUTPUT/Codex Remote.app" "$staging/"
ln -s /Applications "$staging/Applications"
DMG="$OUTPUT/Codex-Remote-arm64.dmg"
rm -f "$DMG" "$DMG.sha256"
hdiutil create -volname "Codex Remote" -srcfolder "$staging" -ov -format UDZO "$DMG"
(cd "$OUTPUT" && shasum -a 256 "${DMG:t}" > "${DMG:t}.sha256")
print "$DMG"
