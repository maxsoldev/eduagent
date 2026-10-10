"""Regression tests for issues found by the Codex-fidelity reviews."""

import asyncio
import json
import sys
import time

import pytest
from starlette.testclient import TestClient
from starlette.websockets import WebSocketDisconnect

from educodex.app_server.main import build_app
from educodex.app_server.processor import MessageProcessor
from educodex.config import Config
from educodex.items import message_text
from educodex.policy.approval import decide_exec, decide_patch
from educodex.policy.rules import PrefixRule
from educodex.sandbox import seatbelt
from educodex.tools.apply_patch import apply_planned, plan_changes
from educodex.tools.processes import ProcessManager

RULES = [PrefixRule(("git", "status"), "allow"), PrefixRule(("rm",), "forbidden")]


@pytest.mark.parametrize("cmd", ["git status $(touch ~/pwn)", "git status `id`", "git status > ~/.zshrc", "git status\ntouch x"])
def test_allow_rules_never_match_complex_shell(cmd):
    d = decide_exec(cmd, "on-request", "workspace-write", RULES, False, set())
    assert d.sandboxed and not d.matched_rules


def test_forbidden_rule_wins_in_mixed_command():
    assert decide_exec("ls; rm x", "on-request", "workspace-write", RULES, False, set()).decision == "forbidden"


def test_approved_dangerous_command_stays_sandboxed():
    d = decide_exec("rm -rf build", "on-request", "workspace-write", [], False, set())
    assert (d.decision, d.sandboxed) == ("prompt", True)
    assert decide_exec("curl x", "on-request", "workspace-write", [], True, set()).sandboxed is False


def test_patch_into_git_dir_needs_approval(tmp_path):
    assert decide_patch([tmp_path / ".git/hooks/pre-commit"], "on-request", "workspace-write", [tmp_path]).decision == "prompt"


@pytest.mark.skipif(not seatbelt.available(), reason="macOS only")
def test_seatbelt_blocks_creating_git_dir():
    import shutil
    import subprocess
    import tempfile
    from pathlib import Path

    # Not under $TMPDIR: that is a writable root of its own, which would allow the write.
    ws = Path(tempfile.mkdtemp(dir=Path.home(), prefix=".educodex-test-"))
    try:
        sb = seatbelt.build(["/bin/sh", "-c", "mkdir .codex; mkdir ok"], "workspace-write", ws, False)
        subprocess.run(sb.argv, cwd=ws, capture_output=True)
        assert not (ws / ".codex").exists() and (ws / "ok").exists()
    finally:
        shutil.rmtree(ws)


def test_two_hunks_on_same_file(tmp_path):
    (tmp_path / "f.txt").write_text("a\nb\n")
    patch = ("*** Begin Patch\n*** Update File: f.txt\n@@\n-a\n+A\n*** Update File: f.txt\n@@\n-b\n+B\n"
             "*** Add File: g.txt\n+1\n*** Update File: g.txt\n@@\n-1\n+2\n*** End Patch")
    apply_planned(plan_changes(patch, tmp_path))
    assert (tmp_path / "f.txt").read_text() == "A\nB\n" and (tmp_path / "g.txt").read_text() == "2\n"


async def test_background_child_does_not_block(tmp_path):
    manager = ProcessManager()
    started = time.monotonic()
    result = await manager.start(["/bin/sh", "-c", "sleep 3 & echo hi"], str(tmp_path), None, 2000)
    assert result.exit_code == 0 and "hi" in result.output
    assert time.monotonic() - started < 2.5
    await manager.terminate_all()


def test_websocket_rejects_foreign_origin(workspace, tmp_path):
    processor = MessageProcessor(Config(cwd=workspace, home=tmp_path / "h", api_key="t"))
    with TestClient(build_app(processor)) as client:
        with pytest.raises(WebSocketDisconnect):
            with client.websocket_connect("/", headers={"origin": "https://evil.example"}) as ws:
                ws.receive_text()


async def test_interrupt_records_turn_aborted(make_session):
    session, fake, _ = await make_session([[{"type": "function_call", "name": "exec_command",
                                             "arguments": json.dumps({"cmd": "sleep 5"})}], [{"type": "message", "text": "ok"}]],
                                          sandbox_mode="danger-full-access")
    session.start_turn("go")
    await asyncio.sleep(0.5)
    session.interrupt()
    turn = await session._turn_task
    assert turn["status"] == "interrupted"
    assert message_text(session.history.items[-1]).startswith("<turn_aborted>\nThe user interrupted the previous turn on purpose.")


async def test_stop_hook_sees_active_flag(make_session, tmp_path):
    marker = tmp_path / "stop.json"
    hook = f"cat > {marker}.$$; if grep -q '\"stop_hook_active\": false' {marker}.$$; then echo 'keep going' >&2; exit 2; fi"
    session, fake, _ = await make_session([[{"type": "message", "text": "a"}], [{"type": "message", "text": "b"}]],
                                          hooks={"Stop": [hook]})
    await session.run("x")
    assert len(fake.requests) == 2  # one continuation, then the flag stops the loop
    assert message_text(fake.requests[1]["input"][-1]) == "keep going"


async def test_pre_tool_use_hook_blocks_with_codex_message(make_session, workspace):
    session, fake, _ = await make_session(
        [[{"type": "function_call", "name": "exec_command", "arguments": json.dumps({"cmd": "ls"})}], [{"type": "message", "text": "ok"}]],
        hooks={"PreToolUse": ["echo 'no ls today' >&2; exit 2"]})
    await session.run("x")
    assert fake.requests[1]["input"][-1]["output"] == "Command blocked by PreToolUse hook: no ls today. Command: ls"


