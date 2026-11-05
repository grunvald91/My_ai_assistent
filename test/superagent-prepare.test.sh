#!/usr/bin/env bash
# Offline integration tests for the DSH prepare command.
set -euo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
mkdir -p "$tmp/bin" "$tmp/work"
export GIT_MOCK_LOG="$tmp/git.log"
cat > "$tmp/bin/gh" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
[[ "$1" == api ]] || exit 91
path="$2"
case "$path" in
  repos/grunvald91/Ai_growth_os/issues/*)
    case "$4" in
      .user.login) printf '%s\n' "$MOCK_ISSUE_AUTHOR" ;;
      '.pull_request != null') printf '%s\n' "$MOCK_IS_PR" ;;
      '.body // ""') printf '%s\n' "$MOCK_ISSUE_BODY" ;;
      *) exit 92 ;;
    esac ;;
  repos/*)
    case "$4" in
      '.full_name // ""') printf '%s\n' "${path#repos/}" ;;
      '.permissions.push // false') printf '%s\n' "$MOCK_PUSH" ;;
      .default_branch) printf 'main\n' ;;
      *) exit 93 ;;
    esac ;;
  *) exit 94 ;;
esac
MOCK
cat > "$tmp/bin/git" <<'MOCK'
#!/usr/bin/env bash
set -euo pipefail
printf '%s\n' "$*" >> "$GIT_MOCK_LOG"
if [[ "$1" == clone ]]; then
  for dir; do :; done
  mkdir -p "$dir/.git"
fi
MOCK
chmod +x "$tmp/bin/git" "$tmp/bin/gh"
export PATH="$tmp/bin:$PATH"
export DSH_SUPERAGENT_GITHUB_REPOSITORY="grunvald91/Ai_growth_os"
export DSH_SUPERAGENT_GITHUB_NUMBER=300
export DSH_SUPERAGENT_NAME=review-fix-abc123
export DSH_SUPERAGENT_TICKET=one-ticket
export DSH_SUPERAGENT_GITHUB_PR_HEAD=""
export MOCK_ISSUE_AUTHOR="grunvald91"
export MOCK_IS_PR="false"
export MOCK_PUSH="true"
caseid=0
run_success() {
  caseid=$((caseid+1))
  export DSH_SUPERAGENT_DIR="$tmp/work/$caseid"
  : > "$GIT_MOCK_LOG"
  bash "$ROOT/scripts/superagent-prepare-worktree.sh" >/dev/null
  [[ -d "$DSH_SUPERAGENT_DIR/.git" ]] || { echo "No checkout" >&2; exit 1; }
}
run_fail() {
  caseid=$((caseid+1))
  export DSH_SUPERAGENT_DIR="$tmp/work/$caseid"
  : > "$GIT_MOCK_LOG"
  if bash "$ROOT/scripts/superagent-prepare-worktree.sh" >/dev/null 2>&1; then
    echo "Expected failure, but prepare accepted it" >&2
    exit 1
  fi
  if [[ -s "$GIT_MOCK_LOG" ]]; then
    echo "Prepare unexpectedly touched git during rejected routing" >&2
    exit 1
  fi
}
export MOCK_ISSUE_BODY='<!-- superagent-route:v1 repo=grunvald91/booking_bot -->'
run_success
grep -q 'github.com/grunvald91/booking_bot.git' "$GIT_MOCK_LOG"
export MOCK_ISSUE_BODY='ordinary original issue without routing marker'
run_success
grep -q 'github.com/grunvald91/Ai_growth_os.git' "$GIT_MOCK_LOG"
export MOCK_ISSUE_BODY='<!-- superagent-route:v1 repo=evil/other -->'
run_fail
export MOCK_ISSUE_BODY='<!-- superagent-route:v1 repo=grunvald91/booking_bot -->'
export MOCK_ISSUE_AUTHOR='attacker'
run_fail
export MOCK_ISSUE_AUTHOR='grunvald91'
export MOCK_IS_PR='true'
run_fail
export MOCK_IS_PR='false'
export MOCK_PUSH='false'
run_fail
export MOCK_PUSH='true'
export MOCK_ISSUE_BODY='<!-- superagent-route:broken -->'
run_fail
export MOCK_ISSUE_BODY='<!-- superagent-route:v1 repo=grunvald91/SMENA mode=read -->'
export MOCK_PUSH='false'
run_success
grep -q 'github.com/grunvald91/SMENA.git' "$GIT_MOCK_LOG"
echo 'Superagent prepare routing: 8 offline scenarios passed'
