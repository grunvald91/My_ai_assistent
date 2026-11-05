#!/usr/bin/env python3
"""Safely configure Multi-Repo on the isolated DSH host using the PR's pinned scripts.

Runs as root via the existing pinned SSH GitHub Action. Keeps copies of old settings,
prompts, and systemd files. No changes to application data or production projects.
"""
from __future__ import annotations
import copy
import datetime
import json
import os
from pathlib import Path
import pwd
import shutil
import subprocess
import sys
import time
import urllib.error
import urllib.request

HOME = Path("/srv/dsh-agent")
BIN = HOME / ".local" / "bin"
PORT = 3082
SOURCE = "grunvald91/Ai_growth_os"
API = f"http://127.0.0.1:{PORT}/orchestrator/api/"
TASKS = (
    "superagent-prepare-worktree.sh",
    "superagent-terminal-relay.sh",
    "superagent-capability-heartbeat.sh",
    "superagent-configure-prompts.mjs",
)
VERSION = "superagent-external-pr-v1"
UNIT = Path("/etc/systemd/system/superagent-capability.service")
TIMER = Path("/etc/systemd/system/superagent-capability.timer")
USER = "dsh-agent"
PATH_ENV = "/opt/dsh-toolchain/bin:/usr/local/bin:/usr/bin:/bin"


def run(*args: str, check=True) -> subprocess.CompletedProcess[str]:
    return subprocess.run(args, capture_output=True, text=True, check=check, timeout=60)


def api(method: str, path: str, data=None):
    body = None if data is None else json.dumps(data).encode()
    headers = {"x-orchestrator-request": "1"}
    if body is not None:
        headers["content-type"] = "application/json"
    req = urllib.request.Request(API + path, data=body, headers=headers, method=method)
    with urllib.request.urlopen(req, timeout=15) as res:
        return json.load(res)


def healthy():
    state = api("GET", "state")
    if state.get("paused") or (state.get("setup") or {}).get("problem"):
        raise RuntimeError("DSH setup unhealthy or paused")
    return state


def scripts_valid(stage: Path):
    for file in TASKS:
        source = stage / "scripts" / file
        if not source.is_file():
            raise RuntimeError(f"Staged script missing: {file}")
        if file.endswith(".sh"):
            run("bash", "-n", str(source))
        else:
            run("/opt/dsh-toolchain/bin/node", "--check", str(source))


def preflight(stage: Path):
    if os.geteuid() != 0:
        raise RuntimeError("Root installer requires root")
    if not HOME.is_dir() or not stage.is_dir():
        raise RuntimeError("Missing isolated DSH home or staging directory")
    if run("systemctl", "is-active", "dsh-superagent").stdout.strip() != "active":
        raise RuntimeError("DSH service inactive")
    if run("systemctl", "show", "dsh-superagent", "-p", "User", "--value").stdout.strip() != USER:
        raise RuntimeError("Unexpected DSH service user")
    scripts_valid(stage)
    settings = api("GET", "settings")
    prompts = api("GET", "prompts")
    healthy()
    sources = [s for s in settings.get("sources", [])
               if s.get("kind") == "github" and s.get("value", {}).get("enabled")]
    if len(sources) != 1 or sources[0].get("value", {}).get("config", {}).get("repository") != SOURCE:
        raise RuntimeError("Unexpected enabled DSH GitHub Source")
    cli = sources[0].get("value", {}).get("config", {}).get("cli")
    if not cli:
        raise RuntimeError("Agent GitHub CLI not configured")
    # Validate agent identity without printing its token or config.
    account = run("runuser", "-u", USER, "--", "env",
                  f"HOME={HOME}", f"PATH={PATH_ENV}", cli, "api", "user", "--jq", ".login").stdout.strip()
    if account.lower() != "grunvald1991":
        raise RuntimeError("DSH GitHub CLI is not signed in as Grunvald1991")
    if not isinstance(settings.get("blocks", {}).get("executor", {}).get("revision"), int):
        raise RuntimeError("Missing DSH executor revision")
    if not isinstance(prompts.get("current", {}).get("revision"), int):
        raise RuntimeError("Missing DSH prompt revision")
    print("PREFLIGHT_OK source=" + SOURCE + " os_user=" + USER + " healthy=1")
    return settings, prompts


