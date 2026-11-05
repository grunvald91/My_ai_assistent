#!/usr/bin/env bash
# Offline test: a real terminal report, not an acknowledgement, creates one GitHub comment.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
temp="$(mktemp -d)"
trap 'rm -rf "$temp"' EXIT
mkdir -p "$temp/bin" "$temp/state"
export DSH_MULTI_REPO_STATE_DIR="$temp/state"
export DSH_SUPERAGENT_URL="http://127.0.0.1:9999"
export COMMENT_LOG="$temp/post.log"
cat > "$temp/bin/curl" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
for arg; do url="$arg"; done
case "$url" in
 *'tickets?state=open&limit=100&offset=0') echo '{"items":[{"id":"abc123","stage":"person"}]}' ;;
 *'tickets?state=open&limit=100&offset=1') echo '{"items":[]}' ;;
 *'tickets?state=ended&limit=100&offset=0') echo '{"items":[]}' ;;
 *'/tickets/abc123') echo '{"channels":[{"url":"https://github.com/grunvald91/Ai_growth_os/issues/300"}],"assignments":[{"report":{"state":"ready","summary":"PR: https://github.com/grunvald91/booking_bot/pull/17","at":"2026-11-05T15:00:00Z"}}]}' ;;
 *) echo "Unexpected API $url" >&2; exit 4 ;;
esac
MOCK
cat > "$temp/bin/gh" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == api ]] || exit 90
case "$2" in
  repos/grunvald91/Ai_growth_os/issues/300)
    echo '{"user":{"login":"grunvald91"},"body":"<!-- superagent-route:v1 repo=grunvald91/booking_bot -->\n@Grunvald1991"}' ;;
  repos/grunvald91/Ai_growth_os/issues/300/comments)
    [[ "$3" == '--method' && "$4" == 'POST' ]] || exit 91
    printf '%s\n' "$5" >> "$COMMENT_LOG" ;;
  'repos/grunvald91/Ai_growth_os/issues/300/comments?per_page=100') echo '[]' ;;
  *) echo "Unexpected gh API $2" >&2; exit 92 ;;
esac
MOCK
chmod +x "$temp/bin/gh" "$temp/bin/curl"
export PATH="$temp/bin:$PATH"
bash "$ROOT/scripts/superagent-terminal-relay.sh" >/dev/null
[[ "$(wc -l < "$COMMENT_LOG")" -eq 1 ]]
grep -q 'superagent-result:v1 issue=300 state=ready' "$COMMENT_LOG"
grep -q 'superagent-relay:v1 report=' "$COMMENT_LOG"
bash "$ROOT/scripts/superagent-terminal-relay.sh" >/dev/null
[[ "$(wc -l < "$COMMENT_LOG")" -eq 1 ]]
echo 'Superagent terminal relay: report signal and idempotency OK'
