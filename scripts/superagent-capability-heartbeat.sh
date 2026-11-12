#!/usr/bin/env bash
# Publish a short-lived GitHub commit status only when THIS VPS has a verified live DSH configuration.
# Run every five minutes as the same OS user that runs DeepSeek Superagent.
set -euo pipefail

HUB="grunvald91/Ai_growth_os"
AGENT="grunvald1991"
STATUS_CONTEXT="superagent/multirepo-ready"
STATUS_DESCRIPTION="superagent-multirepo-v2"
: "${DSH_SUPERAGENT_URL:?Set local DSH Superagent URL, e.g. http://127.0.0.1:PORT}"
: "${DSH_MULTI_REPO_PREPARE:?Set absolute path to superagent-prepare-worktree.sh}"
: "${DSH_MULTI_REPO_RELAY:?Set absolute path to superagent-terminal-relay.sh}"
DSH_MULTI_REPO_MONITOR="${DSH_MULTI_REPO_MONITOR:-$(dirname "$DSH_MULTI_REPO_RELAY")/superagent-external-pr-monitor.mjs}"
export DSH_MULTI_REPO_MONITOR

case "$DSH_SUPERAGENT_URL" in
  http://127.0.0.1:*|http://localhost:*) ;;
  *) echo "DSH health check must use loopback, not a public URL" >&2; exit 31 ;;
esac
[[ -f "$DSH_MULTI_REPO_PREPARE" && -f "$DSH_MULTI_REPO_RELAY" ]] || { echo "Prepare or relay script absent" >&2; exit 32; }
# External PR monitoring is a supplementary capability. Its failure must not block
# read-only code review or new tickets while the DSH executor and report relay work.
monitor_ok=true
if [[ ! -f "$DSH_MULTI_REPO_MONITOR" || ! -f "$(dirname "$DSH_MULTI_REPO_MONITOR")/superagent-pr-watch-core.mjs" ]]; then
  echo "WARN: external PR monitor unavailable; Multi-Repo execution will still be checked" >&2
  monitor_ok=false
elif ! node --check "$DSH_MULTI_REPO_MONITOR"; then
  echo "WARN: external PR monitor has a syntax error" >&2
  monitor_ok=false
fi
bash -n "$DSH_MULTI_REPO_PREPARE"
bash -n "$DSH_MULTI_REPO_RELAY"
for command in curl jq gh git node; do command -v "$command" >/dev/null || { echo "Missing $command" >&2; exit 33; }; done

# This endpoint is bound to loopback and requires the host's special header.
api="${DSH_SUPERAGENT_URL%/}/orchestrator/api"
settings="$(curl --fail --silent --show-error --max-time 8 -H 'x-orchestrator-request: 1' "$api/settings")"
state="$(curl --fail --silent --show-error --max-time 8 -H 'x-orchestrator-request: 1' "$api/state")"
# Use the same GitHub CLI wrapper as the DSH Source, not an unrelated login of the OS user.
agent_cli="$(printf '%s' "$settings" | jq -r --arg source "$HUB" '
  first(.sources[] | select(.kind == "github" and .value.enabled == true and .value.config.repository == $source) | .value.config.cli) // empty')"
[[ -n "$agent_cli" && "$agent_cli" != null ]] || { echo "DSH agent CLI is not configured" >&2; exit 40; }
command -v "$agent_cli" >/dev/null || { echo "DSH agent CLI cannot execute: $agent_cli" >&2; exit 41; }
export DSH_AGENT_GH_CLI="$agent_cli"
expected="bash $DSH_MULTI_REPO_PREPARE"
prompts="$(curl --fail --silent --show-error --max-time 8 -H 'x-orchestrator-request: 1' "$api/prompts")" || prompts=""
printf '%s' "$settings" | jq -e --arg source "$HUB" --arg expected "$expected" '
  .blocks.executor.value.prepare == $expected
  and ([.sources[] | select(.kind == "github" and .value.enabled == true and .value.config.repository == $source)] | length) == 1
' >/dev/null || { echo "DSH Execution prepare or GitHub Source does not match" >&2; exit 34; }
printf '%s' "$state" | jq -e '.setup.problem == null and .paused == false' >/dev/null ||
  { echo "DSH is not healthy or currently paused" >&2; exit 35; }
if ! printf '%s' "$prompts" | jq -e '.current.config.delivery | strings | contains("superagent-external-pr-v1")' >/dev/null 2>&1; then
  echo "WARN: external PR delivery prompt is missing or could not be read" >&2
fi

# The agent identity behind gh must be the same one DSH uses.
account="$("$agent_cli" api user --jq .login)"
[[ "${account,,}" == "$AGENT" ]] || { echo "gh is not authenticated as Grunvald1991" >&2; exit 36; }
push="$("$agent_cli" api "repos/$HUB" --jq '.permissions.push')"
[[ "$push" == true ]] || { echo "Agent cannot write to hub" >&2; exit 37; }
# Relay terminal reports BEFORE signalling readiness. If this fails, no fresh capability is published.
bash "$DSH_MULTI_REPO_RELAY"
if [[ "$monitor_ok" == true ]]; then
  # Bound optional network calls so a stuck PR monitor cannot age out the DSH heartbeat.
  if ! timeout --signal=TERM --kill-after=5s 45s node "$DSH_MULTI_REPO_MONITOR"; then
    echo "WARN: external PR monitor failed or timed out; ticket handling remains available" >&2
  fi
fi
sha="$("$agent_cli" api "repos/$HUB/commits/main" --jq '.sha')"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "Invalid hub commit SHA" >&2; exit 38; }
"$agent_cli" api "repos/$HUB/statuses/$sha" --method POST \
  -f state=success -f context="$STATUS_CONTEXT" -f description="$STATUS_DESCRIPTION" \
  >/dev/null
echo "DSH multi-repo capability refreshed at $(date -u +%FT%TZ)"
