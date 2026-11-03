#!/usr/bin/env bash
# Synchronize source files from live EUNOIA; exclude credentials and live data.
set -euo pipefail
umask 077
: "${GH_PAT:?GH_PAT missing}"
: "${SSH_KEY_157:?SSH_KEY_157 missing}"
scratch="$(mktemp -d)"
trap 'rm -rf "$scratch"' EXIT
printf '%s\n' "$SSH_KEY_157" | tr -d '\r' > "$scratch/id"
unset SSH_KEY_157
ssh-keyscan -T 8 -t ed25519 157.22.203.28 2>/dev/null > "$scratch/known_hosts"
test "$(ssh-keygen -lf "$scratch/known_hosts" | awk '{print $2}')" = 'SHA256:rqV4WQmGpDXUI5mcxFuE4L++gnMbIXlnpS/pqkHMw8U'
ssh_opts=(-i "$scratch/id" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$scratch/known_hosts" -o ConnectTimeout=10)
remote_sha="$(ssh "${ssh_opts[@]}" root@157.22.203.28 'git -C /opt/eunoia rev-parse HEAD')"
echo "Remote git HEAD: $remote_sha"
auth_header="AUTHORIZATION: basic $(printf 'x-access-token:%s' "$GH_PAT" | base64 -w0)"
git -c "http.extraheader=$auth_header" clone --quiet --depth 1 --branch main https://github.com/grunvald91/EUNOIA.git "$scratch/eunoia"
test "$(git -C "$scratch/eunoia" rev-parse HEAD)" = "$remote_sha" || {
  echo "STOP: server HEAD no longer matches GitHub main. No push performed."; exit 20;
}
ssh "${ssh_opts[@]}" root@157.22.203.28 'git -C /opt/eunoia diff --binary HEAD' > "$scratch/server.patch"
git -C "$scratch/eunoia" apply --check "$scratch/server.patch"
git -C "$scratch/eunoia" apply "$scratch/server.patch"

# Copy source and new source files, never live secrets, private data or dependencies.
ssh "${ssh_opts[@]}" root@157.22.203.28 \
  'tar -C /opt/eunoia --warning=no-file-changed --ignore-failed-read -czf - \
     --exclude=.git --exclude=node_modules --exclude=.next --exclude=data \
     --exclude=backups --exclude=_drift_backup --exclude=.deploy_bak\* \
     --exclude=.env --exclude=.env.\* --exclude=\*.pem --exclude=\*.key \
     --exclude=\*.p12 --exclude=\*.pfx --exclude=\*credentials\* \
     --exclude=\*secret\* --exclude=\*.sqlite --exclude=\*.db \
     --exclude=\*.tar --exclude=\*.tar.gz --exclude=\*.zip \
     --exclude=\*.log --exclude=tmp --exclude=.cache \
     --exclude=web_backup_\* --exclude=.omc --exclude=.claude \
     --exclude=__pycache__ --exclude=.pytest_cache . ' \
     | tar -xz -C "$scratch/eunoia" --no-same-owner
git -C "$scratch/eunoia" add -A
if git -C "$scratch/eunoia" diff --cached --name-only |
    grep -Ei '(^|/)(\.env($|[.])|id_rsa|id_ed25519|.*(secret|credential|private.?key|token).*|.*[.](pem|key|p12|pfx|sqlite|db)$)' | grep -Ev '(^|/)\.env\.example$'; then
  echo "STOP: potential credential file staged"; exit 21
fi
if git -C "$scratch/eunoia" grep --cached -IqE \
  '(-----BEGIN [A-Z ]*PRIVATE KEY-----|github_pat_[A-Za-z0-9_]{20,}|ghp_[A-Za-z0-9]{20,}|sk-[A-Za-z0-9_-]{30,})' -- .; then
  echo "STOP: probable secret literal in staged files"; exit 22
fi
if find "$scratch/eunoia" -path "$scratch/eunoia/.git" -prune -o -type f -size +90M -print | grep -q .; then
  echo "STOP: large source file > 90MB; archive instead"; exit 23
fi
git -C "$scratch/eunoia" config user.name "EUNOIA server snapshot"
git -C "$scratch/eunoia" config user.email "git-sync@users.noreply.github.com"
if git -C "$scratch/eunoia" diff --cached --quiet; then
  echo "No code changes to sync."
  exit 0
fi
git -C "$scratch/eunoia" diff --cached --stat | tail -20
python3 -m compileall -q "$scratch/eunoia/backend/app"
git -C "$scratch/eunoia" commit -q -m "sync: preserve current EUNOIA VPS source snapshot"
target_branch="sync/eunoia-vps157-20261104"
git -C "$scratch/eunoia" -c "http.extraheader=$auth_header" push -q origin "HEAD:refs/heads/$target_branch"
echo "SOURCE_SYNC_BRANCH=$target_branch"
echo "SOURCE_SYNC_COMMIT=$(git -C "$scratch/eunoia" rev-parse HEAD)"
GH_TOKEN="$GH_PAT" gh pr create --repo grunvald91/EUNOIA \
  --head "$target_branch" --base main --draft \
  --title "sync: latest EUNOIA source from VPS157" \
  --body "Server source snapshot. Credentials, databases, uploads, backups and keys are excluded from Git and must be retained in an encrypted backup. Review before merge." || true
echo "SOURCE_SYNC_COMPLETE"
