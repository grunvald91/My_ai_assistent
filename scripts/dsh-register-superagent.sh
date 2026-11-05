#!/usr/bin/env bash
# Register the built Superagent bundle in the prepared isolated DSH profile.
# Does not start the agent, open network ports, or modify EUNOIA.
set -euo pipefail
export PATH=/opt/dsh-toolchain/bin:/usr/local/sbin:/usr/local/bin:/usr/sbin:/usr/bin:/sbin:/bin
profile=/srv/dsh-agent/.dsh/profiles/superagent/cordis.patch.yml
src=/srv/dsh-agent/repos/dsh-superagent
test -r "$profile"
test -f "$src/lib/index.js"
test -d "$src/node_modules"
id dsh-agent >/dev/null
cp -p "$profile" /srv/dsh-agent/config/cordis.before-plugin-register.yml
chown dsh-agent:dsh-agent /srv/dsh-agent/config/cordis.before-plugin-register.yml
echo 'Registering Superagent bundle in isolated profile.'
if runuser -u dsh-agent -- env HOME=/srv/dsh-agent DSH_HOME=/srv/dsh-agent/.dsh PATH="$PATH" \
  dsh plugin --profile superagent add "link:$src" >/srv/dsh-agent/config/plugin-register.log 2>&1; then
  echo 'DSH_SUPERAGENT_BUNDLE_REGISTERED'
else
  echo 'DSH_SUPERAGENT_PLUGIN_COMMAND_FAILED: see private agent log, no service started'
  exit 14
fi
if ! grep -q 'claudehub-anthropic:' "$profile" || ! grep -q 'claudehub-openai:' "$profile"; then
  echo 'WARNING: provider route missing after plugin registration; preserving backup'
  exit 15
fi
if [ "$(grep -c '^[[:space:]]*\\- id:' "$profile")" -lt 3 ]; then
  echo 'ERROR: agent profile appears incomplete'
  exit 16
fi
echo 'CLAUDEHUB_PROVIDER_ROUTES_RETAINED'
echo '=== MEMORY ==='
free -h
echo '=== DISK ==='
df -hP /
echo '=== PRODUCTION DOCKER SERVICES ==='
docker ps --format '{{.Names}} {{.Status}}'
echo 'DSH_SUPERAGENT_BUNDLE_READY_NOT_RUNNING'
