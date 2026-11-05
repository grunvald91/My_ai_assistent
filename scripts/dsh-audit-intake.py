#!/usr/bin/env python3
"""Read-only Superagent intake audit; never print credentials, prompts or messages."""
import json
import urllib.request
BASE="http://127.0.0.1:3082/orchestrator/api/"
def read(path):
    req=urllib.request.Request(BASE+path,headers={"x-orchestrator-request":"1"})
    with urllib.request.urlopen(req,timeout=12) as response:
        return json.load(response)
state=read("state")
print("RUNTIME",((state.get("health") or {}).get("runtime") or {}).get("state"))
print("GITHUB",((state.get("health") or {}).get("github") or {}).get("state"))
problem=(state.get("setup") or {}).get("problem") or {}
print("SETUP_PROBLEM",problem.get("code"))
print("EXECUTOR_LOAD",state.get("load"))
for stage in ("open","person","working","idle","ended"):
    d=read("tickets?state="+stage+"&limit=6")
    rows=d.get("items",[])
    print("TICKETS",stage,"count",d.get("total"),"visible",len(rows))
    for row in rows[:5]:
        print("TICKET",row.get("id"),"stage",row.get("stage"),"title",str(row.get("title",""))[:120])
for name in ("github","relay","launch","assessment"):
    row=(state.get("health") or {}).get(name) or {}
    if row.get("state")=="error":
        print("HEALTH_ERROR",name,str(row.get("detail",""))[:180])
