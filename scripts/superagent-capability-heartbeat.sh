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

case "$DSH_SUPERAGENT_URL" in
  http://127.0.0.1:*|http://localhost:*) ;;
  *) echo "DSH health check must use loopback, not a public URL" >&2; exit 31 ;;
esac
[[ -f "$DSH_MULTI_REPO_PREPARE" ]] || { echo "Prepare script absent" >&2; exit 32; }
bash -n "$DSH_MULTI_REPO_PREPARE"
for command in curl jq gh git; do command -v "$command" >/dev/null || { echo "Missing $command" >&2; exit 33; }; done

# This endpoint is bound to loopback and requires the host's special header.
api="${DSH_SUPERAGENT_URL%/}/orchestrator/api"
settings="$(curl --fail --silent --show-error --max-time 8 -H 'x-orchestrator-request: 1' "$api/settings")"
state="$(curl --fail --silent --show-error --max-time 8 -H 'x-orchestrator-request: 1' "$api/state")"
expected="bash $DSH_MULTI_REPO_PREPARE"
printf '%s' "$settings" | jq -e --arg source "$HUB" --arg expected "$expected" '
  .blocks.executor.value.prepare == $expected
  and ([.sources[] | select(.kind == "github" and .value.enabled == true and .value.config.repository == $source)] | length) == 1
' >/dev/null || { echo "DSH Execution prepare or GitHub Source does not match" >&2; exit 34; }
printf '%s' "$state" | jq -e '.setup.problem == null and .paused == false' >/dev/null ||
  { echo "DSH is not healthy or currently paused" >&2; exit 35; }

# The agent identity behind gh must be the same one DSH uses.
account="$(gh api user --jq .login)"
[[ "${account,,}" == "$AGENT" ]] || { echo "gh is not authenticated as Grunvald1991" >&2; exit 36; }
push="$(gh api "repos/$HUB" --jq '.permissions.push')"
[[ "$push" == true ]] || { echo "Agent cannot write to hub" >&2; exit 37; }
sha="$(gh api "repos/$HUB/commits/main" --jq '.sha')"
[[ "$sha" =~ ^[0-9a-f]{40}$ ]] || { echo "Invalid hub commit SHA" >&2; exit 38; }
gh api "repos/$HUB/statuses/$sha" --method POST \
  -f state=success -f context="$STATUS_CONTEXT" -f description="$STATUS_DESCRIPTION" \
  >/dev/null
echo "DSH multi-repo capability refreshed at $(date -u +%FT%TZ)"
