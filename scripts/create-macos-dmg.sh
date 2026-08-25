#!/bin/zsh
set -euo pipefail

if (( $# != 2 )); then
  print -u2 "usage: create-macos-dmg.sh <staging-directory> <target.dmg>"
  exit 64
fi

staging=$1
target=$2
hdiutil_bin=${CODEX_REMOTE_HDIUTIL_BIN:-/usr/bin/hdiutil}
max_attempts=${CODEX_REMOTE_DMG_MAX_ATTEMPTS:-3}
retry_delay=${CODEX_REMOTE_DMG_RETRY_DELAY_SECONDS:-2}
target_dir=${target:h}
target_name=${target:t}
log_file=$(mktemp "${TMPDIR:-/tmp}/codex-remote-hdiutil.XXXXXX")

cleanup() {
  local -a partials
  partials=("$target_dir/.$target_name".partial-*.dmg(N))
  /bin/rm -f "$log_file" "${partials[@]}"
}
trap cleanup EXIT

if [[ ! -d "$staging" ]]; then
  print -u2 "DMG staging directory does not exist: $staging"
  exit 66
fi

/bin/mkdir -p "$target_dir"
/bin/rm -f "$target"

attempt=1
while (( attempt <= max_attempts )); do
  partial="$target_dir/.$target_name.partial-$$-$attempt.dmg"
  /bin/rm -f "$partial"

  if "$hdiutil_bin" create \
    -volname "Codex Remote" \
    -srcfolder "$staging" \
    -ov \
    -format UDZO \
    "$partial" >"$log_file" 2>&1; then
    /bin/mv "$partial" "$target"
    print "Created $target"
    exit 0
  fi

  /bin/cat "$log_file" >&2
  if ! /usr/bin/grep -q "Resource busy" "$log_file" || (( attempt == max_attempts )); then
    exit 1
  fi

  print -u2 "hdiutil was temporarily busy; retrying DMG creation ($attempt/$max_attempts)"
  /bin/sleep "$retry_delay"
  attempt=$((attempt + 1))
done

exit 1
