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

print("GITHUB_HEALTH_DETAIL", str(((state.get("health") or {}).get("github") or {}).get("detail",""))[:180])
for source in read("sources"):
    if source.get("id")=="github":
        print("SOURCE_STATUS", source.get("state"), "stats_keys", sorted((source.get("stats") or {}).keys()))
for path in ("threads?filter=recent&limit=8","decisions?limit=8"):
    d=read(path)
    print("INTAKE",path,"total",d.get("total"),"visible",len(d.get("items",[])))
import subprocess
command=["runuser","-u","dsh-agent","--","env","HOME=/srv/dsh-agent",
    "PATH=/opt/dsh-toolchain/bin:/usr/local/bin:/usr/bin:/bin",
    "/srv/dsh-agent/.local/bin/gh-agent","api","notifications?all=true&per_page=50"]
result=subprocess.run(command,capture_output=True,text=True,timeout=22)
print("AGENT_NOTIFICATIONS_API_EXIT",result.returncode)
if result.returncode==0:
    data=json.loads(result.stdout)
    matches=[n for n in data if (n.get("repository") or {}).get("full_name","").lower()=="grunvald91/ai_growth_os"]
    print("AGENT_NOTIFICATIONS_MATCHING_REPO",len(matches))
    for n in matches[:8]:
        print("NOTIFICATION",n.get("reason"),n.get("subject",{}).get("url","").rsplit("/",1)[-1],
              "updated_at",n.get("updated_at"))
else:
    print("AGENT_NOTIFICATIONS_API_ERROR_CATEGORY", "403" if "403" in result.stderr else "401" if "401" in result.stderr else "other")
