#!/usr/bin/env bash
# Encrypt EUNOIA live application state with the SSH public key corresponding
# to SSH_KEY_157, then place encrypted recovery assets in the private EUNOIA release.
# No plaintext secrets are committed to Git or printed in logs.
set -euo pipefail
umask 077
: "${GH_PAT:?missing GH_PAT}"
: "${SSH_KEY_157:?missing SSH_KEY_157}"
tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
printf '%s\n' "$SSH_KEY_157" | tr -d '\r' > "$tmp/id"
ssh-keygen -y -P '' -f "$tmp/id" > "$tmp/recipient.pub"
unset SSH_KEY_157
ssh-keyscan -T 8 -t ed25519 157.22.203.28 2>/dev/null > "$tmp/known_hosts"
test "$(ssh-keygen -lf "$tmp/known_hosts" | awk '{print $2}')" = 'SHA256:rqV4WQmGpDXUI5mcxFuE4L++gnMbIXlnpS/pqkHMw8U'
ssh_opts=(-i "$tmp/id" -o BatchMode=yes -o IdentitiesOnly=yes -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$tmp/known_hosts" -o ConnectTimeout=10)
GH_TOKEN="$GH_PAT" gh api repos/grunvald91/EUNOIA --jq .private | grep -qx true
if ! command -v age >/dev/null; then
  sudo apt-get update -qq
  sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq age >/dev/null
fi
timestamp="$(date -u +%Y%m%dT%H%M%SZ)"
backup="$tmp/eunoia-application-$timestamp.tar.gz.age"
database="$tmp/eunoia-postgres-$timestamp.dump.age"
echo 'Encrypting live application files, keys, media, persistent Docker volumes and backup history.'
ssh "${ssh_opts[@]}" root@157.22.203.28 \
  "tar -C / --ignore-failed-read --warning=no-file-changed \
    --exclude=opt/eunoia/.git --exclude=opt/eunoia/web/node_modules \
    --exclude=opt/eunoia/web/.next --exclude=opt/eunoia/.next \
    --exclude=opt/eunoia/.gitignore \
    -czf - opt/eunoia var/backups/eunoia \
    var/lib/docker/volumes/eunoia_qdrant_data \
    var/lib/docker/volumes/eunoia_uploads_data \
    var/lib/docker/volumes/eunoia_dkim_keys \
    var/lib/docker/volumes/eunoia_caddy_data \
    var/lib/docker/volumes/eunoia_caddy_config" \
  | age -R "$tmp/recipient.pub" -o "$backup"
echo 'Encrypting consistent PostgreSQL logical dump.'
ssh "${ssh_opts[@]}" root@157.22.203.28 \
  "docker exec eunoia-postgres-1 pg_dump -U eunoia -d eunoia -Fc" \
  | age -R "$tmp/recipient.pub" -o "$database"
test -s "$backup"
test -s "$database"
# Verify encrypted files are structurally recognizable; never decrypt in CI.
file "$backup" "$database" | sed "s#$tmp/##g" | cut -c 1-170
sha256sum "$backup" "$database" | sed "s#$tmp/##g" > "$tmp/sha256sums.txt"
tag="eunoia-recovery-$timestamp"
source_ref="sync/eunoia-vps157-20261104"
echo 'Uploading encrypted backup assets to private EUNOIA GitHub Release.'
GH_TOKEN="$GH_PAT" gh release create "$tag" "$backup" "$database" "$tmp/sha256sums.txt" \
  --repo grunvald91/EUNOIA --target "$source_ref" \
  --title "Encrypted recovery snapshot $timestamp" \
  --notes "Encrypted to the SSH public key corresponding to SSH_KEY_157 in My_ai_assistent. Requires the original private key for decryption. Includes application files, runtime configuration, mounted data, backup history, selected Docker volumes and a separate PostgreSQL logical dump. Do not delete the SSH private key."
GH_TOKEN="$GH_PAT" gh release view "$tag" --repo grunvald91/EUNOIA --json assets \
  --jq '.assets[] | [.name,.size] | @tsv'
echo "ENCRYPTED_BACKUP_RELEASE=$tag"

# Agent staging only after backup uploaded; do not touch running services.
ssh "${ssh_opts[@]}" root@157.22.203.28 \
  "id -u dsh-agent >/dev/null 2>&1 || useradd --system --user-group --create-home --home-dir /srv/dsh-agent --shell /usr/sbin/nologin dsh-agent; \
   install -d -m 0700 -o dsh-agent -g dsh-agent /srv/dsh-agent/state /srv/dsh-agent/work /srv/dsh-agent/repos /srv/dsh-agent/config; \
   echo 'DSH_AGENT_STAGING_READY'; df -hP /"
echo 'ENCRYPTED_RECOVERY_AND_AGENT_STAGING_COMPLETE'
