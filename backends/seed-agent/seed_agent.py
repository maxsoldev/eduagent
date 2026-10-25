"""The seed agent: a chat loop, an agent loop, and one bash tool.

Every later concept (system prompt, stop conditions, more tools, context
management) grows from this seed.
Run from the repo root: uv run --no-project --env-file .env backends/seed-agent/seed_agent.py
"""

import json
import os
import subprocess
import urllib.request

TOOLS = [
    {
        "type": "function",
        "function": {
            "name": "bash",
            "description": "Run a bash command and return its output.",
            "parameters": {"type": "object", "properties": {"command": {"type": "string"}}, "required": ["command"]},
        },
    }
]


def query_llm(messages):
    request = urllib.request.Request(
        "https://openrouter.ai/api/v1/chat/completions",
        data=json.dumps({"model": "openai/gpt-6-luna", "messages": messages, "tools": TOOLS}).encode(),
        headers={"Authorization": f"Bearer {os.environ['OPENROUTER_API_KEY']}", "Content-Type": "application/json"},
    )
    return json.load(urllib.request.urlopen(request))["choices"][0]["message"]


def bash(command):
    if input(f"\n$ {command}\nRun? [y/N] ") != "y":
        return "The user declined to run this command."
    result = subprocess.run(command, shell=True, capture_output=True, text=True, timeout=30)
    return (result.stdout + result.stderr)[-4000:]


messages = []
while True:  # chat loop
    messages.append({"role": "user", "content": input("\nYou: ")})
    while True:  # agent loop
        reply = query_llm(messages)
        messages.append(reply)
        if not reply.get("tool_calls"):
            print("\nAgent:", reply["content"])
            break
        for call in reply["tool_calls"]:
            command = json.loads(call["function"]["arguments"])["command"]
            messages.append({"role": "tool", "tool_call_id": call["id"], "content": bash(command)})
