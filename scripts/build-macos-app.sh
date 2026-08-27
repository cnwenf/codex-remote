#!/bin/zsh
set -euo pipefail
ROOT=${0:A:h:h}
VERSION=${VERSION:-$(node -p "require('$ROOT/package.json').version")}
OUTPUT=${OUTPUT_DIR:-$ROOT/artifacts}
APP="$OUTPUT/Codex Remote.app"
RES="$APP/Contents/Resources"
NODE_SOURCE=${CODEX_REMOTE_NODE_BIN:-/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node}
MACOS_ARCH=${MACOS_ARCH:-$(uname -m)}
CLOUDFLARED_SOURCE=${CODEX_REMOTE_CLOUDFLARED_BIN:-}

[[ "$MACOS_ARCH" == arm64 || "$MACOS_ARCH" == x86_64 ]] || { print -u2 "Unsupported macOS architecture"; exit 1; }
[[ -x $NODE_SOURCE ]] || { print -u2 "$MACOS_ARCH Node runtime not found"; exit 1; }
file "$NODE_SOURCE" | grep -q "$MACOS_ARCH" || { print -u2 "Node runtime is not $MACOS_ARCH"; exit 1; }

cd "$ROOT"
mkdir -p "$OUTPUT"
pnpm build
pnpm exec esbuild src/gateway/index.ts \
  --bundle --platform=node --format=esm --target=node24 \
  --banner:js="import { createRequire } from 'node:module'; const require = createRequire(import.meta.url);" \
  --outfile="$OUTPUT/gateway.mjs"
swift build --package-path macos/CodexRemoteApp -c release --arch "$MACOS_ARCH"
SWIFT_BIN=$(swift build --package-path macos/CodexRemoteApp -c release --arch "$MACOS_ARCH" --show-bin-path)

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$RES/bin" "$RES/gateway" "$RES/web"
cp "$SWIFT_BIN/CodexRemoteApp" "$APP/Contents/MacOS/Codex Remote"
cp "$NODE_SOURCE" "$RES/bin/node"
if [[ -n "$CLOUDFLARED_SOURCE" ]]; then cp "$CLOUDFLARED_SOURCE" "$RES/bin/cloudflared"; chmod 755 "$RES/bin/cloudflared"; fi
cp "$OUTPUT/gateway.mjs" "$RES/gateway/index.mjs"
cp -R dist/. "$RES/web/"
cp scripts/launch-bundled-gateway.sh "$RES/launch-gateway.sh"
cp scripts/install-launch-agents.sh "$RES/install-launch-agents.sh"
cp scripts/launch-codex-desktop.sh "$RES/launch-codex-desktop.sh"
cp scripts/restart-codex-desktop.sh "$RES/restart-codex-desktop.sh"
cp scripts/perform-macos-update.sh "$RES/perform-macos-update.sh"
cp assets/app-icon.png "$RES/MenuBarIcon.png"
print "$VERSION" > "$RES/VERSION"
chmod 755 "$RES"/*.sh "$RES/bin/node" "$APP/Contents/MacOS/Codex Remote"

iconset="$OUTPUT/AppIcon.iconset"
rm -rf "$iconset"; mkdir -p "$iconset"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" assets/app-icon.png --out "$iconset/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2)); sips -z "$double" "$double" assets/app-icon.png --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$iconset" -o "$RES/AppIcon.icns"

plutil -create xml1 "$APP/Contents/Info.plist"
plutil -insert CFBundleIdentifier -string com.cnwenf.codex-remote "$APP/Contents/Info.plist"
plutil -insert CFBundleName -string "Codex Remote" "$APP/Contents/Info.plist"
plutil -insert CFBundleDisplayName -string "Codex Remote" "$APP/Contents/Info.plist"
plutil -insert CFBundleExecutable -string "Codex Remote" "$APP/Contents/Info.plist"
plutil -insert CFBundlePackageType -string APPL "$APP/Contents/Info.plist"
plutil -insert CFBundleIconFile -string AppIcon "$APP/Contents/Info.plist"
plutil -insert CFBundleShortVersionString -string "$VERSION" "$APP/Contents/Info.plist"
plutil -insert CFBundleVersion -string "$VERSION" "$APP/Contents/Info.plist"
plutil -insert LSMinimumSystemVersion -string 13.0 "$APP/Contents/Info.plist"
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"
print "$APP"
