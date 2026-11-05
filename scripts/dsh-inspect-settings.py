#!/usr/bin/env python3
"""Read non-secret config shape from the local DSH API for safe setup."""
import json
import urllib.request

BASE = "http://127.0.0.1:3082/orchestrator/api/"
def get(name):
    req = urllib.request.Request(BASE + name, headers={"x-orchestrator-request": "1"})
    with urllib.request.urlopen(req, timeout=12) as response:
        return json.load(response)

settings = get("settings")
print("BLOCKS", sorted(settings.get("blocks", {})))
for name, block in settings.get("blocks", {}).items():
    value = block.get("value", {})
    print("BLOCK", name, "revision", block.get("revision"), "keys", sorted(value))
    if name == "policy":
        print("POLICY_SOURCES", sorted(value.get("sources", {})))
        for source, obj in value.get("sources", {}).items():
            print("POLICY_SOURCE", source, "keys", sorted(obj), "allowed_count", len(obj.get("allowed", [])))
    if name == "executor":
        print("EXECUTOR_CURRENT", {k: value.get(k) for k in ("model", "maxWorkers", "directory", "prepare")})
for item in settings.get("sources", []):
    value = item.get("value") or {}
    cfg = value.get("config") or {}
    print("SOURCE", item.get("id"), "revision", item.get("revision"), "enabled", value.get("enabled"),
          "repository", cfg.get("repository"), "keys", sorted(cfg))
state = get("state")
print("STATE", {k: v.get("state") for k, v in (state.get("health") or {}).items() if isinstance(v, dict)})
print("SETUP_PROBLEM", ((state.get("setup") or {}).get("problem") or {}).get("code"))
