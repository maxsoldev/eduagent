"""Probe OpenRouter's Responses API for the features educodex needs to mirror Codex.

Checks: which Codex catalog models exist on OpenRouter, freeform (custom) apply_patch
tool round-trip, encrypted reasoning round-trip with store=false, and streaming events.
Run: uv run --with httpx spikes/probe_openrouter.py
"""

import json
import sys
from pathlib import Path

import httpx

ROOT = Path(__file__).resolve().parent.parent  # backends/educodex/
REPO = ROOT.parent.parent
CODEX = REPO.parent / "codex" / "codex-rs"
OUT = ROOT / "spikes" / "out"
BASE_URL = "https://openrouter.ai/api/v1"
MODEL = "openai/gpt-6-luna"


def load_api_key() -> str:
    for line in (REPO / ".env").read_text().splitlines():
        key, _, value = line.partition("=")
        if key.strip() == "OPENROUTER_API_KEY":
            return value.strip().strip("'\"")
    sys.exit("OPENROUTER_API_KEY not found in .env")


# Same tool Codex builds in core/src/tools/handlers/apply_patch_spec.rs
APPLY_PATCH_TOOL = {
    "type": "custom",
    "name": "apply_patch",
    "description": "The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.",
    "format": {
        "type": "grammar",
        "syntax": "lark",
        "definition": (CODEX / "core/assets/tools/apply_patch.lark").read_text(),
    },
}


def user(text: str) -> dict:
    return {"type": "message", "role": "user", "content": [{"type": "input_text", "text": text}]}


def request_body(input_items: list, stream: bool = False) -> dict:
    # Mirrors Codex's stateless path (core/src/client.rs): store=false + encrypted reasoning.
    return {
        "model": MODEL,
        "instructions": "You are a coding agent. Use apply_patch to edit files.",
        "input": input_items,
        "tools": [APPLY_PATCH_TOOL],
        "tool_choice": "auto",
        "parallel_tool_calls": False,
        "reasoning": {"effort": "low", "summary": "auto"},
        "store": False,
        "include": ["reasoning.encrypted_content"],
        "stream": stream,
    }


def save(name: str, data) -> None:
    OUT.mkdir(parents=True, exist_ok=True)
    (OUT / name).write_text(json.dumps(data, indent=2))


def check_models(client: httpx.Client) -> None:
    catalog = json.loads((CODEX / "models-manager/models.json").read_text())
    slugs = [m["slug"] for m in catalog["models"]]
    available = {m["id"] for m in client.get("/models").json()["data"]}
    print("== 1. Codex catalog models on OpenRouter")
    for slug in slugs:
        print(f"  {'yes' if f'openai/{slug}' in available else ' no'}  openai/{slug}")


def check_freeform_roundtrip(client: httpx.Client) -> None:
    print(f"\n== 2. Freeform apply_patch + reasoning round-trip ({MODEL})")
    history = [user("Create a file hello.txt containing the single line 'hi'.")]
    r1 = client.post("/responses", json=request_body(history))
    save("roundtrip_1.json", r1.json())
    if r1.status_code != 200:
        print(f"  FAIL request 1: HTTP {r1.status_code}: {r1.text[:500]}")
        return
    output = r1.json()["output"]
    print("  output item types:", [item["type"] for item in output])
    call = next((i for i in output if i["type"] == "custom_tool_call"), None)
    reasoning = [i for i in output if i["type"] == "reasoning"]
    print("  encrypted reasoning returned:", any(i.get("encrypted_content") for i in reasoning))
    if call is None:
        print("  FAIL: no custom_tool_call in output")
        return
    print("  custom_tool_call input:\n    " + call["input"].replace("\n", "\n    "))

    # Send the whole history back, as Codex does with store=false.
    history += output + [
        {"type": "custom_tool_call_output", "call_id": call["call_id"], "output": "Success. Updated: A hello.txt"}
    ]
    r2 = client.post("/responses", json=request_body(history))
    save("roundtrip_2.json", r2.json())
    if r2.status_code != 200:
        print(f"  FAIL request 2: HTTP {r2.status_code}: {r2.text[:500]}")
        return
    final = [i for i in r2.json()["output"] if i["type"] == "message"]
    text = final[0]["content"][0]["text"] if final else None
    print("  follow-up accepted, final message:", repr(text))


def check_streaming(client: httpx.Client) -> None:
    print("\n== 3. Streaming SSE event types")
    events: dict[str, int] = {}
    body = request_body([user("Create a file a.txt containing 'a'.")], stream=True)
    with client.stream("POST", "/responses", json=body) as r:
        if r.status_code != 200:
            print(f"  FAIL: HTTP {r.status_code}: {r.read()[:500]}")
            return
        for line in r.iter_lines():
            if line.startswith("data: ") and line != "data: [DONE]":
                kind = json.loads(line[6:]).get("type", "?")
                events[kind] = events.get(kind, 0) + 1
    save("stream_event_counts.json", events)
    for kind, count in events.items():
        print(f"  {count:4d}  {kind}")


def check_reasoning(client: httpx.Client) -> None:
    print("\n== 4. Encrypted reasoning on a harder prompt (effort=medium)")
    body = request_body([user("Is 2^61-1 prime? Answer yes or no, then one sentence why.")])
    body["reasoning"]["effort"] = "medium"
    r = client.post("/responses", json=body)
    save("reasoning.json", r.json())
    output = r.json()["output"]
    reasoning = [i for i in output if i["type"] == "reasoning"]
    print("  output item types:", [i["type"] for i in output])
    print("  encrypted_content present:", any(i.get("encrypted_content") for i in reasoning))
    print("  summary:", [s.get("text", s) for i in reasoning for s in i.get("summary", [])][:3])
    print("  reasoning tokens:", r.json()["usage"].get("output_tokens_details"))
    if reasoning:
        follow = body | {"input": body["input"] + output + [user("Thanks. Now: is 2^67-1 prime?")]}
        r2 = client.post("/responses", json=follow)
        print(
            "  reasoning item sent back accepted:",
            r2.status_code == 200,
            "" if r2.status_code == 200 else r2.text[:300],
        )


def main() -> None:
    headers = {"Authorization": f"Bearer {load_api_key()}"}
    with httpx.Client(base_url=BASE_URL, headers=headers, timeout=120) as client:
        check_models(client)
        check_freeform_roundtrip(client)
        check_streaming(client)
        check_reasoning(client)


if __name__ == "__main__":
    main()
