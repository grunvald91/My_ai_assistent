#!/usr/bin/env python3
"""Supplement delayed GitHub notifications with repository Issue/comment polling.
Only explicit @mentions by the allowed account may start work.
"""
import json
import time
import urllib.request
BASE="http://127.0.0.1:3082/orchestrator/api/"
HEAD={"x-orchestrator-request":"1","content-type":"application/json"}

def api(method,path,body=None):
    data=None if body is None else json.dumps(body).encode()
    req=urllib.request.Request(BASE+path,data=data,headers=HEAD,method=method)
    with urllib.request.urlopen(req,timeout=30) as r:
        return json.load(r)

def settings():
    for _ in range(20):
        try:
            return api("GET","settings")
        except OSError:
            time.sleep(2)
    raise RuntimeError("DSH settings API unavailable")

s=settings()
p=s["blocks"]["policy"]
v=dict(p["value"])
sources=dict(v.get("sources",{}))
gh=dict(sources.get("github",{}))
if gh.get("allowed")!=[{"id":"grunvald91"}]:
    raise RuntimeError("Refusing to change policy: allowed list is unexpected")
admission=dict(gh.get("admission") or {})
for row in ("issues","comments"):
    cell=dict(admission.get(row) or {})
    cell.update({"listedUnaddressed":"ignore","unlistedAddressed":"ignore","unlistedUnaddressed":"ignore"})
    admission[row]=cell
gh["admission"]=admission
sources["github"]=gh
v["sources"]=sources
response=api("PUT","settings/policy",{"value":v,"revision":p["revision"]})
print("EXPLICIT_ONLY_POLICY_SAVED",response.get("revision"))
s=settings()
src=next(x for x in s["sources"] if x["id"]=="github")
v=dict(src["value"])
cfg=dict(v["config"])
if cfg.get("repository")!="grunvald91/Ai_growth_os":
    raise RuntimeError("Refusing to enable repository polling on unexpected repo")
cfg["observeIssues"]=True
cfg["observeComments"]=True
cfg["observePulls"]=False
cfg["observeCi"]=False
v["config"]=cfg
response=api("PUT","settings/source:github",{"value":v,"revision":src["revision"]})
print("GITHUB_ISSUE_AND_COMMENT_POLLING_ENABLED",response.get("revision"))
for i in range(30):
    time.sleep(2)
    try:
        s=api("GET","state")
        h=s.get("health") or {}
        problem=(s.get("setup") or {}).get("problem")
        if not problem and (h.get("runtime") or {}).get("state")=="ready" and (h.get("github") or {}).get("state")=="ready":
            print("DSH_INTAKE_READY")
            break
    except OSError:
        pass
else:
    raise RuntimeError("DSH did not return ready after source restart")
