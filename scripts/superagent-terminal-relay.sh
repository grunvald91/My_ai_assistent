#!/usr/bin/env bash
# Deterministic DSH report relay. VPS local API -> central GitHub Issue result marker.
set -euo pipefail
: "${DSH_SUPERAGENT_URL:?Missing local DSH URL}"
hub="grunvald91/Ai_growth_os"
cli="${DSH_AGENT_GH_CLI:-gh}"
command -v "$cli" >/dev/null || { echo "Agent GitHub CLI not found: $cli" >&2; exit 50; }
base="${DSH_SUPERAGENT_URL%/}/orchestrator/api"
storage="${DSH_MULTI_REPO_STATE_DIR:-$HOME/.local/state/superagent-multirepo}"
mkdir -p "$storage"
seen="$storage/relayed-reports.txt"
touch "$seen"
chmod 600 "$seen"
exec 9>"$storage/relay.lock"
flock -n 9 || exit 0

api() {
  curl --fail --silent --show-error --max-time 12 -H 'x-orchestrator-request: 1' "$base/$1"
}
route_re='^<!-- superagent-route:v1 repo=([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)( mode=(read|write))? -->$'
count=0

for stage in open ended; do
  offset=0
  while :; do
    page="$(api "tickets?state=$stage&limit=100&offset=$offset")"
    n="$(printf '%s' "$page" | jq -r '.items | length')"
    [[ "$n" =~ ^[0-9]+$ ]] || exit 48
    [[ "$n" -gt 0 ]] || break
    while IFS= read -r ticket; do
      [[ "$ticket" =~ ^[A-Za-z0-9_-]+$ ]] || continue
      detail="$(api "tickets/$ticket")"
      report="$(printf '%s' "$detail" | jq -c '
        if .stage == "person" or .stage == "ended" then
          .assignments[-1].report |
          select(. != null and (.state == "ready" or .state == "blocked" or .state == "failed" or .state == "dropped"))
        else empty end')"
      [[ -n "$report" ]] || continue
      status="$(printf '%s' "$report" | jq -r .state)"
      at="$(printf '%s' "$report" | jq -r '.at // empty')"
      [[ -n "$at" ]] || continue
      tag="$(printf '%s' "$ticket:$at:$status" | sha256sum | cut -c1-20)"
      if grep -Fxq "$tag" "$seen"; then continue; fi

      issue_url="$(printf '%s' "$detail" | jq -r 'first(.channels[]? | select(.url? and
        (.url | test("^https://github.com/grunvald91/Ai_growth_os/issues/[0-9]+$"))) | .url) // empty')"
      [[ -n "$issue_url" ]] || continue
      issue="${issue_url##*/}"
      [[ "$issue" =~ ^[1-9][0-9]*$ ]] || continue
      data="$("$cli" api "repos/$hub/issues/$issue")"
      author="$(printf '%s' "$data" | jq -r '.user.login // ""')"
      first_line="$(printf '%s' "$data" | jq -r '(.body // "") | split("\n")[0]')"
      [[ "${author,,}" == grunvald91 ]] || continue
      # The pre-multi-repo bridge did not add a route marker, but it did add this fixed owner-task heading.
      # Continue delivering results for those already accepted tickets as well.
      if ! [[ "$first_line" =~ $route_re ]]; then
        old_issue="$(printf '%s' "$data" | jq -r '.body // ""')"
        [[ "$old_issue" == *'## Задание от владельца через My AI Assistant'* ]] || continue
        [[ "$old_issue" == *'@Grunvald1991'* ]] || continue
      fi

      relay_marker="<!-- superagent-relay:v1 report=$tag -->"
      prior="$("$cli" api "repos/$hub/issues/$issue/comments?per_page=100" --paginate \
        --jq '.[] | select(.user.login == "Grunvald1991") | .body')"
      if [[ "$prior" != *"$relay_marker"* ]]; then
        summary="$(printf '%s' "$report" | jq -r '.summary // "Отчёт завершён без текста."')"
        comment="$(printf 'Состояние Superagent: %s\n\n%s\n%s\n<!-- superagent-result:v1 issue=%s state=%s -->' \
          "$status" "$summary" "$relay_marker" "$issue" "$status")"
        "$cli" api "repos/$hub/issues/$issue/comments" --method POST -f body="$comment" >/dev/null
      fi
      printf '%s\n' "$tag" >> "$seen"
      count=$((count+1))
    done < <(printf '%s' "$page" | jq -r '.items[].id')
    offset=$((offset+n))
    [[ "$n" -lt 100 ]] && break
    [[ "$offset" -lt 1000 ]] || { echo "Pagination limit exceeded" >&2; exit 49; }
  done
done
echo "Superagent terminal reports relayed: $count"
