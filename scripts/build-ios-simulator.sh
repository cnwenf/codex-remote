#!/bin/zsh
set -euo pipefail

project_root="$(cd "$(dirname "$0")/.." && pwd)"
derived_data="${CODEX_REMOTE_DERIVED_DATA:-$project_root/artifacts/ios-derived-data}"
output_dir="$project_root/artifacts"

mkdir -p "$output_dir"
build_log="$output_dir/ios-simulator-build.log"

set +e
xcodebuild \
  -project "$project_root/ios/App/App.xcodeproj" \
  -scheme App \
  -configuration Release \
  -sdk iphonesimulator \
  -derivedDataPath "$derived_data" \
  CODE_SIGNING_ALLOWED=NO \
  build 2>&1 | tee "$build_log"
build_status=$pipestatus[1]
set -e

if (( build_status != 0 )); then
  error_summary="$(grep -E '(^|[[:space:]])(error:|fatal error:)' "$build_log" | tail -n 12 | tr '\n' ' ' | sed 's/%/%25/g' || true)"
  [[ -n "$error_summary" ]] || error_summary="xcodebuild exited with status $build_status; inspect the uploaded iOS build log"
  print -r -- "::error title=iOS simulator build failed::$error_summary"
  exit "$build_status"
fi

app_path="$derived_data/Build/Products/Release-iphonesimulator/App.app"
test -d "$app_path"
ditto -c -k --keepParent "$app_path" "$output_dir/Codex-Remote-iOS-Simulator.zip"
(cd "$output_dir" && shasum -a 256 Codex-Remote-iOS-Simulator.zip > Codex-Remote-iOS-Simulator.zip.sha256)
