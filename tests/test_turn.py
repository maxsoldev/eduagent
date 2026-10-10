"""The agentic loop end to end, against the scripted fake model."""

import json
import sys
import uuid
from pathlib import Path

import pytest

from educodex.items import message_text
from educodex.rollout import history_from_rollout, read_rollout
from tests.conftest import find, methods


def call(name, **args):
    return {"type": "function_call", "name": name, "arguments": json.dumps(args)}


def patch(text):
    return {"type": "custom_tool_call", "name": "apply_patch", "input": text}


def say(text):
    return {"type": "message", "text": text}


async def test_request_shape_matches_codex(make_session):
    session, fake, events = await make_session([[say("hi")]])
    turn = await session.run("hello")
    assert turn["status"] == "completed"
    body = fake.requests[0]
    assert body["store"] is False and body["stream"] is True
    assert body["include"] == ["reasoning.encrypted_content"]
    assert "instructions" not in body
    first = body["input"][0]
    assert first["role"] == "developer" and message_text(first).startswith("You are Codex")
    assert [i.get("role") for i in body["input"]] == ["developer", "developer", "user", "user"]
    assert message_text(body["input"][-1]) == "hello"
    assert [t["name"] for t in body["tools"]] == ["exec_command", "write_stdin", "update_plan", "apply_patch"]
    assert body["tools"][-1]["type"] == "custom" and body["tools"][-1]["format"]["syntax"] == "lark"
    assert body["prompt_cache_key"] == session.thread_id


async def test_tool_loop_and_prefix_stability(make_session, workspace):
    script = [
        [{"type": "reasoning", "summary": "look first"}, call("exec_command", cmd="echo hi")],
        [patch("*** Begin Patch\n*** Add File: a.txt\n+hello\n*** End Patch")],
        [say("done")],
    ]
    session, fake, events = await make_session(script)
    await session.run("make a file")
    assert len(fake.requests) == 3
    second, third = fake.requests[1]["input"], fake.requests[2]["input"]
    # Every request is an exact prefix of the next one (prompt caching depends on this).
    assert third[: len(second)] == second
    types = [i["type"] for i in third[4:]]
    assert types == ["reasoning", "function_call", "function_call_output", "custom_tool_call", "custom_tool_call_output"]
    assert "Process exited with code 0" in third[6]["output"] and third[6]["output"].endswith("hi\n")
    assert third[8]["output"].endswith("Success. Updated the following files:\nA a.txt\n")
    assert (workspace / "a.txt").read_text() == "hello\n"
    assert third[4]["encrypted_content"]  # reasoning is sent back as-is
    loops = find(events, "trace/loopIteration")
    assert [l["decision"] for l in loops] == ["continue", "continue", "stop"]


async def test_second_turn_appends_only_changed_context(make_session, workspace):
    session, fake, _ = await make_session([[say("one")], [say("two")]])
    await session.run("first")
    session.apply_overrides(approval_policy="never")
    await session.run("second")
    first, second = fake.requests
    added = second["input"][len(first["input"]) + 1 :]  # skip the assistant reply
    assert [i["role"] for i in added] == ["developer", "user"]
    assert message_text(added[0]).startswith("<permissions instructions>")
    assert message_text(added[1]) == "second"


async def test_dangerous_command_asks_and_decline_is_reported(make_session, workspace):
    (workspace / "keep.txt").write_text("x")
    session, fake, events = await make_session([[call("exec_command", cmd="rm -rf keep.txt")], [say("ok")]],
                                               decisions=["decline"])
    await session.run("delete it")
    assert session.asked[0][0] == "item/commandExecution/requestApproval"
    assert (workspace / "keep.txt").exists()
    output = fake.requests[1]["input"][-1]
    assert output["type"] == "function_call_output" and output["output"] == "exec command rejected by user"


async def test_cancel_interrupts_turn(make_session):
    session, fake, _ = await make_session([[call("exec_command", cmd="rm -rf x")]], decisions=["cancel"])
    turn = await session.run("go")
    assert turn["status"] == "interrupted"


@pytest.mark.skipif(sys.platform != "darwin", reason="Seatbelt is macOS only")
async def test_sandbox_blocks_writes_outside_workspace(make_session, workspace):
    outside = Path.home() / f".educodex-sandbox-test-{uuid.uuid4().hex}"  # not under a writable root ($TMPDIR is one)
    session, fake, events = await make_session([[call("exec_command", cmd=f"echo x > {outside}")], [say("ok")]])
    await session.run("try")
    assert not outside.exists()
    assert "operation not permitted" in fake.requests[1]["input"][-1]["output"].lower()
    assert find(events, "trace/sandboxDenied")


async def test_long_running_command_returns_session_and_write_stdin(make_session):
    script = [
        [call("exec_command", cmd="read line; echo got:$line", yield_time_ms=300)],
        [call("write_stdin", session_id=1001, chars="hello\n", yield_time_ms=2000)],
        [say("ok")],
    ]
    session, fake, _ = await make_session(script, sandbox_mode="danger-full-access")
    await session.run("interact")
    first_output = fake.requests[1]["input"][-1]["output"]
    assert "Process running with session ID 1001" in first_output
    second_output = fake.requests[2]["input"][-1]["output"]
    assert "Process exited with code 0" in second_output and "got:hello" in second_output


async def test_update_plan_emits_plan_event(make_session):
    plan = [{"step": "a", "status": "in_progress"}, {"step": "b", "status": "pending"}]
    session, fake, events = await make_session([[call("update_plan", plan=plan)], [say("ok")]])
    await session.run("plan")
    assert find(events, "turn/plan/updated")[0]["plan"][0] == {"step": "a", "status": "inProgress"}
    assert fake.requests[1]["input"][-1]["output"] == "Plan updated"


async def test_compaction_replaces_history(make_session):
    big = {"input_tokens": 300_000, "output_tokens": 10, "total_tokens": 300_010}
    session, fake, events = await make_session([[call("exec_command", cmd="echo a")], [say("SUMMARY TEXT")], [say("final")]])
    fake.usage = [big]
    await session.run("long task")
    compact_req = fake.requests[1]
    assert compact_req["tools"] == []
    assert message_text(compact_req["input"][-1]).startswith("You are performing a CONTEXT CHECKPOINT COMPACTION")
    after = fake.requests[2]["input"]
    texts = [message_text(i) for i in after if i.get("type") == "message"]
    assert texts[-1].startswith("Another language model started to solve this problem") and texts[-1].endswith("SUMMARY TEXT")
    assert "long task" in texts
    assert "item/completed" in methods(events) and find(events, "trace/compacted")


async def test_rollout_replays_history(make_session):
    session, fake, _ = await make_session([[call("exec_command", cmd="echo a")], [say("done")]])
    await session.run("go")
    lines = read_rollout(session.rollout.path)
    assert lines[0]["type"] == "session_meta"
    assert {"turn_context", "response_item", "event_msg"} <= {l["type"] for l in lines}
    assert history_from_rollout(lines) == session.history.items


async def test_unknown_tool_and_bad_arguments(make_session):
    bad = {"type": "function_call", "name": "exec_command", "arguments": "{not json"}
    session, fake, _ = await make_session([[call("nope"), bad], [say("ok")]])
    await session.run("x")
    outputs = [i["output"] for i in fake.requests[1]["input"] if i["type"] == "function_call_output"]
    assert outputs[0] == "unsupported call: nope" and outputs[1].startswith("failed to parse function arguments")
