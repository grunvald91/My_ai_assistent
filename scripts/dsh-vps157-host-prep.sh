#!/usr/bin/env bash
# VPS 157: targeted read-only capacity/security diagnostics plus minimal, idempotent
# staging for a future agent. NO package installations, downloads or service restarts.
set -euo pipefail

if [ "$(id -u)" -ne 0 ]; then echo "ERROR: requires root for staging"; exit 2; fi
if ! getent ahostsv4 spokoino.site | awk '$2=="STREAM"{print $1}' | grep -qx '157.22.203.28'; then
  echo "ERROR: spokoino.site DNS is not resolved to expected host; refusing staging"; exit 3
fi
if ! command -v docker >/dev/null || ! docker ps --format '{{.Names}}' | grep -qx 'spokoino-loading-check'; then
  echo "ERROR: no known psychologist service container on target; refusing staging"; exit 4
fi

echo "--- 1: DISK FOOTPRINT (read-only, may be incomplete if timed out) ---"
for target in /opt /var/log /var/cache /var/lib/docker /root; do
  if [ -d "$target" ]; then
    echo "DIRECTORY: $target"
    timeout 20 du -xhd1 "$target" 2>/dev/null | sort -h | tail -12 || true
  fi
done
echo "--- 2: DOCKER DISK (read-only) ---"
timeout 20 docker system df 2>/dev/null || true
echo "--- 3: DOCKER PORT BINDINGS ---"
docker ps --format '{{.Names}} : {{.Ports}}' | head -30 || true
echo "--- 4: FIREWALL STATUS ---"
if command -v ufw >/dev/null; then timeout 8 ufw status 2>/dev/null | head -30 || true; fi
echo "--- 5: SERVICE RESPONSE (status only) ---"
if command -v curl >/dev/null; then
  curl -L -sS --max-time 12 -o /dev/null -w 'spokoino.site HTTPS status: %{http_code}\n' https://spokoino.site/ || true
fi

echo "--- 6: MINIMAL AGENT STAGING ---"
if ! getent passwd dsh-agent >/dev/null; then
  useradd --system --user-group --create-home --home-dir /var/lib/dsh-agent --shell /usr/sbin/nologin dsh-agent
  echo "CREATED: system user dsh-agent"
else
  echo "EXISTS: system user dsh-agent"
fi
if ! getent group dsh-agent >/dev/null; then echo 'ERROR: dsh-agent group unavailable'; exit 5; fi
for sub in state work src .config; do
  install -d -m 0700 -o dsh-agent -g dsh-agent "/var/lib/dsh-agent/$sub"
done
echo "READY: /var/lib/dsh-agent/{state,work,src,.config}, mode 0700"
echo "NOT INSTALLED: node, pnpm, gh, tmux, DeepSeek Harness, models"
echo "NOT CHANGED: Docker, EUNOIA, PostgreSQL, Redis, Qdrant, Caddy, application secrets"
echo "--- 7: FINAL STATE ---"
df -hP /
free -h
docker ps --format '{{.Names}} {{.Status}}' | head -25 || true
echo 'RESULT: DSH host staging complete, DeepSeek not running'
