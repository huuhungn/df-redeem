#!/usr/bin/env bash
# chrome-up.sh — start an isolated Chrome for CDP verification.
#
# Never touches the user's real profile: a throwaway --user-data-dir under the
# scratch area, so cookies, sessions and extensions of the everyday browser are
# untouched. Port 9333 is what every tools/*.js script attaches to.
set -euo pipefail

PORT="${1:-9333}"
PROFILE="${TMPDIR:-/tmp}/df-ext-test"
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
[ -x "$CHROME" ] || CHROME="/c/Program Files (x86)/Google/Chrome/Application/chrome.exe"

if curl -sf "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; then
  echo "already up on ${PORT}"
  exit 0
fi

mkdir -p "$PROFILE"
"$CHROME" \
  --user-data-dir="$(cygpath -w "$PROFILE" 2>/dev/null || echo "$PROFILE")" \
  --remote-debugging-port="$PORT" \
  --no-first-run --no-default-browser-check \
  --disable-features=Translate,OptimizationHints \
  about:blank >/dev/null 2>&1 &

for _ in $(seq 1 40); do
  if curl -sf "http://127.0.0.1:${PORT}/json/version" >/dev/null 2>&1; then
    echo "chrome up on ${PORT} (profile: ${PROFILE})"
    exit 0
  fi
  sleep 0.5
done
echo "chrome did not expose ${PORT} in 20s" >&2
exit 1
