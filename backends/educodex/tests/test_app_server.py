"""The App Server protocol over stdio, as the launcher and Codex's IDE clients use it (JSONL on stdin/stdout)."""

import json


def test_full_turn_with_approval(app_server, workspace):
    (workspace / "f.txt").write_text("x")
    server = app_server([[{"type": "function_call", "name": "exec_command", "arguments": json.dumps({"cmd": "rm -f f.txt"})}],
                         [{"type": "message", "text": "deleted"}]])
    assert server.request("thread/list")["error"]["code"] == -32600  # must initialize first
    init = server.request("initialize", {"clientInfo": {"name": "test", "version": "1"}})["result"]
    assert init["userAgent"].startswith("educodex/")
    server.send({"method": "initialized"})
    thread = server.request("thread/start", {})["result"]["thread"]
    turn = server.request("turn/start", {"threadId": thread["id"], "input": [{"type": "text", "text": "delete f.txt"}]})
    assert turn["result"]["turn"]["status"] == "inProgress"

    approval = server.until("item/commandExecution/requestApproval")
    assert "id" in approval and approval["params"]["command"] == "rm -f f.txt"
    server.send({"id": approval["id"], "result": {"decision": "accept"}})
    server.until("turn/completed")
    assert not (workspace / "f.txt").exists()
    methods = [m.get("method") for m in server.seen]
    for expected in ["thread/started", "turn/started", "item/started", "trace/modelRequest",
                     "trace/policyDecision", "item/completed", "turn/completed"]:
        assert expected in methods, expected
    assert all("jsonrpc" not in m for m in server.seen)  # JSON-RPC lite

    read = server.request("thread/read", {"threadId": thread["id"], "includeTrace": True})["result"]
    items = read["thread"]["turns"][0]["items"]
    assert [i["type"] for i in items] == ["userMessage", "commandExecution", "agentMessage"]
    assert read["trace"]
    ctx = server.request("debug/context/get", {"threadId": thread["id"]})["result"]
    assert ctx["request"]["store"] is False and ctx["historyItems"] > 0
    assert server.request("nope/method")["error"]["code"] == -32601


def test_bad_lines_are_dropped(app_server):
    server = app_server([])
    server.proc.stdin.write("not json\n\n")  # like Codex, malformed lines are dropped, not fatal
    assert server.request("initialize", {})["result"]["userAgent"].startswith("educodex/")


def test_long_lines(app_server):
    server = app_server([[{"type": "message", "text": "read it"}]])
    server.request("initialize", {})
    thread = server.request("thread/start", {})["result"]["thread"]
    long_prompt = "x" * 200_000  # a pasted file: far above asyncio's default 64 KiB line limit
    turn = server.request("turn/start", {"threadId": thread["id"], "input": [{"type": "text", "text": long_prompt}]})
    assert turn["result"]["turn"]["status"] == "inProgress"
    server.until("turn/completed")


def test_opt_out_notifications(app_server):
    server = app_server([[{"type": "message", "text": "hello there"}]])
    server.request("initialize", {"capabilities": {"optOutNotificationMethods": ["item/agentMessage/delta"]}})
    thread = server.request("thread/start", {})["result"]["thread"]
    server.request("turn/start", {"threadId": thread["id"], "input": [{"type": "text", "text": "hi"}]})
    server.until("turn/completed")
    assert "item/agentMessage/delta" not in [m.get("method") for m in server.seen]


def test_skills_list_skill_input_and_memory_methods(app_server, workspace, tmp_path):
    skill = workspace / ".agents" / "skills" / "deploy" / "SKILL.md"
    skill.parent.mkdir(parents=True)
    skill.write_text("---\nname: deploy\ndescription: Deploy the app\n---\nSteps.\n")
    home = tmp_path / "home"
    server = app_server([[{"type": "message", "text": "ok"}]])
    server.request("initialize", {"clientInfo": {"name": "test", "version": "1"}})
    thread = server.request("thread/start", {"cwd": str(workspace)})["result"]["thread"]
    listed = server.request("skills/list", {"cwds": [str(workspace)]})["result"]["data"][0]
    assert listed["cwd"] == str(workspace) and listed["errors"] == []
    assert {"name": "deploy", "scope": "repo", "path": str(skill), "enabled": True}.items() <= listed["skills"][0].items()
    # A skill picked from the `$` list arrives as a UserInput skill item; the text has no $deploy.
    server.request("turn/start", {"threadId": thread["id"], "input": [
        {"type": "text", "text": "ship it"}, {"type": "skill", "name": "deploy", "path": str(skill)}]})
    body = server.until("trace/modelRequest")["params"]["body"]  # the exact body sent to the model
    assert body["input"][-1]["content"][0]["text"].startswith("<skill>\n<name>deploy</name>")
    server.until("turn/completed")
    # Memories are off by default (Codex: [features] memories = false).
    assert "memories are off" in server.request("memory/update/start", {"threadId": thread["id"]})["error"]["message"]
    (home / "memories").mkdir(parents=True, exist_ok=True)
    (home / "memories" / "MEMORY.md").write_text("x")
    assert server.request("memory/reset")["result"] == {}
    assert not (home / "memories").exists()
