"""Tool result clearing (educodex extra): the history change, auto mode in the loop, the app-server command."""

import json

from educodex.core.clear_tool_outputs import PLACEHOLDER_PREFIX, clear_tool_outputs, run_clear_tool_outputs
from educodex.core.config import ClearToolOutputs
from educodex.core.items import user_message
from educodex.core.rollout import history_from_rollout, read_rollout
from educodex.core.turn import TurnContext
from tests.conftest import find

BIG = "line of output\n" * 50  # well above the placeholder's size


def history(*names: str) -> list[dict]:
    """A user message, then one call + output pair per tool name; call ids are c0, c1, ..."""
    items = [user_message("go")]
    for n, name in enumerate(names):
        if name == "apply_patch":
            items.append({"type": "custom_tool_call", "name": name, "input": "*** Begin Patch", "call_id": f"c{n}"})
            items.append({"type": "custom_tool_call_output", "call_id": f"c{n}", "output": BIG})
        else:
            items.append({"type": "function_call", "name": name, "arguments": "{}", "call_id": f"c{n}"})
            items.append({"type": "function_call_output", "call_id": f"c{n}", "output": BIG})
    return items


def outputs(items: list[dict]) -> list[str]:
    return [i["output"] for i in items if i["type"].endswith("_output")]


def test_keeps_the_newest_n_and_the_calls():
    before = history("exec_command", "apply_patch", "exec_command", "exec_command", "exec_command")
    result = clear_tool_outputs(before, keep=2)
    assert result.call_ids == ["c0", "c1", "c2"]
    assert [o.startswith(PLACEHOLDER_PREFIX) for o in outputs(result.history)] == [True, True, True, False, False]
    assert outputs(result.history)[0] == f"{PLACEHOLDER_PREFIX}: 188 tokens]"
    # Same items in the same order, same call ids; only the output text changed.
    assert [(i["type"], i.get("call_id")) for i in result.history] == [(i["type"], i.get("call_id")) for i in before]
    assert [i for i in result.history if not i["type"].endswith("_output")] == [
        i for i in before if not i["type"].endswith("_output")
    ]
    assert result.tokens > 500
    assert outputs(before) == [BIG] * 5  # the input list is not changed


def test_idempotent_and_cleared_outputs_do_not_count_toward_keep():
    once = clear_tool_outputs(history("a", "b", "c", "d"), keep=1).history
    assert clear_tool_outputs(once, keep=1).call_ids == []
    # Two new outputs: keep 2 keeps them; the old whole one (c3) is cleared, earlier placeholders stay.
    more = once + history("e", "f")[1:]
    more[-3]["call_id"] = more[-4]["call_id"] = "c4"
    more[-1]["call_id"] = more[-2]["call_id"] = "c5"
    again = clear_tool_outputs(more, keep=2)
    assert again.call_ids == ["c3"]
    assert outputs(again.history)[:3] == outputs(once)[:3]


def test_exclude_tools_and_short_outputs():
    items = history("exec_command", "update_plan", "mcp", "exec_command")
    items[5]["namespace"], items[5]["name"] = "mcp__notes", "list"  # an MCP namespace call
    items[2]["output"] = "ok"  # shorter than the placeholder: never worth clearing
    result = clear_tool_outputs(items, keep=0, exclude_tools=("update_plan", "mcp__notes__list"))
    assert result.call_ids == ["c3"]
    assert outputs(result.history)[:3] == ["ok", BIG, BIG]


async def test_clear_at_least_and_rollout_replay(make_session):
    session, _, events = await make_session([])
    session.history.record(*history("a", "b", "c"))
    ctx = TurnContext(session, "t")
    assert (await run_clear_tool_outputs(ctx, keep=1, clear_at_least=10_000)).call_ids == []
    assert outputs(session.history.items) == [BIG] * 3 and not find(events, "trace/toolOutputsCleared")

    for item in session.history.items:  # so the session log holds the history before the clear
        session.rollout.response_item(item)
    result = await run_clear_tool_outputs(ctx, keep=1)
    assert result.call_ids == ["c0", "c1"] and session.history.items == result.history
    assert history_from_rollout(read_rollout(session.rollout.path)) == session.history.items
    (event,) = find(events, "trace/toolOutputsCleared")
    assert event["cleared"] == 2 and event["tokensAfter"] < event["tokensBefore"]


def call(cmd: str) -> dict:
    return {"type": "function_call", "name": "exec_command", "arguments": json.dumps({"cmd": cmd})}


async def test_auto_mode_clears_mid_turn_before_compaction(make_session):
    script = [[call("seq 1 300")], [call("seq 1 300")], [call("seq 1 300")], [{"type": "message", "text": "done"}]]
    auto = ClearToolOutputs(trigger_tokens=1, keep=1)
    session, fake, events = await make_session(script, sandbox_mode="danger-full-access", clear_tool_outputs=auto)
    await session.run("count")
    cleared = find(events, "trace/toolOutputsCleared")
    assert [e["reason"] for e in cleared] == ["auto", "auto"] and not find(events, "trace/compacted")
    last = [i["output"] for i in fake.requests[-1]["input"] if i["type"] == "function_call_output"]
    assert [o.startswith(PLACEHOLDER_PREFIX) for o in last] == [True, True, False]


async def test_auto_mode_is_off_by_default_and_respects_clear_at_least(make_session):
    script = [[call("seq 1 300")], [call("seq 1 300")], [{"type": "message", "text": "done"}]]
    auto = ClearToolOutputs(trigger_tokens=1, keep=0, clear_at_least=1_000_000)
    for overrides in ({}, {"clear_tool_outputs": auto}):
        session, fake, events = await make_session(script, sandbox_mode="danger-full-access", **overrides)
        await session.run("count")
        assert not find(events, "trace/toolOutputsCleared")


def test_app_server_command(app_server):
    script = [[call("seq 1 300")], [call("seq 1 300")], [{"type": "message", "text": "done"}]]
    script.append([{"type": "message", "text": "again"}])
    server = app_server(script, "--sandbox", "danger-full-access")
    server.request("initialize", {})
    thread = server.request("thread/start", {})["result"]["thread"]["id"]
    assert server.request("thread/toolOutputs/clear", {"threadId": thread})["result"]["cleared"] == 0
    server.request("turn/start", {"threadId": thread, "input": [{"type": "text", "text": "count"}]})
    server.until("turn/completed")

    bad = server.request("thread/toolOutputs/clear", {"threadId": thread, "keep": -1})
    assert bad["error"]["code"] == -32602
    result = server.request("thread/toolOutputs/clear", {"threadId": thread, "keep": 1})["result"]
    assert result["cleared"] == 1 and result["tokensCleared"] > 0 and "Cleared 1 tool outputs" in result["message"]
    event = next(m for m in server.seen if m.get("method") == "trace/toolOutputsCleared")
    p = event["params"]
    assert p["callIds"] and p["tokensAfter"] == p["tokensBefore"] - p["tokensCleared"]  # API count minus the estimate
    again = server.request("thread/toolOutputs/clear", {"threadId": thread, "keep": 1})["result"]
    assert again["cleared"] == 0 and again["message"].startswith("Nothing to clear")

    # The next request no longer extends the last one: a prompt cache miss after the cleared output.
    server.request("turn/start", {"threadId": thread, "input": [{"type": "text", "text": "and now?"}]})
    server.until("turn/completed")
    costs = [m["params"]["last"]["tokens"] for m in server.seen if m.get("method") == "trace/cost"]
    assert costs[-1]["cached"] < costs[-2]["cached"]
