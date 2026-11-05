#!/usr/bin/env bash
# Finish the pre-staged DSH installation and launch it under a dedicated
# unprivileged systemd service. No production Docker mutations.
set -euo pipefail
umask 077
export PATH=/opt/dsh-toolchain/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
export HOME=/srv/dsh-agent
export DSH_HOME=/srv/dsh-agent/.dsh
profile="$DSH_HOME/profiles/superagent/cordis.patch.yml"
src=/srv/dsh-agent/repos/dsh-superagent
envfile="$DSH_HOME/.env"
service=dsh-superagent.service

test "$(id -u)" -eq 0
id dsh-agent >/dev/null
docker ps --format '{{.Names}}' | grep -qx eunoia-web-1
docker ps --format '{{.Names}}' | grep -qx eunoia-postgres-1
test -s "$profile"
test -s "$envfile"
test -f "$src/lib/index.js"
test -d "$src/node_modules"
test -x /opt/dsh-toolchain/bin/dsh
test -x /opt/dsh-toolchain/bin/node
test -x /opt/dsh-toolchain/bin/gh
grep -q '^CLAUDEHUB_API_KEY=' "$envfile"
grep -q 'claudehub-anthropic:' "$profile"
grep -q 'claudehub-openai:' "$profile"
if id -nG dsh-agent | grep -Eq '(^|[[:space:]])(docker|sudo|root)([[:space:]]|$)'; then
  echo 'ERROR: unprivileged agent account has excessive group access'; exit 31
fi
avail="$(df -Pm / | awk 'NR==2 {print $4}')"
test "$avail" -gt 1500 || { echo 'ERROR: less than 1500 MiB disk headroom'; exit 32; }
echo '=== PREREQUISITES ==='
node --version
pnpm --version
dsh --version
gh --version | head -1
tmux -V
echo '=== AVAILABLE RESOURCES (before agent) ==='
free -w -h
df -hP /
echo '=== BUNDLE INSTALL/REGISTRATION ==='
cp -p "$profile" /srv/dsh-agent/config/cordis.before-final-registration.yml
chown dsh-agent:dsh-agent /srv/dsh-agent/config/cordis.before-final-registration.yml
# Register the official bundle into the DSH profile; safely avoid repeating an
# already-done registration by inspecting its plugin manifest.
if [ -e "$DSH_HOME/profiles/superagent/plugins.json" ] && grep -q 'dsh-superagent' "$DSH_HOME/profiles/superagent/plugins.json"; then
  echo 'BUNDLE_PLUGIN_ALREADY_REGISTERED'
else
  if ! runuser -u dsh-agent -- env HOME="$HOME" DSH_HOME="$DSH_HOME" PATH="$PATH" \
      dsh plugin --profile superagent add "link:$src" \
      >/srv/dsh-agent/config/final-plugin-register.log 2>&1; then
    echo 'ERROR: bundle registration failed; inspect private /srv/dsh-agent/config/final-plugin-register.log'
    exit 33
  fi
  echo 'BUNDLE_PLUGIN_REGISTERED'
fi
grep -q 'claudehub-anthropic:' "$profile"
grep -q 'claudehub-openai:' "$profile"
echo '=== SYSTEMD RESOURCE-CAPPED SERVICE ==='
cat >/etc/systemd/system/dsh-superagent.service <<'UNIT'
[Unit]
Description=Isolated DeepSeek DSH Superagent (ClaudeHub)
Wants=network-online.target
After=network-online.target
StartLimitIntervalSec=300
StartLimitBurst=3

[Service]
Type=simple
User=dsh-agent
Group=dsh-agent
WorkingDirectory=/srv/dsh-agent/repos/dsh-superagent
Environment=HOME=/srv/dsh-agent
Environment=DSH_HOME=/srv/dsh-agent/.dsh
Environment=PATH=/opt/dsh-toolchain/bin:/usr/local/bin:/usr/bin:/bin
EnvironmentFile=/srv/dsh-agent/.dsh/.env
ExecStart=/opt/dsh-toolchain/bin/dsh --profile superagent --no-open
Restart=on-failure
RestartSec=15
TimeoutStopSec=60
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths=/srv/dsh-agent
ProtectHome=true
PrivateTmp=true
PrivateDevices=true
UMask=0077
MemoryAccounting=yes
MemoryHigh=300M
MemoryMax=480M
MemorySwapMax=350M
CPUAccounting=yes
CPUQuota=65%
TasksMax=90
OOMScoreAdjust=350

[Install]
WantedBy=multi-user.target
UNIT
chmod 0644 /etc/systemd/system/dsh-superagent.service
systemctl daemon-reload
systemctl enable --now "$service" >/dev/null
sleep 9
echo '=== SERVICE STATUS ==='
systemctl show "$service" -p ActiveState -p SubState -p MainPID -p NRestarts -p MemoryCurrent -p MemoryPeak -p MemoryMax -p MemoryHigh -p CPUQuotaPerSecUSec
echo '=== ORCHESTRATOR HEALTH (localhost only) ==='
python3 - <<'PY'
import json,urllib.request,urllib.error
u="http://127.0.0.1:3082/orchestrator/api/state"
req=urllib.request.Request(u, headers={"x-orchestrator-request":"1"})
try:
    with urllib.request.urlopen(req, timeout=8) as r:
        d=json.load(r)
    states={k:v.get("state") for k,v in (d.get("health") or {}).items() if isinstance(v,dict)}
    problem=(d.get("setup") or {}).get("problem")
    print("LOCAL_HEALTH_HTTP_OK", "states="+json.dumps(states,ensure_ascii=False), "setup_required="+str(bool(problem)))
except (OSError,ValueError,KeyError) as e:
    print("LOCAL_HEALTH_NOT_READY",type(e).__name__)
PY
echo '=== EUNOIA REMAINS ONLINE ==='
docker ps --format '{{.Names}} {{.Status}}' | grep -E '^eunoia-(web|postgres|backend)-1 '
curl -sS -o /dev/null --max-time 15 -w 'EUNOIA_HTTPS_STATUS=%{http_code}\n' https://spokoino.site/
echo '=== RESOURCE STATUS AFTER ==='
free -w -h
df -hP /
echo 'DSH_SUPERAGENT_SERVICE_INSTALL_ATTEMPT_COMPLETE'
