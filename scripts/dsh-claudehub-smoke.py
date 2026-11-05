#!/usr/bin/env python3
"""Minimal paid ClaudeHub API smoke tests; no credentials or response text logged."""
import json
import os
import sys
import urllib.request
import urllib.error

key = os.environ.get("CLAUDEHUB_API_KEY", "").strip()
if not key:
    print("CLAUDEHUB_API_KEY_MISSING")
    sys.exit(2)

def request(url, headers, payload=None):
    content = None if payload is None else json.dumps(payload).encode("utf-8")
    req = urllib.request.Request(url, data=content, headers=headers, method="POST" if payload else "GET")
    try:
        with urllib.request.urlopen(req, timeout=45) as resp:
            return json.load(resp)
    except urllib.error.HTTPError as exc:
        print(f"CLAUDEHUB_HTTP_ERROR status={exc.code} endpoint={url.split('/')[-1]}")
        raise RuntimeError("ClaudeHub API request rejected") from None

models = request("https://api.claudehub.fun/v1/models",
                 {"Authorization": "Bearer " + key, "Accept": "application/json"})
items = models.get("data", models.get("models", []))
ids = sorted({x.get("id") for x in items if isinstance(x, dict) and isinstance(x.get("id"), str)})
claude = [x for x in ids if x.lower().startswith("claude") and not any(y in x.lower() for y in ("image", "embedding", "audio", "video"))]
chat = [x for x in ids if x.lower().startswith(("deepseek", "qwen", "gpt", "glm", "gemini")) and not any(y in x.lower() for y in ("image", "embedding", "video", "audio", "tts"))]
if not claude or not chat:
    print("CLAUDEHUB_REQUIRED_MODEL_TYPES_MISSING")
    sys.exit(3)

def choose(models, prefers):
    for name in prefers:
        for model in models:
            if name in model.lower():
                return model
    return models[0]

claude_id = os.environ.get("DSH_CLAUDE_SMOKE_MODEL", "").strip() or choose(claude, ["haiku", "sonnet", "opus"])
chat_id = os.environ.get("DSH_CHAT_SMOKE_MODEL", "").strip() or choose(chat, ["deepseek-v4-flash", "deepseek", "qwen", "glm", "gpt"])
if claude_id not in claude or chat_id not in chat:
    print("REQUESTED_MODELS_NOT_LISTED_IN_CLAUDEHUB")
    sys.exit(4)

a = request("https://api.claudehub.fun/v1/messages",
            {"x-api-key": key, "anthropic-version": "2023-06-01", "content-type": "application/json"},
            {"model": claude_id, "max_tokens": 16, "messages": [{"role": "user", "content": "Return OK."}]})
if not a.get("content"):
    raise RuntimeError("Anthropic Messages response has no content")
print(f"ANTHROPIC_MESSAGES_OK model={claude_id}")

b = request("https://api.claudehub.fun/v1/chat/completions",
            {"Authorization": "Bearer " + key, "content-type": "application/json"},
            {"model": chat_id, "max_tokens": 16, "messages": [{"role": "user", "content": "Return OK."}]})
if not b.get("choices"):
    raise RuntimeError("OpenAI Chat Completions response has no choices")
print(f"OPENAI_COMPLETIONS_OK model={chat_id}")
print("CLAUDEHUB_TWO_PROTOCOLS_SMOKE_OK")
