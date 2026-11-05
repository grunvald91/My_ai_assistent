#!/usr/bin/env bash
# Prepare isolated DeepSeek Harness + ClaudeHub custom providers without starting the service.
set -euo pipefail
export PATH=/opt/dsh-toolchain/bin:/usr/local/bin:/usr/bin:/bin
export HOME=/srv/dsh-agent
export DSH_HOME=/srv/dsh-agent/.dsh
node --version
pnpm --version
dsh --version
tmux -V
gh --version | head -1
test -f /srv/dsh-agent/repos/dsh-superagent/lib/index.js
id dsh-agent >/dev/null
install -d -m 0700 -o dsh-agent -g dsh-agent /srv/dsh-agent/.config/gh-agent
install -d -m 0700 -o dsh-agent -g dsh-agent /srv/dsh-agent/.local/bin
install -d -m 0700 -o dsh-agent -g dsh-agent /srv/dsh-agent/.dsh
cat > /srv/dsh-agent/.local/bin/gh-agent <<'WRAP'
#!/bin/sh
export GH_CONFIG_DIR=/srv/dsh-agent/.config/gh-agent
exec /opt/dsh-toolchain/bin/gh "$@"
WRAP
chmod 0700 /srv/dsh-agent/.local/bin/gh-agent
chown dsh-agent:dsh-agent /srv/dsh-agent/.local/bin/gh-agent
chown -R dsh-agent:dsh-agent /srv/dsh-agent/repos/dsh-superagent
if [ ! -e /srv/dsh-agent/.dsh/profiles/superagent/cordis.patch.yml ]; then
  runuser -u dsh-agent -- env HOME="$HOME" DSH_HOME="$DSH_HOME" PATH="$PATH" dsh superagent --from-default-profile web --dump-config >/dev/null
fi
profile=/srv/dsh-agent/.dsh/profiles/superagent/cordis.patch.yml
test -e "$profile"
if grep -q 'id: llm-pi-ai' "$profile" 2>/dev/null; then
  echo 'PROVIDER_CONFIGURATION_EXISTS: not overwriting'
else
  cp -p "$profile" /srv/dsh-agent/config/cordis.before-claudehub.yml
  cat > "$profile" <<'YAML'
# Agent profile: local-only UI, isolated state, ClaudeHub via two API protocols.
# Secret is NOT stored here: write CLAUDEHUB_API_KEY to DSH managed credentials or
# to /srv/dsh-agent/.dsh/.env (0600) before starting the service.
- id: webserver
  config:
    host: 127.0.0.1
    port: 3082
- id: dsh-superagent
  config:
    stateDir: /srv/dsh-agent/state
- id: llm-pi-ai
  config:
    providers:
      claudehub-anthropic:
        apiKeyEnv: CLAUDEHUB_API_KEY
        api: anthropic-messages
        baseURL: https://api.claudehub.fun
        models:
          - id: claude-opus-4.8
      claudehub-openai:
        apiKeyEnv: CLAUDEHUB_API_KEY
        api: openai-completions
        baseURL: https://api.claudehub.fun/v1
        compat:
          supportsDeveloperRole: false
          maxTokensField: max_tokens
        models:
          - id: claude-opus-4.8
YAML
  chmod 0600 "$profile"
  chown dsh-agent:dsh-agent "$profile"
  echo 'CLAUDEHUB_TWO_PROTOCOLS_CONFIGURED_NO_KEY'
fi
if [ ! -d /srv/dsh-agent/repos/Ai_growth_os/.git ]; then
  runuser -u dsh-agent -- env HOME="$HOME" PATH="$PATH" git clone -q --depth 1 https://github.com/grunvald91/Ai_growth_os.git /srv/dsh-agent/repos/Ai_growth_os
fi
runuser -u dsh-agent -- env HOME="$HOME" PATH="$PATH" git -C /srv/dsh-agent/repos/Ai_growth_os log -1 --format='%h %s'
echo '=== RESOURCE CHECK ==='
free -h
df -hP /
echo '=== SERVICES ==='
docker ps --format '{{.Names}} {{.Status}}'
echo 'DSH_AGENT_PROFILE_PREPARED_NOT_STARTED'
