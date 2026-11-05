#!/usr/bin/env python3
"""Set proven ClaudeHub model IDs for Superagent routing and code execution.
Keeps Github task source, credentials and production workloads unchanged.
"""
import json
import time
import urllib.request
BASE="http://127.0.0.1:3082/orchestrator/api/"
HEAD={"x-orchestrator-request":"1","content-type":"application/json"}

def api(method,path,body=None):
    data=None if body is None else json.dumps(body).encode()
    req=urllib.request.Request(BASE+path,data=data,headers=HEAD,method=method)
    with urllib.request.urlopen(req,timeout=25) as resp:
        return json.load(resp)
def settings():
    for _ in range(20):
        try: return api("GET","settings")
        except OSError: time.sleep(2)
    raise RuntimeError("DSH settings API not responding")

models=api("GET","models")
def available(provider,model):
    return any(x.get("id")==provider and any(y.get("id")==model for y in x.get("models",[]))
               for x in models.get("groups",[]))
router={"provider":"claudehub-openai","model":"deepseek-v4.1-flash"}
executor={"provider":"claudehub-anthropic","model":"claude-opus-5-5"}
for role,route in (("router",router),("worker",executor)):
    if route["provider"] not in models.get("routableProviders",[]) or not available(**route):
        raise RuntimeError(f"{role} model not available in current DSH catalog")
s=settings()
for block,model in (("eval",router),("executor",executor)):
    current=s["blocks"][block]
    value=dict(current["value"])
    value["model"]=model
    result=api("PUT","settings/"+block,{"value":value,"revision":current["revision"]})
    print("ROLE_MODEL_SAVED",block,model["provider"],model["model"],"revision",result.get("revision"))
    s=settings()
print("MODEL_OVERRIDE_SAVED_RESTART_REQUIRED")
