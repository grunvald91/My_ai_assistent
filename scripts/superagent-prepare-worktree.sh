#!/usr/bin/env bash
# Prepare the correct repository for each DSH Superagent ticket.
# Configure this script as Settings → Execution → prepare command.
# It preserves the existing one-repository GitHub Source as the central issue queue.
set -euo pipefail

: "${DSH_SUPERAGENT_GITHUB_REPOSITORY:?Central GitHub Source is required}"
: "${DSH_SUPERAGENT_DIR:?Ticket checkout directory is required}"
: "${DSH_SUPERAGENT_NAME:?Ticket branch name is required}"

source_repo="${DSH_SUPERAGENT_GITHUB_REPOSITORY}"
target_repo="$source_repo"
issue="${DSH_SUPERAGENT_GITHUB_NUMBER:-}"
pr_head="${DSH_SUPERAGENT_GITHUB_PR_HEAD:-}"
ticket="${DSH_SUPERAGENT_TICKET:-}"

# Issues created by My AI Assistant include a server-readable marker on line one.
# Never parse arbitrary instructions lower in the Issue body as routing authority.
if [[ -n "$issue" && -z "$pr_head" ]]; then
  [[ "$issue" =~ ^[1-9][0-9]*$ ]] || { echo "Invalid issue number" >&2; exit 20; }
  # An Issue created through the bridge is owned by the authenticated repository owner.
  # A mention or body marker written by any other user cannot authorize work elsewhere.
  issue_author="$(gh api "repos/$source_repo/issues/$issue" --jq '.user.login')"
  is_pr="$(gh api "repos/$source_repo/issues/$issue" --jq '.pull_request != null')"
  body="$(gh api "repos/$source_repo/issues/$issue" --jq '.body // ""')"
  first_line="${body%%
  if [[ "$first_line" == '<!-- superagent-route:'* ]]; then
    if [[ "$first_line" =~ ^'<!-- superagent-route:v1 repo='([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)' -->'$ ]]; then
      target_repo="${BASH_REMATCH[1]}"
    else
      echo "Malformed Superagent routing marker" >&2
      exit 21
    fi
  fi
fi

# Bounded to the user's own repositories; do not alter the Telegram bot itself.
if [[ ! "$target_repo" =~ ^[Gg][Rr][Uu][Nn][Vv][Aa][Ll][Dd]91/[A-Za-z0-9_.-]+$ ]]; then
  echo "Repository is not in the configured allowlist: $target_repo" >&2
  exit 22
fi
if [[ "${target_repo,,}" == "grunvald91/my_ai_assistent" ]]; then
  echo "The Telegram bot repository cannot be an agent target" >&2
  exit 23
fi

# Verify *agent account* access, not the owner's Telegram bridge token.
can_push="$(gh api "repos/$target_repo" --jq '.permissions.push // false')"
if [[ "$can_push" != "true" ]]; then
  echo "Agent account has no write access to $target_repo" >&2
  exit 24
fi
default_branch="$(gh api "repos/$target_repo" --jq '.default_branch')"
[[ -n "$default_branch" ]] || { echo "No default branch" >&2; exit 25; }

# A per-ticket clone avoids cross-repository worktree reuse and branch collisions.
# Blobless clone keeps the first download smaller, provided GitHub supports it.
workdir="$DSH_SUPERAGENT_DIR"
if [[ -e "$workdir" && -n "$(ls -A "$workdir")" ]]; then
  echo "Ticket directory is not empty: $workdir" >&2
  exit 26
fi
git clone --quiet --no-checkout --filter=blob:none "https://github.com/$target_repo.git" "$workdir"
if [[ -n "$pr_head" && "$target_repo" == "$source_repo" ]]; then
  git -C "$workdir" fetch --no-tags origin "$pr_head"
else
  git -C "$workdir" fetch --no-tags origin "refs/heads/$default_branch"
fi
git -C "$workdir" checkout -q -B "agent/$DSH_SUPERAGENT_NAME" FETCH_HEAD
printf 'Superagent ticket=%s, source=%s, target=%s, branch=%s\n' \
  "$ticket" "$source_repo" "$target_repo" "agent/$DSH_SUPERAGENT_NAME"
\n'*}"
  if [[ "$first_line" == '<!-- superagent-route:'* ]]; then
    if [[ "${issue_author,,}" != 'grunvald91' || "$is_pr" != 'false' ]]; then
      echo "Routing marker is allowed only on Issues opened by grunvald91" >&2
      exit 28
    fi
  fi
  if [[ "$first_line" == '<!-- superagent-route:'* ]]; then
    if [[ "$first_line" =~ ^'<!-- superagent-route:v1 repo='([A-Za-z0-9_.-]+/[A-Za-z0-9_.-]+)' -->'$ ]]; then
      target_repo="${BASH_REMATCH[1]}"
    else
      echo "Malformed Superagent routing marker" >&2
      exit 21
    fi
  fi
fi

# Bounded to the user's own repositories; do not alter the Telegram bot itself.
if [[ ! "$target_repo" =~ ^[Gg][Rr][Uu][Nn][Vv][Aa][Ll][Dd]91/[A-Za-z0-9_.-]+$ ]]; then
  echo "Repository is not in the configured allowlist: $target_repo" >&2
  exit 22
fi
if [[ "${target_repo,,}" == "grunvald91/my_ai_assistent" ]]; then
  echo "The Telegram bot repository cannot be an agent target" >&2
  exit 23
fi

# Verify *agent account* access, not the owner's Telegram bridge token.
can_push="$(gh api "repos/$target_repo" --jq '.permissions.push // false')"
if [[ "$can_push" != "true" ]]; then
  echo "Agent account has no write access to $target_repo" >&2
  exit 24
fi
default_branch="$(gh api "repos/$target_repo" --jq '.default_branch')"
[[ -n "$default_branch" ]] || { echo "No default branch" >&2; exit 25; }

# A per-ticket clone avoids cross-repository worktree reuse and branch collisions.
# Blobless clone keeps the first download smaller, provided GitHub supports it.
workdir="$DSH_SUPERAGENT_DIR"
if [[ -e "$workdir" && -n "$(ls -A "$workdir")" ]]; then
  echo "Ticket directory is not empty: $workdir" >&2
  exit 26
fi
git clone --quiet --no-checkout --filter=blob:none "https://github.com/$target_repo.git" "$workdir"
if [[ -n "$pr_head" && "$target_repo" == "$source_repo" ]]; then
  git -C "$workdir" fetch --no-tags origin "$pr_head"
else
  git -C "$workdir" fetch --no-tags origin "refs/heads/$default_branch"
fi
git -C "$workdir" checkout -q -B "agent/$DSH_SUPERAGENT_NAME" FETCH_HEAD
printf 'Superagent ticket=%s, source=%s, target=%s, branch=%s\n' \
  "$ticket" "$source_repo" "$target_repo" "agent/$DSH_SUPERAGENT_NAME"
