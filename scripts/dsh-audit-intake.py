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

from datetime import datetime,timezone
print("VPS_CURRENT_UTC",datetime.now(timezone.utc).isoformat(timespec="seconds"))
settings=read("settings")
for source in settings.get("sources",[]):
    if source.get("id")=="github":
        config=(source.get("value") or {}).get("config") or {}
        print("GITHUB_OBSERVE_FLAGS", {k:config.get(k) for k in ("observeIssues","observeComments","pollSeconds")})
for source in read("sources"):
    if source.get("id")=="github":
        print("SOURCE_RECEIVED_STATS",source.get("stats"))
for since in ("2026-11-05T10:50:00Z","2026-11-05T10:58:00Z"):
    cmd=command.copy()
    cmd[-1]="notifications?all=true&per_page=100&since="+since
    result=subprocess.run(cmd,capture_output=True,text=True,timeout=20)
    if result.returncode==0:
        arr=json.loads(result.stdout)
        matching=[x for x in arr if (x.get("repository") or {}).get("full_name","").lower()=="grunvald91/ai_growth_os"]
        print("NOTIFICATION_SINCE",since,"repo_count",len(matching),"match278",any(str((x.get("subject") or {}).get("url","")).endswith("/278") for x in matching))
    else:
        print("NOTIFICATION_SINCE_ERROR",since,result.returncode)

for label,route in [
 ("ISSUE_STREAM","repos/grunvald91/Ai_growth_os/issues?state=all&sort=updated&direction=asc&per_page=100&since=2026-11-05T10:58:00Z"),
 ("COMMENT_STREAM","repos/grunvald91/Ai_growth_os/issues/comments?sort=updated&direction=asc&per_page=100&since=2026-11-05T10:58:00Z"),
]:
    cmd=command.copy()
    cmd[-1]=route
    result=subprocess.run(cmd,capture_output=True,text=True,timeout=22)
    if result.returncode:
        print(label,"API_FAILED",result.returncode)
    else:
        arr=json.loads(result.stdout)
        print(label,"count",len(arr),"test_issue_numbers",
              sorted({x.get("number") for x in arr if x.get("number") in (278,279)}) if label=="ISSUE_STREAM" else
              sorted({str(x.get("issue_url","")).rsplit("/",1)[-1] for x in arr if str(x.get("issue_url","")).endswith(("/278","/279"))}))
