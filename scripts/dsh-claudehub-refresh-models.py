#!/usr/bin/env python3
"""Refresh text/chat model IDs from ClaudeHub's authenticated /v1/models endpoint.

Run as dsh-agent with CLAUDEHUB_API_KEY present in environment or private
/srv/dsh-agent/.dsh/.env. Never prints credentials or raw API responses.
Only overwrites the initial, three-entry agent profile created by our bootstrap.
Never run while dsh-superagent is running.
"""
import json
import os
from pathlib import Path
import re
import sys
import tempfile
import urllib.error
import urllib.request

HOME = Path("/srv/dsh-agent")
PROFILE = HOME / ".dsh/profiles/superagent/cordis.patch.yml"
KEY_FILE = HOME / ".dsh/.env"
CATALOG = HOME / "config/claudehub-models.json"
ENDPOINT = "https://api.claudehub.fun/v1/models"

def read_key():
    env_key = os.environ.get("CLAUDEHUB_API_KEY", "").strip()
    if env_key:
        return env_key
    if KEY_FILE.is_file():
        for line in KEY_FILE.read_text().splitlines():
            if line.startswith("CLAUDEHUB_API_KEY="):
                return line.split("=", 1)[1].strip().strip('"').strip("'")
    return ""

def is_chat_model(model_id):
    lower = model_id.lower()
    if not re.fullmatch(r"[A-Za-z0-9][A-Za-z0-9._:/+-]{0,120}", model_id):
        return False
    if any(marker in lower for marker in ("embedding", "image", "video", "veo", "audio", "whisper", "speech", "tts", "banana")):
        return False
    return lower.startswith(("claude", "gpt", "deepseek", "gemini", "grok", "kimi", "glm", "qwen", "minimax"))

def fetch_models(key):
    req = urllib.request.Request(ENDPOINT, headers={
        "Authorization": "Bearer " + key, "Accept": "application/json"})
    try:
        with urllib.request.urlopen(req, timeout=25) as response:
            payload = json.load(response)
    except urllib.error.HTTPError as exc:
        raise RuntimeError(f"ClaudeHub model catalog HTTP {exc.code}") from None
    except Exception as exc:
        raise RuntimeError(f"ClaudeHub model catalog unavailable: {type(exc).__name__}") from None
    records = payload.get("data", payload.get("models", []))
    if isinstance(records, dict):
        records = list(records.values())
    if not isinstance(records, list):
        raise RuntimeError("ClaudeHub model catalog has an unsupported structure")
    ids = sorted({item.get("id", "") for item in records if isinstance(item, dict) and isinstance(item.get("id"), str)})
    return [model_id for model_id in ids if is_chat_model(model_id)]

def yaml_model_rows(model_ids, indentation):
    return "".join(" " * indentation + "- id: " + json.dumps(model_id) + "\n" for model_id in model_ids)

def main():
    if os.geteuid() == 0:
        print("REFUSED: run as isolated dsh-agent account")
        return 2
    key = read_key()
    if not key:
        print("CLAUDEHUB_KEY_MISSING: set GitHub secret CLAUDEHUB_API_KEY first")
        return 3
    models = fetch_models(key)
    claude = [model_id for model_id in models if model_id.lower().startswith("claude")]
    if not models or not claude:
        print("REFUSED: no chat models or no Claude models in authenticated catalog")
        return 4
    CATALOG.parent.mkdir(parents=True, exist_ok=True)
    CATALOG.write_text(json.dumps({"source": ENDPOINT, "models": models}, ensure_ascii=False, indent=2) + "\n")
    os.chmod(CATALOG, 0o600)
    if not PROFILE.is_file():
        print("REFUSED: no initialized DSH profile")
        return 5
    current = PROFILE.read_text()
    if len(re.findall(r"(?m)^- id: ", current)) != 3 or "- id: llm-pi-ai\n" not in current:
        print("REFUSED: DSH profile has customizations; preserve and edit manually")
        return 6
    prefix = current.split("- id: llm-pi-ai\n", 1)[0]
    provider_block = """- id: llm-pi-ai
  config:
    providers:
      claudehub-anthropic:
        apiKeyEnv: CLAUDEHUB_API_KEY
        api: anthropic-messages
        baseURL: https://api.claudehub.fun
        models:
"""
    provider_block += yaml_model_rows(claude, 10)
    provider_block += """      claudehub-openai:
        apiKeyEnv: CLAUDEHUB_API_KEY
        api: openai-completions
        baseURL: https://api.claudehub.fun/v1
        compat:
          supportsDeveloperRole: false
          maxTokensField: max_tokens
        models:
"""
    provider_block += yaml_model_rows(models, 10)
    destination = prefix + provider_block
    fd, tmp = tempfile.mkstemp(dir=PROFILE.parent, prefix=".claudehub-provider-", text=True)
    with os.fdopen(fd, "w") as f:
        f.write(destination)
    os.chmod(tmp, 0o600)
    os.replace(tmp, PROFILE)
    print(f"CLAUDEHUB_CATALOG_READY total_chat_models={len(models)} claude_models={len(claude)}")
    print("ClaudeHub model IDs saved to isolated agent profile (no key printed)")
    return 0

if __name__ == "__main__":
    try:
        sys.exit(main())
    except Exception as exc:
        print(f"CLAUDEHUB_CATALOG_ERROR: {type(exc).__name__}: {exc}")
        sys.exit(1)
