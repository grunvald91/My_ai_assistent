#!/usr/bin/env bash
# Deterministic terminal-result bridge: DSH local API -> GitHub Issue -> Telegram watcher/status.
# No LLM interpretation of completion and no extra GitHub Actions. Run from the VPS capability timer.
set -euo pipefail
: "${DSH_SUPERAGENT_URL:?Local DSH URL required}"
HUB="grunvald91/Ai_growth_os"
base="${DSH_SUPERAGENT_URL%/}/orchestrator/api"
storage="${DSH_MULTI_REPO_STATE_DIR:-$HOME/.local/state/superagent-multirepo}"
mkdir -p "$storage"
seen="$storage/relayed-reports.txt"
touch "$seen"
chmod 600 "$seen"
lock="$storage/relay.lock"
exec 9>"$lock"
flock -n 9 || exit 0

api() {
  curl --fail --silent --show-error --max-time 12 -H 'x-orchestrator-request: 1' "$base/$1"
}
count=0
# The DSH API defaults to open tickets; ended tickets are a separate filtered view.
for stage in open ended; do
  offset=0
  while :; do
    page="$(api "tickets?state=$stage&limit=100&offset=$offset")"
    n="$(printf '%s' "$page" | jq -r '.items | length')"
    [[ "$n" =~ ^[0-9]+$ ]] || exit 48
    [[ "$n" -eq 0 ]] && break
    while IFS= read -r ticket; do
      [[ "$ticket" =~ ^[a-zA-Z0-9_-]+$ ]] || continue
      detail="$(api "tickets/$ticket")"
      # Only a worker's actual last terminal report can complete a task.
      report="$(printf '%s' "$detail" | jq -c '
        [.assignments[]?.report | select(. != null and
          (.state == "ready" or .state == "blocked" or .state == "failed" or .state == "dropped"))] | last // empty')"
      [[ -n "$report" ]] || continue
      status="$(printf '%s' "$report" | jq -r .state)"
      report_at="$(printf '%s' "$report" | jq -r '.at // empty')"
      [[ -n "$report_at" ]] || continue
      report_tag="$(printf '%s' "$ticket:$report_at:$status" | sha256sum | cut -c1-20)"
      grep -Fxq "$report_tag" "$seen" && continue
      # Use the original central Issue channel, not linked external PRs.
      issue_url="$(printf '%s' "$detail" | jq -r '.channels[]? | select(.url? and
        (.url | test("^https://github.com/grunvald91/Ai_growth_os/issues/[0-9]+$"))) | .url' | head -n1)"
      [[ -n "$issue_url" ]] || continue
      issue="${issue_url##*/}"
      [[ "$issue" =~ ^[1-9][0-9]*$ ]] || continue
      entry="$(gh api "repos/$HUB/issues/$issue")"
      author="$(printf '%s' "$entry" | jq -r '.user.login // ""')"
      line="$(printf '%s' "$entry" | jq -r '.body // ""' | head -n1)"
      [[ "${author,,}" == grunvald91 ]] || continue
      [[ "$line" =~ ^'<!-- superagent-route:v1 repo='([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)' -->'$ ]] || continue

      # Avoid a duplicate comment if the process crashed after GitHub accepted POST.
      existing="$(gh api "repos/$HUB/issues/$issue/comments?per_page=100" --paginate --jq '.[].body' || true)"
      relay_marker="<!-- superagent-relay:v1 report=$report_tag -->"
      if [[ "$existing" != *"$relay_marker"* ]]; then
        summary="$(printf '%s' "$report" | jq -r '.summary // "Задание завершено без подробного описания."')"
        body="$(printf '%s

%s
%s
<!-- superagent-result:v1 issue=%s state=%s -->'           "Результат DeepSeek Superagent ($status):" "$summary" "$relay_marker" "$issue" "$status")"
        gh api "repos/$HUB/issues/$issue/comments" --method POST -f body="$body" >/dev/null
      fi
      printf '%s
' "$report_tag" >> "$seen"
      count=$((count+1))
    done < <(printf '%s' "$page" | jq -r '.items[].id')
    offset=$((offset+n))
    [[ "$n" -lt 100 ]] && break
    if [[ "$offset" -ge 1000 ]]; then echo "Ticket pagination safety limit reached" >&2; exit 49; fi
  done
done
echo "Superagent terminal reports relayed: $count"
