"""A fake Responses API: replays scripted model outputs as SSE, and records every request.

Used by the tests, by `--fake-model script.json` on exec/app-server/tui (offline demos, UI tests),
and as a readable example of what the real stream looks like.

A script is a list of responses; each response is a list of output items, e.g.
    [{"type": "function_call", "name": "exec_command", "arguments": "{\"cmd\": \"ls\"}"}],
    [{"type": "message", "text": "Done."}]
Shorthand: {"type": "message", "text": ...} and {"type": "reasoning", "summary": ...}.
"""

import json
import uuid
from typing import Any

import httpx


def _expand(item: dict[str, Any]) -> dict[str, Any]:
    item = dict(item)
    kind = item["type"]
    if kind == "message" and "text" in item:
        item = {
            "type": "message",
            "role": "assistant",
            "status": "completed",
            "content": [{"type": "output_text", "text": item.pop("text"), "annotations": []}],
        }
    elif kind == "reasoning" and isinstance(item.get("summary"), str):
        item["summary"] = [{"type": "summary_text", "text": item["summary"]}]
        item.setdefault("encrypted_content", "gAAAA-fake-encrypted-reasoning")
    elif kind in ("function_call", "custom_tool_call"):
        item.setdefault("call_id", f"call_{uuid.uuid4().hex[:12]}")
        item.setdefault("status", "completed")
    item.setdefault("id", f"{kind[:2]}_{uuid.uuid4().hex[:12]}")
    return item


def sse_events(items: list[dict[str, Any]], usage: dict[str, int] | None = None) -> list[dict[str, Any]]:
    """The SSE events a real Responses stream would send for these output items."""
    response_id = f"resp_{uuid.uuid4().hex[:12]}"
    events: list[dict[str, Any]] = [{"type": "response.created", "response": {"id": response_id}}]
    for index, item in enumerate(_expand(i) for i in items):
        events.append(
            {
                "type": "response.output_item.added",
                "output_index": index,
                "item": {**item, "content": []} if item["type"] == "message" else item,
            }
        )
        if item["type"] == "message":
            text = item["content"][0]["text"]
            for start in range(0, len(text), 12):
                events.append(
                    {"type": "response.output_text.delta", "item_id": item["id"], "delta": text[start : start + 12]}
                )
        elif item["type"] == "reasoning":
            for i, s in enumerate(item.get("summary", [])):
                events.append(
                    {
                        "type": "response.reasoning_summary_text.delta",
                        "item_id": item["id"],
                        "summary_index": i,
                        "delta": s["text"],
                    }
                )
        events.append({"type": "response.output_item.done", "output_index": index, "item": item})
    usage = usage or {"input_tokens": 1000, "output_tokens": 50, "total_tokens": 1050}
    events.append({"type": "response.completed", "response": {"id": response_id, "usage": usage}})
    return events


# openai/gpt-6-luna's OpenRouter prices (USD per token, 2026-10), so offline demos show real-looking costs.
FAKE_PRICING = {
    "prompt": "0.0000001",
    "completion": "0.0000005",
    "input_cache_read": "0.00000001",
    "input_cache_write": "0.000000125",
}
FAKE_MODELS = ["openai/gpt-6-luna", "openai/gpt-5.5", "openai/gpt-6-sol"]


class FakeModel(httpx.AsyncBaseTransport):
    """httpx transport serving scripted responses in order. `requests` keeps every JSON body sent."""

    def __init__(self, script: list[list[dict[str, Any]]], usage: list[dict[str, int]] | None = None) -> None:
        self.script = list(script)
        self.usage = usage or []
        self.requests: list[dict[str, Any]] = []
        self._previous_prompt: list[Any] | None = None

    async def handle_async_request(self, request: httpx.Request) -> httpx.Response:
        if request.method == "GET" and request.url.path.endswith("/models"):
            return httpx.Response(200, json={"data": [{"id": m, "pricing": FAKE_PRICING} for m in FAKE_MODELS]})
        body = json.loads(request.content or b"{}")
        self.requests.append(body)
        index = len(self.requests) - 1
        items = (
            self.script[index]
            if index < len(self.script)
            else [{"type": "message", "text": "(fake model: script exhausted)"}]
        )
        usage = self.usage[index] if index < len(self.usage) else self._simulated_usage(body, items)
        payload = "".join(f"data: {json.dumps(e)}\n\n" for e in sse_events(items, usage))
        return httpx.Response(200, headers={"content-type": "text/event-stream"}, content=payload.encode())

    def _simulated_usage(self, body: dict[str, Any], items: list[dict[str, Any]]) -> dict[str, Any]:
        """Usage like OpenAI's prompt cache: the longest prefix shared with the previous request is
        cached (if >= 1024 tokens, in 128-token steps); the rest is written to the cache."""

        def tokens(value: Any) -> int:
            return (len(json.dumps(value, ensure_ascii=False).encode()) + 3) // 4

        prompt = [{"tools": body.get("tools")}, *body.get("input", [])]
        total = sum(tokens(i) for i in prompt)
        cached = 0
        if self._previous_prompt:
            for mine, theirs in zip(prompt, self._previous_prompt, strict=False):
                if mine != theirs:
                    break
                cached += tokens(mine)
        cached = cached // 128 * 128 if cached >= 1024 else 0
        self._previous_prompt = prompt
        output = sum(tokens(_expand(i)) for i in items)
        reasoning = sum(tokens(i.get("summary", "")) * 3 for i in items if i.get("type") == "reasoning")
        p = {k: float(v) for k, v in FAKE_PRICING.items()}
        cost = (
            (total - cached) * p["input_cache_write"]
            + cached * p["input_cache_read"]
            + (output + reasoning) * p["completion"]
        )
        return {
            "input_tokens": total,
            "input_tokens_details": {"cached_tokens": cached, "cache_write_tokens": total - cached},
            "output_tokens": output + reasoning,
            "output_tokens_details": {"reasoning_tokens": reasoning},
            "total_tokens": total + output + reasoning,
            "cost": round(cost, 9),
        }

    @classmethod
    def from_file(cls, path: str) -> "FakeModel":
        with open(path) as f:
            data = json.load(f)
        return cls(data["responses"] if isinstance(data, dict) else data)
