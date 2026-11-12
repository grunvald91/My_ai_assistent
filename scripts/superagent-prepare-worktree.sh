#!/usr/bin/env bash
# DSH workspace prepare hook. GitHub Source is the central Issue queue, not always the code repository.
set -euo pipefail
: "${DSH_SUPERAGENT_GITHUB_REPOSITORY:?Missing DSH source repo}"
: "${DSH_SUPERAGENT_DIR:?Missing ticket dir}"
: "${DSH_SUPERAGENT_NAME:?Missing ticket name}"

source_repo="$DSH_SUPERAGENT_GITHUB_REPOSITORY"
target_repo="$source_repo"
mode=write
issue="${DSH_SUPERAGENT_GITHUB_NUMBER:-}"
pr_head="${DSH_SUPERAGENT_GITHUB_PR_HEAD:-}"
ticket="${DSH_SUPERAGENT_TICKET:-}"

if [[ -n "$issue" && -z "$pr_head" ]]; then
  [[ "$issue" =~ ^[1-9][0-9]*$ ]] || { echo "Invalid Issue number" >&2; exit 20; }
  issue_author="$(gh api "repos/$source_repo/issues/$issue" --jq '.user.login')"
  is_pr="$(gh api "repos/$source_repo/issues/$issue" --jq '.pull_request != null')"
  body="$(gh api "repos/$source_repo/issues/$issue" --jq '.body // ""')"
  first_line="${body%%$'\n'*}"
  route_re='^<!-- superagent-route:v1 repo=([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+) mode=(read|write) -->$'
  legacy_re='^<!-- superagent-route:v1 repo=([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+) -->$'
  if [[ "$first_line" == '<!-- superagent-route:'* ]]; then
    if [[ "${issue_author,,}" != grunvald91 || "$is_pr" != false ]]; then
      echo "Route marker is allowed only in an Issue created by grunvald91" >&2
      exit 28
    fi
    if [[ "$first_line" =~ $route_re ]]; then
      target_repo="${BASH_REMATCH[1]}"
      mode="${BASH_REMATCH[2]}"
    elif [[ "$first_line" =~ $legacy_re ]]; then
      target_repo="${BASH_REMATCH[1]}"
      mode=write
    else
      echo "Malformed Superagent route marker" >&2
      exit 21
    fi
  fi
fi

allow_re='^[Gg][Rr][Uu][Nn][Vv][Aa][Ll][Dd]91/[A-Za-z0-9_.-]+$'
[[ "$target_repo" =~ $allow_re ]] || { echo "Target outside owner allowlist: $target_repo" >&2; exit 22; }
[[ "${target_repo,,}" != grunvald91/my_ai_assistent || "$mode" == read ]] || { echo "Bot repository allows read-only review, not code changes" >&2; exit 23; }

canonical="$(gh api "repos/$target_repo" --jq '.full_name // ""')"
[[ "${canonical,,}" == "${target_repo,,}" ]] || { echo "Agent cannot read target repo" >&2; exit 24; }
if [[ "$mode" == write ]]; then
  push="$(gh api "repos/$target_repo" --jq '.permissions.push // false')"
  [[ "$push" == true ]] || { echo "Agent lacks write access to $target_repo" >&2; exit 24; }
fi
default_branch="$(gh api "repos/$target_repo" --jq .default_branch)"
[[ -n "$default_branch" ]] || { echo "No default branch" >&2; exit 25; }

workdir="$DSH_SUPERAGENT_DIR"
if [[ -e "$workdir" && -n "$(ls -A "$workdir")" ]]; then
  echo "Ticket directory already contains files: $workdir" >&2
  exit 26
fi
git clone --quiet --no-checkout --filter=blob:none "https://github.com/$target_repo.git" "$workdir"
if [[ -n "$pr_head" && "${target_repo,,}" == "${source_repo,,}" ]]; then
  git -C "$workdir" fetch --no-tags origin "$pr_head"
else
  git -C "$workdir" fetch --no-tags origin "refs/heads/$default_branch"
fi
git -C "$workdir" checkout -q -B "agent/$DSH_SUPERAGENT_NAME" FETCH_HEAD
printf 'DSH ticket=%s source=%s target=%s mode=%s\n' "$ticket" "$source_repo" "$target_repo" "$mode"