async def test_recorded_items_drop_api_only_fields(make_session):
    session, fake, _ = await make_session([[{"type": "message", "text": "hi"}]])
    await session.run("x")
    assistant = session.history.items[-1]
    assert "status" not in assistant and "annotations" not in assistant["content"][0]


def test_strictest_matching_rule_wins():
    rules = [PrefixRule(("git",), "allow"), PrefixRule(("git", "push"), "forbidden")]
    assert decide_exec("git push", "on-request", "workspace-write", rules, False, set()).decision == "forbidden"


def test_escalation_under_never_is_refused_before_rules():
    rules = [PrefixRule(("curl",), "allow")]
    assert decide_exec("curl x", "never", "workspace-write", rules, True, set()).decision == "forbidden"


@pytest.mark.parametrize("cmd", ["if true; then rm -rf x; fi", "for f in a; do rm -f $f; done"])
def test_forced_rm_inside_shell_constructs(cmd):
    assert decide_exec(cmd, "on-request", "workspace-write", [], False, set()).decision == "prompt"


def test_variables_are_complex_syntax():
    d = decide_exec("git status $X", "on-request", "workspace-write", RULES, False, set())
    assert not d.matched_rules and d.sandboxed


def test_unbalanced_quotes_do_not_crash():
    assert decide_exec('echo "oops', "on-request", "workspace-write", [], False, set()).decision == "allow"


def test_nested_root_keeps_git_protection(tmp_path):
    ws = tmp_path / "ws"
    sb = seatbelt.build(["true"], "workspace-write", ws, False)
    assert str(ws / ".git") in sb.params.values()  # excluded from the $TMPDIR root too
    assert decide_patch([ws / ".git/config"], "on-request", "workspace-write", [tmp_path, ws]).decision == "prompt"


def test_hard_linked_file_needs_approval(tmp_path):
    import os

    (tmp_path / "a").write_text("x")
    os.link(tmp_path / "a", tmp_path / "b")
    assert decide_patch([tmp_path / "b"], "on-request", "workspace-write", [tmp_path]).decision == "prompt"


@pytest.mark.parametrize("cmd", ["echo a#b; touch ~/x", "echo hi |& touch ~/x"])
def test_comment_and_unknown_operators_are_opaque(cmd):
    d = decide_exec(cmd, "on-request", "workspace-write", [PrefixRule(("echo",), "allow")], False, set())
    assert not d.matched_rules and d.sandboxed


def test_hash_does_not_hide_forced_rm():
    assert decide_exec("echo a#b && rm -rf dir", "on-request", "danger-full-access", [], False, set()).decision == "prompt"


def test_model_cannot_choose_shell_binary():
    from educodex.tools.handlers import resolve_shell

    assert resolve_shell("/tmp/evil.sh") == "/bin/sh" and resolve_shell("/usr/local/bin/bash") == "/bin/bash"


def test_prefix_rule_suggestions_are_validated():
    from educodex.tools.handlers import valid_prefix_rule

    assert valid_prefix_rule("ls", "ls") is None  # not a list
    assert valid_prefix_rule(["bash"], "bash -c x") is None  # banned catch-all
    assert valid_prefix_rule(["git", "push"], "git pull") is None  # does not cover the command
    assert valid_prefix_rule(["git", "pull"], "git pull origin") == ["git", "pull"]


async def test_bad_tool_arguments_do_not_crash_the_turn(make_session):
    bad = {"type": "function_call", "name": "update_plan", "arguments": json.dumps({"plan": ["a"]})}
    session, fake, _ = await make_session([[bad], [{"type": "message", "text": "ok"}]])
    turn = await session.run("x")
    assert turn["status"] == "completed"
    assert fake.requests[1]["input"][-1]["output"].startswith("failed to parse function arguments")


def test_turn_start_while_running_keeps_settings(workspace, tmp_path):
    slow = [[{"type": "function_call", "name": "exec_command", "arguments": json.dumps({"cmd": "sleep 2"})}],
            [{"type": "message", "text": "ok"}]]
    processor = MessageProcessor(Config(cwd=workspace, home=tmp_path / "h", api_key="t", sandbox_mode="read-only"),
                                 lambda: __import__("educodex.testing.fake_model", fromlist=["FakeModel"]).FakeModel(slow))
    with TestClient(build_app(processor)) as client, client.websocket_connect("/") as ws:
        def req(i, method, params):
            ws.send_text(json.dumps({"id": i, "method": method, "params": params}))
            while (msg := json.loads(ws.receive_text())).get("id") != i or "method" in msg:
                pass
            return msg
        req(1, "initialize", {})
        assert req(2, "initialize", {})["error"]["message"] == "Already initialized"
        tid = req(3, "thread/start", {})["result"]["thread"]["id"]
        req(4, "turn/start", {"threadId": tid, "input": [{"type": "text", "text": "a"}]})
        again = req(5, "turn/start", {"threadId": tid, "input": [{"type": "text", "text": "b"}],
                                      "sandboxPolicy": {"type": "dangerFullAccess"}})
        assert "already running" in again["error"]["message"]
        assert processor.threads[tid].session.config.sandbox_mode == "read-only"
