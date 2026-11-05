#!/usr/bin/env python3
"""Safely report relevant installed model IDs, without printing credentials."""
import json
import urllib.request
url="http://127.0.0.1:3082/orchestrator/api/models"
req=urllib.request.Request(url,headers={"x-orchestrator-request":"1"})
with urllib.request.urlopen(req,timeout=15) as response:
    obj=json.load(response)
print("DEFAULT",obj.get("default"))
for group in obj.get("groups",[]):
    print("PROVIDER",group.get("id"))
    for model in group.get("models",[]):
        identifier=model.get("id","") if isinstance(model,dict) else str(model)
        if any(x in identifier.lower() for x in ("deepseek","opus","claude")):
            print("MODEL_ID",identifier)
