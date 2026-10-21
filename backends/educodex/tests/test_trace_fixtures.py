"""Seam A against the protocol spec: educodex's model, tool, cost and step-mode trace events have the
shapes of the fixtures in protocol/fixtures/trace/educodex/ and the shared fields of
protocol/fixtures/trace/shared.json."""

import json
from pathlib import Path

FIXTURES = Path(__file__).resolve().parents[3] / "protocol" / "fixtures" / "trace"


def json_type(value) -> str:
    if value is None:
        return "null"
    if isinstance(value, bool):
        return "boolean"
    if isinstance(value, (int, float)):
        return "number"
    return {str: "string", list: "array", dict: "object"}[type(value)]


def shape_errors(fixture, actual, path="") -> list[str]:
    """Same rule as protocol/shape.ts: fixture keys must be there with the same JSON type (objects recursively)."""
    want, got = json_type(fixture), json_type(actual)
    if want != got:
        return [f"{path or '(root)'}: expected {want}, got {got}"]
    if want != "object":
        return []
    return [
        err
        for key, value in fixture.items()
        for err in (
            shape_errors(value, actual[key], f"{path}.{key}" if path else key)
            if key in actual
            else [f"{path}.{key}: missing" if path else f"{key}: missing"]
        )
    ]


def test_model_trace_events_match_the_protocol_fixtures(app_server):
    call = {"type": "function_call", "name": "exec_command", "arguments": json.dumps({"cmd": "echo hi"})}
    # The last response is the summary of a manual compaction, for the compaction events.
    server = app_server(
        [[call], [{"type": "message", "text": "Hello there."}], [{"type": "message", "text": "## Progress\n- greeted"}]]
    )
    server.request("initialize", {"clientInfo": {"name": "test", "version": "1"}})
    server.send({"method": "initialized"})
    thread = server.request("thread/start", {"traceSse": True})["result"]["thread"]
    # Step mode on, for the paused and resumed events: release each pause until the turn completes.
    server.request("debug/stepMode/set", {"threadId": thread["id"], "enabled": True})
    server.request("turn/start", {"threadId": thread["id"], "input": [{"type": "text", "text": "Hi?"}]})
    while (msg := server.until_any("trace/paused", "turn/completed"))["method"] == "trace/paused":
        server.send(
            {
                "id": f"continue-{msg['params']['_seq']}",
                "method": "debug/continue",
                "params": {"threadId": thread["id"]},
            }
        )
    server.request("thread/compact/start", {"threadId": thread["id"]})
    server.until("thread/compacted")

    shared = json.loads((FIXTURES / "shared.json").read_text())
    for name, fields in shared.items():
        fixture = json.loads((FIXTURES / "educodex" / f"{name}.json").read_text())
        # stream events differ by type: compare with an event of the fixture's type. The model
        # events of the last request (the text reply) match the fixtures; the first is a tool call.
        actual = [
            m
            for m in server.seen
            if m.get("method") == fixture["method"]
            and (name != "streamEvent" or m["params"]["event"]["type"] == fixture["params"]["event"]["type"])
        ][-1]
        assert shape_errors(fixture, actual) == [], name
        for field, kind in fields.items():
            assert json_type(actual["params"][field]) == kind, f"{name}.{field}"
    request = next(m for m in server.seen if m.get("method") == "trace/modelRequest")
    assert request["params"]["api"] == "openai-responses"
