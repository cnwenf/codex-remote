#!/bin/zsh
set -euo pipefail

project_root="$(cd "$(dirname "$0")/.." && pwd)"
derived_data="${CODEX_REMOTE_DERIVED_DATA:-$project_root/artifacts/ios-derived-data}"
output_dir="$project_root/artifacts"

mkdir -p "$output_dir"
xcodebuild \
  -project "$project_root/ios/App/App.xcodeproj" \
  -scheme App \
  -configuration Release \
  -sdk iphonesimulator \
  -derivedDataPath "$derived_data" \
  CODE_SIGNING_ALLOWED=NO \
  build

app_path="$derived_data/Build/Products/Release-iphonesimulator/App.app"
test -d "$app_path"
ditto -c -k --keepParent "$app_path" "$output_dir/Codex-Remote-iOS-Simulator.zip"
(cd "$output_dir" && shasum -a 256 Codex-Remote-iOS-Simulator.zip > Codex-Remote-iOS-Simulator.zip.sha256)
