#!/usr/bin/env python3
"""Rotate the persistent DSH router Session to take effect after model changes.
Preserve the former Session and all current Issue, thread, ticket and settings
records; refuse if the runtime is busy or the desired role model is absent.
Run as root on VPS157, only after verifying the local management API.
"""
from __future__ import annotations
import json
import os
from pathlib import Path
import sqlite3
import subprocess
import time
import urllib.request

BASE = "http://127.0.0.1:3082/orchestrator/api/"
DB = Path("/srv/dsh-agent/state/orchestrator.sqlite")
BACKUP = Path("/srv/dsh-agent/config/backups")
TAIL = "-claudehub-v41-20261105"

def get(path: str):
    req = urllib.request.Request(BASE+path, headers={"x-orchestrator-request":"1"})
    with urllib.request.urlopen(req,timeout=15) as res:
        return json.load(res)

def log(text, *values):
    print(text, *values, flush=True)

assert os.geteuid()==0, "This script expects root SSH session"
settings=get("settings")
assert settings["blocks"]["eval"]["value"]["model"] == {"provider":"claudehub-openai","model":"deepseek-v4.1-flash"}, "Wrong router model"
assert settings["blocks"]["executor"]["value"]["model"] == {"provider":"claudehub-anthropic","model":"claude-opus-5-5"}, "Wrong executor model"
state=get("state")
assert state.get("setup",{}).get("problem") is None, "Setup not ready"
assert (state.get("health",{}).get("runtime") or {}).get("state")=="ready", "Runtime not ready"
assert state.get("load",{}).get("running",0)==0 and state.get("load",{}).get("queued",0)==0, "Workers not idle"
tickets=get("tickets?state=open&limit=1")
assert int(tickets.get("total",0))==0, "Open task is still active; do not rotate"
log("ROTATION_PRECHECK_OK idle, correct role models")
subprocess.run(["systemctl","stop","dsh-superagent"],check=True,timeout=75)
assert subprocess.run(["systemctl","is-active","--quiet","dsh-superagent"]).returncode != 0, "Service failed to stop"

BACKUP.mkdir(parents=True,exist_ok=True)
with sqlite3.connect(DB,timeout=15) as db:
    db.execute("PRAGMA busy_timeout=15000")
    row=db.execute("SELECT value FROM kv WHERE key='master-id'").fetchone()
    assert row, "Missing master-id"
    old=json.loads(row[0])
    assert isinstance(old,str) and old.startswith("orchestrator-"), "Unexpected master-id"
    if old.endswith(TAIL):
        log("ROUTER_ALREADY_ROTATED",old)
    else:
        filename=BACKUP/"orchestrator.before-router-v41.sqlite"
        with sqlite3.connect(filename) as to:
            db.backup(to)
        filename.chmod(0o600)
        os.chown(filename,os.getuid(),os.getgid())
        new=old+TAIL
        db.execute("BEGIN IMMEDIATE")
        db.execute("UPDATE kv SET value=? WHERE key='master-id'",(json.dumps(new),))
        db.commit()
        log("ROUTER_SESSION_ROTATED",old,"=>",new)
    log("PRESERVED_OLD_SESSION_AND_SQLITE_BACKUP",str(BACKUP/"orchestrator.before-router-v41.sqlite"))
subprocess.run(["systemctl","start","dsh-superagent"],check=True,timeout=70)
for attempt in range(40):
    try:
        state=get("state")
        if ((state.get("health") or {}).get("runtime") or {}).get("state")=="ready" and state.get("setup",{}).get("problem") is None:
            break
    except (OSError, ValueError):
        pass
    time.sleep(2)
else:
    raise RuntimeError("DSH did not reach ready within post-rotation check")
assert subprocess.run(["systemctl","is-active","--quiet","dsh-superagent"]).returncode==0
with sqlite3.connect(DB) as db:
    new=json.loads(db.execute("SELECT value FROM kv WHERE key='master-id'").fetchone()[0])
assert new.endswith(TAIL), "Wrong router Session was loaded"
log("ROTATED_ROUTER_READY",new)
log("EXECUTOR_LIMIT",state.get("load",{}))
log("GITHUB_SOURCE_HEALTH",(state.get("health",{}).get("github") or {}).get("state"))
log("AGENT_PROCESS_ACTIVE")
