import json
import sys
from pathlib import Path

from educodex.core.mcp.manager import needs_approval
from educodex.core.mcp.schema import sanitize_schema
from tests.conftest import find

SERVER = str(Path(__file__).parent.parent / "examples" / "mcp" / "notes_server.py")


def mcp_call(name, **args):
    return {"type": "function_call", "namespace": "mcp__notes", "name": name, "arguments": json.dumps(args)}


def test_schema_sanitizing():
    assert sanitize_schema(True) == {"type": "string"}
    assert sanitize_schema({"const": "a"}) == {"enum": ["a"], "type": "string"}
    assert sanitize_schema({"properties": {"x": {"minimum": 1}}}) == {
        "type": "object", "properties": {"x": {"minimum": 1, "type": "number"}}}


def test_annotation_approval_rules():
    assert needs_approval({"readOnlyHint": True}) is False
    assert needs_approval({"readOnlyHint": True, "destructiveHint": True}) is True
    assert needs_approval(None) is True
    assert needs_approval({"destructiveHint": False, "openWorldHint": False}) is False


async def test_mcp_tools_exposed_as_namespace_and_called(make_session, tmp_path, monkeypatch):
    monkeypatch.setenv("NOTES_FILE", str(tmp_path / "notes.json"))
    script = [[mcp_call("add_note", text="buy milk")], [mcp_call("list_notes")], [{"type": "message", "text": "ok"}]]
    servers = {"notes": {"command": sys.executable, "args": [SERVER], "env": {"NOTES_FILE": str(tmp_path / "notes.json")}}}
    session, fake, events = await make_session(script, decisions=["accept"], mcp_servers=servers)
    try:
        await session.run("note it")
    finally:
        await session.close()
    ns = fake.requests[0]["tools"][-1]
    assert ns["type"] == "namespace" and ns["name"] == "mcp__notes"
    assert [t["name"] for t in ns["tools"]] == ["add_note", "clear_notes", "list_notes"]
    listed = find(events, "trace/mcpToolsListed")[0]["tools"]
    assert next(t for t in listed if t["name"] == "list_notes")["annotations"] == {"readOnlyHint": True}
    # add_note has no hints -> asked; list_notes is read-only -> not asked.
    assert [m for m, _ in session.asked] == ["mcpServer/elicitation/request"]
    outputs = [i["output"] for i in fake.requests[2]["input"] if i["type"] == "function_call_output"]
    assert outputs[0] == "{\"result\": \"saved note #1\"}"  # structuredContent wins, as in Codex
    assert "buy milk" in outputs[1]
