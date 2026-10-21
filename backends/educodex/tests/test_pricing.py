"""Costs: OpenRouter prices x Responses usage, including prompt-cache reads and writes."""

import json

import pytest

from educodex.observe.pricing import add_totals, cost_breakdown, parse_pricing
from tests.conftest import find

LUNA = {
    "prompt": "0.0000001",
    "completion": "0.0000005",
    "input_cache_read": "0.00000001",
    "input_cache_write": "0.000000125",
    "overrides": [
        {
            "min_prompt_tokens": 272000,
            "prompt": "0.0000002",
            "completion": "0.00000075",
            "input_cache_read": "0.00000002",
            "input_cache_write": "0.00000025",
        }
    ],
}


def test_matches_openrouter_bill():
    """A real gpt-6-luna request: OpenRouter billed $0.000112985."""
    usage = {
        "input_tokens": 5615,
        "input_tokens_details": {"cached_tokens": 5581, "cache_write_tokens": 31},
        "output_tokens": 106,
        "cost": 0.000112985,
    }
    c = cost_breakdown(usage, parse_pricing("openai/gpt-6-luna", LUNA))
    assert c["tokens"]["uncached"] == 3
    assert c["usd"]["total"] == pytest.approx(0.000112985)
    assert c["usd"]["withoutCache"] == pytest.approx(5615 * 1e-7 + 106 * 5e-7)
    assert c["usd"]["savedByCache"] > 0 and c["cacheHitRate"] == pytest.approx(5581 / 5615, abs=1e-4)


def test_long_context_rates():
    p = parse_pricing("m", LUNA)
    assert p.rates_for(300_000).prompt == 2e-7 and p.rates_for(1000).prompt == 1e-7


def test_totals_add_up():
    a = cost_breakdown({"input_tokens": 100, "output_tokens": 10, "cost": 0.1}, parse_pricing("m", LUNA))
    total = add_totals(add_totals({}, a), a)
    assert total["requests"] == 2 and total["tokens"]["input"] == 200 and total["billedUsd"] == pytest.approx(0.2)


async def test_turn_reports_cost_and_cache_hits(make_session):
    call = {"type": "function_call", "name": "exec_command", "arguments": json.dumps({"cmd": "echo hi"})}
    session, fake, events = await make_session([[call], [{"type": "message", "text": "done"}]])
    await session.run("go")
    assert find(events, "trace/pricing")[0]["pricing"]["perMillionTokens"]["prompt"] == 0.1
    costs = find(events, "trace/cost")
    assert len(costs) == 2
    first, second = costs[0]["last"], costs[1]["last"]
    assert first["tokens"]["cached"] == 0
    assert second["tokens"]["cached"] > 1024  # the second request repeats the first as a prefix
    assert second["usd"]["savedByCache"] > 0
    assert costs[1]["total"]["requests"] == 2