def save_json(path: Path, data):
    path.write_text(json.dumps(data, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")
    path.chmod(0o600)


def systemd_service():
    return f"""[Unit]
Description=Verify DSH Superagent multi-repository readiness
Wants=network-online.target
After=network-online.target dsh-superagent.service

[Service]
Type=oneshot
User={USER}
Group={USER}
WorkingDirectory={HOME}
Environment=HOME={HOME}
Environment=PATH={PATH_ENV}
Environment=DSH_SUPERAGENT_URL=http://127.0.0.1:{PORT}
Environment=DSH_MULTI_REPO_PREPARE={BIN / TASKS[0]}
Environment=DSH_MULTI_REPO_RELAY={BIN / TASKS[1]}
ExecStart=/usr/bin/env bash {BIN / TASKS[2]}
NoNewPrivileges=true
ProtectSystem=strict
ReadWritePaths={HOME}
ProtectHome=true
PrivateTmp=true
UMask=0077
MemoryMax=180M
"""


def systemd_timer():
    return """[Unit]
Description=Refresh DSH Superagent multi-repo readiness each five minutes

[Timer]
OnBootSec=1min
OnUnitActiveSec=5min
AccuracySec=30s
Unit=superagent-capability.service

[Install]
WantedBy=timers.target
"""


def update_prompts(prompts: dict):
    cfg = copy.deepcopy(prompts["current"]["config"])
    rule = """
### superagent-external-pr-v1
For a routed Issue, the target Git origin comes from the prepare hook.
An external PR must be created in that target repository using gh --repo OWNER/NAME.
Never send the external PR number to orchestrator_report.pr_number; upstream binds
PR numbers inside the Source repository only. Include its full URL in report.summary.
Never merge, auto-merge, deploy, or change unrelated repositories.
Only the VPS terminal relay publishes final superagent-result markers.
"""
    defaults = {x.get("key"): x for x in prompts.get("parts", [])}
    for part in ("runtime/work", "skill/github"):
        builtin = defaults.get(part)
        if not builtin or not builtin.get("text"):
            raise RuntimeError("Missing DSH built-in prompt: " + part)
        existing = (cfg.get("overrides", {}).get(part) or {}).get("text") or builtin["text"]
        if VERSION not in existing:
            cfg.setdefault("overrides", {})[part] = {
                "text": existing.rstrip() + "\n" + rule,
                "base": ((cfg.get("overrides", {}).get(part) or {}).get("base") or builtin.get("base")),
            }
    if VERSION not in cfg.get("delivery", ""):
        cfg["delivery"] = cfg.get("delivery", "").rstrip() + "\n" + rule
    return cfg


def live_check():
    s = api("GET", "settings")
    p = api("GET", "prompts")
    healthy()
    expect = "bash " + str(BIN / TASKS[0])
    if s["blocks"]["executor"]["value"].get("prepare") != expect:
        raise RuntimeError("Live DSH prepare command is not multi-repository")
    if VERSION not in p["current"]["config"].get("delivery", ""):
        raise RuntimeError("Live DSH prompt requirements absent")
    if run("systemctl", "is-active", "superagent-capability.timer").stdout.strip() != "active":
        raise RuntimeError("Readiness timer inactive")
    print("DSH_LIVE_CONFIGURATION_VERIFIED")


def main():
    if len(sys.argv) != 2:
        raise RuntimeError("Usage: dsh-multirepo-vps157-install.py /srv/dsh-agent/config/stage")
    stage = Path(sys.argv[1]).resolve()
    settings, prompts = preflight(stage)
    stamp = datetime.datetime.now(datetime.timezone.utc).strftime("%Y%m%dT%H%M%SZ")
    backup = HOME / "config" / f"multirepo-backup-{stamp}"
    backup.mkdir(parents=True, mode=0o700, exist_ok=False)
    backup.chmod(0o700)
    save_json(backup / "executor.json", settings["blocks"]["executor"])
    save_json(backup / "prompts.json", prompts["current"])
    for unit in (UNIT, TIMER):
        if unit.exists():
            shutil.copy2(unit, backup / unit.name)
    BIN.mkdir(mode=0o755, parents=True, exist_ok=True)
    for name in TASKS:
        existing = BIN / name
        if existing.exists():
            shutil.copy2(existing, backup / name)
        shutil.copy2(stage / "scripts" / name, existing)
        existing.chmod(0o755)
    pw = pwd.getpwnam(USER)
    for name in TASKS:
        os.chown(BIN / name, pw.pw_uid, pw.pw_gid)
    print("SCRIPTS_INSTALLED backups_private=1")

    executor = copy.deepcopy(settings["blocks"]["executor"]["value"])
    executor["prepare"] = "bash " + str(BIN / TASKS[0])
    if executor != settings["blocks"]["executor"]["value"]:
        result = api("PUT", "settings/executor",
                     {"value": executor, "revision": settings["blocks"]["executor"]["revision"]})
        print("EXECUTOR_SETTINGS_SAVED rev=" + str(result.get("revision")))
    for _ in range(15):
        try:
            healthy()
            break
        except Exception:
            time.sleep(2)
    else:
        raise RuntimeError("DSH did not recover after executor change")

    current_prompts = api("GET", "prompts")
    prompt_cfg = update_prompts(current_prompts)
    if prompt_cfg != current_prompts["current"]["config"]:
        result = api("PUT", "prompts", {"config": prompt_cfg, "baseRevision": current_prompts["current"]["revision"]})
        print("DSH_PROMPTS_SAVED rev=" + str(result.get("revision")))

    UNIT.write_text(systemd_service(), encoding="utf-8")
    TIMER.write_text(systemd_timer(), encoding="utf-8")
    UNIT.chmod(0o644)
    TIMER.chmod(0o644)
    run("systemctl", "daemon-reload")
    run("systemctl", "enable", "--now", "superagent-capability.timer")
    # This check performs terminal relay plus publishes a short-lived GitHub readiness status.
    result = run("systemctl", "start", "superagent-capability.service", check=False)
    if result.returncode:
        print("CAPABILITY_SERVICE_FAILED rc=" + str(result.returncode))
        raise RuntimeError("DSH capability heartbeat failed, see systemctl status/journalctl locally")
    live_check()
    print("MULTI_REPO_VPS_INSTALL_COMPLETE", "backup=" + backup.name)


if __name__ == "__main__":
    try:
        main()
    except Exception as exc:
        print("BLOCKED", type(exc).__name__, str(exc)[:190], file=sys.stderr)
        sys.exit(1)
