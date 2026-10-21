"""The App Server protocol over a real WebSocket (Starlette test client)."""

import json

from starlette.testclient import TestClient

from educodex.app_server.main import build_app
from educodex.app_server.processor import MessageProcessor
from educodex.core.config import Config
from educodex.testing.fake_model import FakeModel


def rpc_client(ws):
    counter = iter(range(1, 10_000))

    def request(method, params=None):
        rid = next(counter)
        ws.send_text(json.dumps({"id": rid, "method": method, "params": params or {}}))
        while True:
            msg = json.loads(ws.receive_text())
            if msg.get("id") == rid and "method" not in msg:
                return msg
            seen.append(msg)

    seen: list[dict] = []
    return request, seen


def test_full_turn_with_approval(workspace, tmp_path):
    (workspace / "f.txt").write_text("x")
    script = [[{"type": "function_call", "name": "exec_command", "arguments": json.dumps({"cmd": "rm -f f.txt"})}],
              [{"type": "message", "text": "deleted"}]]
    processor = MessageProcessor(Config(cwd=workspace, home=tmp_path / "home", api_key="t"), lambda: FakeModel(script))
    with TestClient(build_app(processor)) as client, client.websocket_connect("/") as ws:
        request, seen = rpc_client(ws)
        assert request("thread/list")["error"]["code"] == -32600  # must initialize first
        init = request("initialize", {"clientInfo": {"name": "test", "version": "1"}})["result"]
        assert init["userAgent"].startswith("educodex/")
        ws.send_text(json.dumps({"method": "initialized"}))
        thread = request("thread/start", {"cwd": str(workspace)})["result"]["thread"]
        turn = request("turn/start", {"threadId": thread["id"], "input": [{"type": "text", "text": "delete f.txt"}]})
        assert turn["result"]["turn"]["status"] == "inProgress"

        approval = None
        while True:
            msg = json.loads(ws.receive_text())
            seen.append(msg)
            if msg.get("method") == "item/commandExecution/requestApproval":
                approval = msg
                assert "id" in msg and msg["params"]["command"] == "rm -f f.txt"
                ws.send_text(json.dumps({"id": msg["id"], "result": {"decision": "accept"}}))
            if msg.get("method") == "turn/completed":
                break
        assert approval is not None
        assert not (workspace / "f.txt").exists()
        methods = [m.get("method") for m in seen]
        for expected in ["thread/started", "turn/started", "item/started", "trace/modelRequest",
                         "trace/policyDecision", "item/completed", "turn/completed"]:
            assert expected in methods, expected
        assert all("jsonrpc" not in m for m in seen)  # JSON-RPC lite

        read = request("thread/read", {"threadId": thread["id"], "includeTrace": True})["result"]
        items = read["thread"]["turns"][0]["items"]
        assert [i["type"] for i in items] == ["userMessage", "commandExecution", "agentMessage"]
        assert read["trace"]
        ctx = request("debug/context/get", {"threadId": thread["id"]})["result"]
        assert ctx["request"]["store"] is False and ctx["historyItems"] > 0
        assert request("nope/method")["error"]["code"] == -32601


def test_opt_out_notifications(workspace, tmp_path):
    script = [[{"type": "message", "text": "hello there"}]]
    processor = MessageProcessor(Config(cwd=workspace, home=tmp_path / "home", api_key="t"), lambda: FakeModel(script))
    with TestClient(build_app(processor)) as client, client.websocket_connect("/") as ws:
        request, seen = rpc_client(ws)
        request("initialize", {"capabilities": {"optOutNotificationMethods": ["item/agentMessage/delta"]}})
        thread = request("thread/start", {})["result"]["thread"]
        request("turn/start", {"threadId": thread["id"], "input": [{"type": "text", "text": "hi"}]})
        while (msg := json.loads(ws.receive_text())).get("method") != "turn/completed":
            seen.append(msg)
        assert "item/agentMessage/delta" not in [m.get("method") for m in seen]


def test_skills_list_skill_input_and_memory_methods(workspace, tmp_path):
    skill = workspace / ".agents" / "skills" / "deploy" / "SKILL.md"
    skill.parent.mkdir(parents=True)
    skill.write_text("---\nname: deploy\ndescription: Deploy the app\n---\nSteps.\n")
    home = tmp_path / "home"
    fake = FakeModel([[{"type": "message", "text": "ok"}]])
    processor = MessageProcessor(Config(cwd=workspace, home=home, api_key="t"), lambda: fake)
    with TestClient(build_app(processor)) as client, client.websocket_connect("/") as ws:
        request, seen = rpc_client(ws)
        request("initialize", {"clientInfo": {"name": "test", "version": "1"}})
        thread = request("thread/start", {"cwd": str(workspace)})["result"]["thread"]
        listed = request("skills/list", {"cwds": [str(workspace)]})["result"]["data"][0]
        assert listed["cwd"] == str(workspace) and listed["errors"] == []
        assert {"name": "deploy", "scope": "repo", "path": str(skill), "enabled": True}.items() <= listed["skills"][0].items()
        # A skill picked from the `$` list arrives as a UserInput skill item; the text has no $deploy.
        request("turn/start", {"threadId": thread["id"], "input": [
            {"type": "text", "text": "ship it"}, {"type": "skill", "name": "deploy", "path": str(skill)}]})
        while json.loads(ws.receive_text()).get("method") != "turn/completed":
            pass
        assert fake.requests[0]["input"][-1]["content"][0]["text"].startswith("<skill>\n<name>deploy</name>")
        # Memories are off by default (Codex: [features] memories = false).
        assert "memories are off" in request("memory/update/start", {"threadId": thread["id"]})["error"]["message"]
        (home / "memories").mkdir()
        (home / "memories" / "MEMORY.md").write_text("x")
        assert request("memory/reset")["result"] == {}
        assert not (home / "memories").exists()
