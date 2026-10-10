"""What each model request costs, and how much prompt caching saves (educodex only: Codex shows tokens, not money).

Prices come from OpenRouter's GET /models (USD per token). Each Responses usage block splits the input:

    input_tokens = uncached + cached (read from the provider's prompt cache) + cache writes
    cost         = uncached * prompt + cached * cache_read + writes * cache_write + output * completion

Cached tokens are ~10x cheaper, which is why harnesses keep every request an exact prefix of the next
(chapter 05). OpenRouter also reports the billed total as `usage.cost`; we show both.
"""

from dataclasses import dataclass
from typing import Any

import httpx


@dataclass(frozen=True)
class Rates:
    prompt: float  # USD per uncached input token
    completion: float  # USD per output token (reasoning tokens are output tokens)
    cache_read: float
    cache_write: float


@dataclass(frozen=True)
class Pricing:
    model: str
    base: Rates
    long_context: Rates | None = None  # some models charge more above a prompt size
    long_context_from: int | None = None

    def rates_for(self, input_tokens: int) -> Rates:
        if self.long_context and self.long_context_from and input_tokens >= self.long_context_from:
            return self.long_context
        return self.base

    def to_json(self) -> dict[str, Any]:
        per_million = lambda r: {k: round(v * 1e6, 6) for k, v in r.__dict__.items()}  # noqa: E731
        return {"model": self.model, "perMillionTokens": per_million(self.base),
                "longContext": per_million(self.long_context) if self.long_context else None,
                "longContextFromTokens": self.long_context_from}


def _rates(raw: dict[str, Any], fallback: Rates | None = None) -> Rates:
    def get(key: str, default: float) -> float:
        value = raw.get(key)
        return float(value) if value not in (None, "") else default

    prompt = get("prompt", fallback.prompt if fallback else 0.0)
    return Rates(prompt=prompt, completion=get("completion", fallback.completion if fallback else 0.0),
                 cache_read=get("input_cache_read", fallback.cache_read if fallback else prompt),
                 cache_write=get("input_cache_write", fallback.cache_write if fallback else prompt))


def parse_pricing(model: str, raw: dict[str, Any]) -> Pricing:
    base = _rates(raw)
    override = next(iter(raw.get("overrides") or []), None)
    if override:
        return Pricing(model, base, _rates(override, base), override.get("min_prompt_tokens"))
    return Pricing(model, base)


async def fetch_pricing(http: httpx.AsyncClient, model: str) -> Pricing | None:
    """GET /models and pick this model's prices. Returns None if the provider has no pricing."""
    response = await http.get("/models")
    response.raise_for_status()
    entry = next((m for m in response.json().get("data", []) if m.get("id") == model), None)
    return parse_pricing(model, entry["pricing"]) if entry and entry.get("pricing") else None


def cost_breakdown(usage: dict[str, Any], pricing: Pricing | None) -> dict[str, Any]:
    """Split one response's usage into tokens and dollars."""
    details = usage.get("input_tokens_details") or {}
    input_tokens = usage.get("input_tokens", 0)
    cached = details.get("cached_tokens", 0) or 0
    written = details.get("cache_write_tokens", 0) or 0
    uncached = max(input_tokens - cached - written, 0)
    output = usage.get("output_tokens", 0)
    reasoning = (usage.get("output_tokens_details") or {}).get("reasoning_tokens", 0) or 0
    result: dict[str, Any] = {
        "tokens": {"input": input_tokens, "uncached": uncached, "cached": cached, "cacheWrite": written,
                   "output": output, "reasoning": reasoning},
        "cacheHitRate": round(cached / input_tokens, 4) if input_tokens else 0.0,
        "billedUsd": usage.get("cost"),  # what OpenRouter says it charged
    }
    if pricing:
        r = pricing.rates_for(input_tokens)
        usd = {"uncachedInput": uncached * r.prompt, "cachedInput": cached * r.cache_read,
               "cacheWrite": written * r.cache_write, "output": output * r.completion}
        usd["total"] = sum(usd.values())
        usd["withoutCache"] = input_tokens * r.prompt + output * r.completion  # same request, no cache
        usd["savedByCache"] = usd["withoutCache"] - usd["total"]
        result["usd"] = usd
    return result


def add_totals(total: dict[str, Any], last: dict[str, Any]) -> dict[str, Any]:
    """Running sums over a session (tokens, dollars, billed)."""
    tokens = {k: total.get("tokens", {}).get(k, 0) + v for k, v in last["tokens"].items()}
    out: dict[str, Any] = {"tokens": tokens, "requests": total.get("requests", 0) + 1,
                           "cacheHitRate": round(tokens["cached"] / tokens["input"], 4) if tokens["input"] else 0.0}
    if last.get("usd"):
        out["usd"] = {k: total.get("usd", {}).get(k, 0.0) + v for k, v in last["usd"].items()}
    if last.get("billedUsd") is not None:
        out["billedUsd"] = (total.get("billedUsd") or 0.0) + last["billedUsd"]
    return out
