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
export COMMENT_BODY="$temp/body.txt"
export MOCK_ISSUE_JSON="$temp/large-issue.json"
python3 - <<'PY'
import json, os
body = "<!-- superagent-route:v1 repo=grunvald91/booking_bot -->\\n@Grunvald1991\\n"
body += "long issue instruction text with no secrets\\n" * 5000
with open(os.environ["MOCK_ISSUE_JSON"], "w", encoding="utf-8") as f:
    json.dump({"user": {"login": "grunvald91"}, "body": body}, f)
PY
cat > "$temp/bin/curl" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
for arg; do url="$arg"; done
case "$url" in
 *'tickets?state=open&limit=100&offset=0') echo '{"items":[{"id":"abc123","stage":"person"}]}' ;;
 *'tickets?state=open&limit=100&offset=1') echo '{"items":[]}' ;;
 *'tickets?state=ended&limit=100&offset=0') echo '{"items":[]}' ;;
 *'/tickets/abc123') echo '{"stage":"person","channels":[{"url":"https://github.com/grunvald91/Ai_growth_os/issues/300"}],"assignments":[{"report":{"state":"ready","summary":"PR: https://github.com/grunvald91/booking_bot/pull/17","at":"2026-11-05T15:00:00Z"}}]}' ;;
 *) echo "Unexpected API $url" >&2; exit 4 ;;
esac
MOCK
cat > "$temp/bin/gh" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == api ]] || exit 90
case "$2" in
  repos/grunvald91/Ai_growth_os/issues/300)
    cat "$MOCK_ISSUE_JSON" ;;
  repos/grunvald91/Ai_growth_os/issues/300/comments)
    [[ "$3" == '--method' && "$4" == 'POST' ]] || exit 91
    printf 'POST\n' >> "$COMMENT_LOG"
    printf '%s' "$6" > "$COMMENT_BODY" ;;
  'repos/grunvald91/Ai_growth_os/issues/300/comments?per_page=100') echo '[]' ;;
  *) echo "Unexpected gh API $2" >&2; exit 92 ;;
esac
MOCK
chmod +x "$temp/bin/gh" "$temp/bin/curl"
export PATH="$temp/bin:$PATH"
bash "$ROOT/scripts/superagent-terminal-relay.sh" >/dev/null
[[ "$(wc -l < "$COMMENT_LOG")" -eq 1 ]]
grep -q 'superagent-result:v1 issue=300 state=ready' "$COMMENT_BODY"
grep -q 'superagent-relay:v1 report=' "$COMMENT_BODY"
RESULT_PATH="$COMMENT_BODY" node --input-type=module -e '
  import { readFileSync } from "node:fs";
  import { parseTerminalResult } from "./tgcloud/lib/superagent-result.js";
  const body = readFileSync(process.env.RESULT_PATH, "utf8");
  if (parseTerminalResult(body, 300)?.state !== "ready") process.exit(1);
'
bash "$ROOT/scripts/superagent-terminal-relay.sh" >/dev/null
[[ "$(wc -l < "$COMMENT_LOG")" -eq 1 ]]
echo 'Superagent terminal relay: report signal and idempotency OK'
