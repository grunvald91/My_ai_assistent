#!/usr/bin/env bash
# Verify encrypted GitHub recovery assets by decryption and ephemeral DB restore.
set -euo pipefail
umask 077
: "${GH_PAT:?missing GH_PAT}"
: "${SSH_KEY_157:?missing SSH_KEY_157}"
tmp="$(mktemp -d)"
dbname="eunoia-restore-${GITHUB_RUN_ID:-local}"
cleanup(){ docker rm -f "$dbname" >/dev/null 2>&1 || true; rm -rf "$tmp"; }
trap cleanup EXIT
printf '%s\n' "$SSH_KEY_157" | tr -d '\r' > "$tmp/id"
unset SSH_KEY_157
if ! command -v age >/dev/null; then
 sudo apt-get update -qq
 sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -qq age >/dev/null
fi
tag='eunoia-recovery-20261103T213643Z'
GH_TOKEN="$GH_PAT" gh release download "$tag" --repo grunvald91/EUNOIA --dir "$tmp" >/dev/null
cd "$tmp"
sha256sum -c sha256sums.txt | sed -E 's#: OK$#: checksum verified#'
application="$(find "$tmp" -maxdepth 1 -name 'eunoia-application-*.age' -print -quit)"
database="$(find "$tmp" -maxdepth 1 -name 'eunoia-postgres-*.age' -print -quit)"
test -s "$application" && test -s "$database"
echo 'Checking full decryptability and tar contents; no secrets printed.'
age -d -i "$tmp/id" "$application" | tar -tzf - > "$tmp/manifest"
grep -q '^opt/eunoia/.env.production$' "$tmp/manifest"
grep -q '^opt/eunoia/data/' "$tmp/manifest"
grep -q '^var/backups/eunoia/' "$tmp/manifest"
grep -q '^var/lib/docker/volumes/eunoia_dkim_keys/' "$tmp/manifest"
echo 'APPLICATION_ARCHIVE_DECRYPT_AND_STRUCTURE_OK'
age -d -i "$tmp/id" "$database" > "$tmp/postgres.dump"
echo 'PostgreSQL archive decrypted, testing actual restore into temporary container.'
docker run -d --name "$dbname" -e POSTGRES_PASSWORD=restore-test-only postgres:17 >/dev/null
for attempt in $(seq 1 35); do
  if docker exec "$dbname" pg_isready -U postgres >/dev/null 2>&1; then break; fi
  sleep 1
done
docker exec "$dbname" pg_isready -U postgres >/dev/null
if ! docker exec -i "$dbname" pg_restore --no-owner --no-acl -U postgres -d postgres < "$tmp/postgres.dump" > "$tmp/restore.log" 2>&1; then
  echo 'POSTGRESQL_RESTORE_FAILED'; exit 31
fi
tables="$(docker exec "$dbname" psql -U postgres -At -d postgres -c "SELECT count(*) FROM information_schema.tables WHERE table_schema='public'")"
test "$tables" -gt 0
echo "POSTGRESQL_RESTORE_OK tables=$tables"
echo 'Checking separated agent system user exists on original VPS.'
ssh-keyscan -T 8 -t ed25519 157.22.203.28 2>/dev/null > "$tmp/known_hosts"
test "$(ssh-keygen -lf "$tmp/known_hosts" | awk '{print $2}')" = 'SHA256:rqV4WQmGpDXUI5mcxFuE4L++gnMbIXlnpS/pqkHMw8U'
ssh -i "$tmp/id" -o StrictHostKeyChecking=yes -o UserKnownHostsFile="$tmp/known_hosts" -o BatchMode=yes root@157.22.203.28 \
  'id -u dsh-agent; stat -c "%a %U %G" /srv/dsh-agent/state /srv/dsh-agent/work /srv/dsh-agent/repos /srv/dsh-agent/config; df -hP /'
echo 'RECOVERY_VERIFIED_NO_PRODUCTION_CHANGES'
