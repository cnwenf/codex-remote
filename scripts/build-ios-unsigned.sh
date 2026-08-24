#!/bin/zsh
set -euo pipefail

project_root="$(cd "$(dirname "$0")/.." && pwd)"
derived_data="${CODEX_REMOTE_DERIVED_DATA:-$project_root/artifacts/ios-device-derived-data}"
output_dir="$project_root/artifacts"
payload_dir="$derived_data/Payload"

mkdir -p "$output_dir" "$payload_dir"
xcodebuild \
  -project "$project_root/ios/App/App.xcodeproj" \
  -scheme App \
  -configuration Release \
  -sdk iphoneos \
  -derivedDataPath "$derived_data" \
  CODE_SIGNING_ALLOWED=NO \
  build

app_path="$derived_data/Build/Products/Release-iphoneos/App.app"
test -d "$app_path"
ditto "$app_path" "$payload_dir/Codex Remote.app"
(cd "$derived_data" && zip -qry "$output_dir/Codex-Remote-iOS-unsigned.ipa" Payload)
(cd "$output_dir" && shasum -a 256 Codex-Remote-iOS-unsigned.ipa > Codex-Remote-iOS-unsigned.ipa.sha256)
