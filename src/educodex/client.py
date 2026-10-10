"""Talking to the model: build a Responses API request, stream the reply as events.

Mirrors codex-rs/core/src/client.rs (`build_responses_request`) and codex-api/src/sse/.
Codex's stateless HTTP path:
  * the FULL history is sent every time (`store: false`, no `previous_response_id`)
  * base instructions are the first developer message in `input` (no `instructions` field)
  * reasoning comes back encrypted (`include: ["reasoning.encrypted_content"]`) and is sent back
Skipped optimisations: WebSocket transport, prewarm, incremental requests, sticky routing.
"""

import asyncio
import json
from collections.abc import AsyncIterator
from dataclasses import dataclass, field
from typing import Any

import httpx

from educodex.items import ResponseItem, developer_message
from educodex.models import ModelInfo


@dataclass
class Prompt:
    """Everything one model request needs. Mirrors codex-rs/core/src/client_common.rs `Prompt`."""

    input: list[ResponseItem]  # history (already includes context fragments)
    tools: list[dict[str, Any]]
    base_instructions: str
    parallel_tool_calls: bool = True


@dataclass
class ResponseEvent:
    """One parsed SSE event. `type` is the Responses API event type, e.g. 'response.output_item.done'."""

    type: str
    data: dict[str, Any] = field(default_factory=dict)


class ModelError(Exception):
    pass


class ModelClient:
    def __init__(
        self,
        model: str,
        model_info: ModelInfo,
        api_key: str | None,
        base_url: str,
        session_id: str,
        reasoning_effort: str | None = None,
        reasoning_summary: str = "auto",
        transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self.model = model
        self.info = model_info
        self.session_id = session_id
        self.reasoning_effort = reasoning_effort or model_info.default_reasoning_level or "medium"
        self.reasoning_summary = reasoning_summary
        self._http = httpx.AsyncClient(
            base_url=base_url,
            headers={"Authorization": f"Bearer {api_key or ''}", "originator": "educodex", "session-id": session_id},
            timeout=httpx.Timeout(300, connect=15),
            transport=transport,
        )

    def build_request(self, prompt: Prompt) -> dict[str, Any]:
        """The exact JSON body we POST to /responses."""
        reasoning: dict[str, Any] = {"effort": self.reasoning_effort}
        if self.info.supports_reasoning_summary_parameter and self.reasoning_summary != "none":
            reasoning["summary"] = self.reasoning_summary
        body: dict[str, Any] = {
            "model": self.model,
            "input": [developer_message(prompt.base_instructions), *prompt.input],
            "tools": prompt.tools,
            "tool_choice": "auto",
            "parallel_tool_calls": prompt.parallel_tool_calls,
            "reasoning": reasoning,
            "store": False,
            "stream": True,
            "include": ["reasoning.encrypted_content"],
            "prompt_cache_key": self.session_id,
        }
        if self.info.support_verbosity and self.info.default_verbosity:
            body["text"] = {"verbosity": self.info.default_verbosity}
        return body

    async def stream(self, body: dict[str, Any]) -> AsyncIterator[ResponseEvent]:
        """POST the request and yield SSE events until response.completed.

        Retries connection errors and 5xx/429, but only before any event was yielded: after that a
        retry would replay items the caller has already recorded. (Codex's retry logic is richer.)
        """
        yielded = False
        for attempt in range(3):
            try:
                async with self._http.stream("POST", "/responses", json=body, headers={"Accept": "text/event-stream"}) as r:
                    if r.status_code >= 400:
                        detail = (await r.aread()).decode(errors="replace")[:2000]
                        if (r.status_code >= 500 or r.status_code == 429) and attempt < 2:
                            await asyncio.sleep(1 + attempt * 2)
                            continue
                        raise ModelError(f"HTTP {r.status_code}: {detail}")
                    async for event in _parse_sse(r.aiter_lines()):
                        yielded = True
                        yield event
                    return
            except (httpx.ConnectError, httpx.ReadError, httpx.RemoteProtocolError):
                if yielded or attempt == 2:
                    raise
                await asyncio.sleep(1 + attempt * 2)

    async def aclose(self) -> None:
        await self._http.aclose()


async def _parse_sse(lines: AsyncIterator[str]) -> AsyncIterator[ResponseEvent]:
    """Server-sent events: lines like `data: {...}`; a blank line ends an event."""
    async for line in lines:
        if not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        if not payload or payload == "[DONE]":
            continue
        data = json.loads(payload)
        kind = data.get("type", "")
        if kind in ("response.failed", "error"):
            error = data.get("response", {}).get("error") or data.get("error") or data
            raise ModelError(f"model stream error: {error}")
        if kind == "response.incomplete":  # codex-api/src/sse/responses.rs: an error unless interrupted
            reason = (data.get("response", {}).get("incomplete_details") or {}).get("reason", "unknown")
            if reason != "interrupted":
                raise ModelError(f"Incomplete response returned, reason: {reason}")
            kind = "response.completed"
        yield ResponseEvent(kind, data)
        if kind == "response.completed":
            return
    raise ModelError("stream closed before response.completed")
