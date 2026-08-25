#!/usr/bin/env bash
set -euo pipefail

repo_root=$(cd "$(dirname "$0")/.." && pwd)
apk_path=${1:?usage: verify-android-signing.sh APK_PATH [EXPECTED_FINGERPRINT_FILE]}
expected_file=${2:-"$repo_root/android/release-signing-cert.sha256"}

if [[ ! -f "$apk_path" ]]; then
  echo "Android APK not found: $apk_path" >&2
  exit 1
fi
if [[ ! -f "$expected_file" ]]; then
  echo "Expected Android signing fingerprint not found: $expected_file" >&2
  exit 1
fi

apksigner=${APKSIGNER_BIN:-}
if [[ -z "$apksigner" ]] && command -v apksigner >/dev/null 2>&1; then
  apksigner=$(command -v apksigner)
fi
if [[ -z "$apksigner" && -n "${ANDROID_HOME:-}" ]]; then
  apksigner=$(find "$ANDROID_HOME/build-tools" -type f -name apksigner -perm -111 2>/dev/null | sort -V | tail -1)
fi
if [[ -z "$apksigner" || ! -x "$apksigner" ]]; then
  echo "apksigner is unavailable" >&2
  exit 1
fi

verify_output=$("$apksigner" verify --print-certs "$apk_path" 2>&1)
actual=$(printf '%s\n' "$verify_output" \
  | sed -n 's/.*Signer #1 certificate SHA-256 digest:[[:space:]]*//p' \
  | head -1 \
  | tr '[:upper:]' '[:lower:]' \
  | tr -d '[:space:]:')
expected=$(tr '[:upper:]' '[:lower:]' < "$expected_file" | tr -d '[:space:]')

if [[ ! "$expected" =~ ^[0-9a-f]{64}$ ]]; then
  echo "Expected Android signing fingerprint is invalid" >&2
  exit 1
fi
if [[ "$actual" != "$expected" ]]; then
  echo "Android signing certificate mismatch" >&2
  echo "expected: $expected" >&2
  echo "actual:   ${actual:-missing}" >&2
  exit 1
fi

echo "Android signing certificate verified: $actual"
