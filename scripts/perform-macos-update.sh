#!/bin/zsh
set -euo pipefail

pid=${1:?missing current pid}
current_app=${2:?missing current app}
staged_app=${3:?missing staged app}
expected_version=${4:?missing expected version}
work=${staged_app:h}
backup="$work/Codex Remote.backup.app"
log_dir="$HOME/Library/Logs/Codex Remote"
ready_file="$HOME/Library/Application Support/Codex Remote/update-ready"
mkdir -p "$log_dir"
exec >>"$log_dir/update.log" 2>&1

for _ in {1..120}; do
  kill -0 "$pid" 2>/dev/null || break
  sleep 0.25
done
kill -0 "$pid" 2>/dev/null && { print "Timed out waiting for Codex Remote to quit"; exit 1; }

rm -f "$ready_file"
mv "$current_app" "$backup"
if ! /usr/bin/ditto "$staged_app" "$current_app" || ! /usr/bin/codesign --verify --deep --strict "$current_app"; then
  rm -rf "$current_app"
  mv "$backup" "$current_app"
  /usr/bin/open "$current_app"
  exit 1
fi

/usr/bin/open "$current_app"
for _ in {1..120}; do
  if [[ -f "$ready_file" ]] && [[ "$(<"$ready_file")" == "$expected_version" ]]; then
    rm -rf "$backup" "$work"
    exit 0
  fi
  sleep 0.25
done

/usr/bin/pkill -x "Codex Remote" 2>/dev/null || true
rm -rf "$current_app"
mv "$backup" "$current_app"
/usr/bin/open "$current_app"
print "New version did not report readiness; restored previous app"
exit 1
