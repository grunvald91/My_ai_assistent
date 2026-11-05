#!/usr/bin/env python3
"""Configure the staged DSH Superagent for explicit, GitHub-only requests.
Do not alter credentials, live app services, or autonomous/auto-merge policy.
"""
import json
import time
import urllib.error
import urllib.request

BASE = "http://127.0.0.1:3082/orchestrator/api/"
REPO = "grunvald91/Ai_growth_os"
AGENT_CLI = "/srv/dsh-agent/.local/bin/gh-agent"
ROOT = "/srv/dsh-agent/repos/Ai_growth_os"
WORK = "/srv/dsh-agent/work"

def api(method, path, value=None):
    data = None if value is None else json.dumps(value).encode("utf-8")
    req = urllib.request.Request(
        BASE + path, data=data,
        headers={"x-orchestrator-request": "1", "content-type": "application/json"},
        method=method,
    )
    try:
        with urllib.request.urlopen(req, timeout=35) as resp:
            return resp.status, json.load(resp)
    except urllib.error.HTTPError as exc:
        try:
            payload = json.loads(exc.read(8000))
        except Exception:
            payload = {}
        raise RuntimeError(f"{method} {path} status={exc.code} code={payload.get('code', '?')} "
                           f"setup={str(payload.get('setup', {}))[:300]}") from None

def settings():
    for _ in range(30):
        try:
            code, data = api("GET", "settings")
            if code == 200:
                return data
        except (OSError, RuntimeError):
            pass
        time.sleep(2)
    raise RuntimeError("Management API did not recover after save")

def save(block, value, revision):
    code, response = api("PUT", "settings/" + block, {"value": value, "revision": revision})
    print("SAVED", block, "http", code, "restart", bool(response.get("restarting")))
    if not response.get("saved", False) and "revision" not in response:
        raise RuntimeError("Unexpected reply for " + block)

s = settings()
p = s["blocks"]["policy"]
v = dict(p["value"])
sources = dict(v.get("sources", {}))
gh = dict(sources.get("github", {}))
gh["allowed"] = [{"id": "grunvald91"}]
# Do not turn on automatic inferred jobs: only an explicit @mention is admitted.
sources["github"] = gh
v["sources"] = sources
save("policy", v, p["revision"])

s = settings()
e = s["blocks"]["executor"]
v = dict(e["value"])
v["maxWorkers"] = 1
v["directory"] = WORK
# New worktree per Issue. Uses the known checkout; never touches running production.
v["prepare"] = (
    'git -C ' + ROOT +
    ' fetch --no-tags "https://github.com/$DSH_SUPERAGENT_GITHUB_REPOSITORY.git" '
    '"${DSH_SUPERAGENT_GITHUB_PR_HEAD:-HEAD}:refs/dsh-superagent/$DSH_SUPERAGENT_TICKET" && '
    'git -C ' + ROOT + ' worktree add -b "agent/$DSH_SUPERAGENT_NAME" '
    '"$DSH_SUPERAGENT_DIR" "refs/dsh-superagent/$DSH_SUPERAGENT_TICKET"'
)
save("executor", v, e["revision"])

s = settings()
sources = {x["id"]: x for x in s["sources"]}
src = sources["github"]
value = dict(src["value"])
cfg = dict(value.get("config") or {})
cfg["repository"] = REPO
cfg["cli"] = AGENT_CLI
# Other Issues, comments and CI events are not admitted automatically.
cfg["observeIssues"] = False
cfg["observePulls"] = False
cfg["observeComments"] = False
cfg["observeCi"] = False
value["config"] = cfg
value["enabled"] = True
save("source:github", value, src["revision"])

for attempt in range(30):
    try:
        _, state = api("GET", "state")
        setup = (state.get("setup") or {}).get("problem")
        runtime = (state.get("health", {}).get("runtime") or {}).get("state")
        github = (state.get("health", {}).get("github") or {}).get("state")
        if setup is None and runtime == "ready" and github == "ready":
            print("AGENT_GITHUB_SOURCE_READY", REPO, "maxWorkers=1 explicit_only")
            break
        if attempt in (0, 8, 20, 29):
            print("STATE", runtime, github, "setup_code",
                  setup.get("code") if isinstance(setup, dict) else None)
    except (OSError, RuntimeError) as exc:
        if attempt in (0, 8, 20, 29):
            print("WAITING_FOR_RUNTIME", type(exc).__name__)
    time.sleep(2)
else:
    raise RuntimeError("Agent source did not reach ready within check window")
