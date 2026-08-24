#!/bin/zsh
set -euo pipefail
ROOT=${0:A:h:h}
VERSION=${VERSION:-$(node -p "require('$ROOT/package.json').version")}
OUTPUT=${OUTPUT_DIR:-$ROOT/artifacts}
APP="$OUTPUT/Codex Remote.app"
RES="$APP/Contents/Resources"
NODE_SOURCE=${CODEX_REMOTE_NODE_BIN:-/Applications/ChatGPT.app/Contents/Resources/cua_node/bin/node}

[[ $(uname -m) == arm64 ]] || { print -u2 "ARM64 build host required"; exit 1; }
[[ -x $NODE_SOURCE ]] || { print -u2 "ARM64 Node runtime not found"; exit 1; }
file "$NODE_SOURCE" | grep -q arm64 || { print -u2 "Node runtime is not ARM64"; exit 1; }

cd "$ROOT"
pnpm build
node_modules/.pnpm/esbuild@0.28.1/node_modules/esbuild/bin/esbuild src/gateway/index.ts \
  --bundle --platform=node --format=esm --target=node24 --outfile="$OUTPUT/gateway.mjs"
swift build --package-path macos/CodexRemoteApp -c release --arch arm64

rm -rf "$APP"
mkdir -p "$APP/Contents/MacOS" "$RES/bin" "$RES/gateway" "$RES/web"
cp "macos/CodexRemoteApp/.build/arm64-apple-macosx/release/CodexRemoteApp" "$APP/Contents/MacOS/Codex Remote"
cp "$NODE_SOURCE" "$RES/bin/node"
cp "$OUTPUT/gateway.mjs" "$RES/gateway/index.mjs"
cp -R dist/. "$RES/web/"
cp scripts/launch-bundled-gateway.sh "$RES/launch-gateway.sh"
cp scripts/install-launch-agents.sh "$RES/install-launch-agents.sh"
cp scripts/launch-codex-desktop.sh "$RES/launch-codex-desktop.sh"
chmod 755 "$RES"/*.sh "$RES/bin/node" "$APP/Contents/MacOS/Codex Remote"

iconset="$OUTPUT/AppIcon.iconset"
rm -rf "$iconset"; mkdir -p "$iconset"
for size in 16 32 128 256 512; do
  sips -z "$size" "$size" assets/app-icon.png --out "$iconset/icon_${size}x${size}.png" >/dev/null
  double=$((size * 2)); sips -z "$double" "$double" assets/app-icon.png --out "$iconset/icon_${size}x${size}@2x.png" >/dev/null
done
iconutil -c icns "$iconset" -o "$RES/AppIcon.icns"
sips -z 36 36 assets/app-icon.png --out "$RES/MenuIcon.png" >/dev/null

plutil -create xml1 "$APP/Contents/Info.plist"
plutil -insert CFBundleIdentifier -string com.cnwenf.codex-remote "$APP/Contents/Info.plist"
plutil -insert CFBundleName -string "Codex Remote" "$APP/Contents/Info.plist"
plutil -insert CFBundleDisplayName -string "Codex Remote" "$APP/Contents/Info.plist"
plutil -insert CFBundleExecutable -string "Codex Remote" "$APP/Contents/Info.plist"
plutil -insert CFBundleIconFile -string AppIcon "$APP/Contents/Info.plist"
plutil -insert CFBundleShortVersionString -string "$VERSION" "$APP/Contents/Info.plist"
plutil -insert CFBundleVersion -string "$VERSION" "$APP/Contents/Info.plist"
plutil -insert LSMinimumSystemVersion -string 13.0 "$APP/Contents/Info.plist"
codesign --force --deep --sign - "$APP"
codesign --verify --deep --strict "$APP"
print "$APP"
