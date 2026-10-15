"""The TUI drives a real `app-server --listen stdio://` child process (fake model)."""

import asyncio
import json

from textual.widgets import RichLog

from educodex.tui import ApprovalScreen, EducodexTui


async def test_tui_turn_over_stdio(workspace, tmp_path, monkeypatch):
    monkeypatch.setenv("EDUCODEX_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("OPENROUTER_API_KEY", "test")
    script = tmp_path / "script.json"
    script.write_text(json.dumps([
        [{"type": "function_call", "name": "exec_command", "arguments": json.dumps({"cmd": "rm -rf nothing"})}],
        [{"type": "message", "text": "all done"}],
    ]))
    app = EducodexTui(["--cwd", str(workspace), "--fake-model", str(script)])
    async with app.run_test() as pilot:
        for _ in range(100):
            if app.thread_id:
                break
            await asyncio.sleep(0.05)
        assert app.thread_id
        await pilot.click("Input")
        await pilot.press(*"delete it", "enter")
        for _ in range(100):  # the dangerous command opens the approval modal
            if isinstance(app.screen, ApprovalScreen):
                break
            await asyncio.sleep(0.05)
        assert isinstance(app.screen, ApprovalScreen)
        await pilot.click("#decline")
        chat = app.query_one("#chat", RichLog)
        for _ in range(100):
            if any("turn completed" in str(line.text) for line in chat.lines):
                break
            await asyncio.sleep(0.05)
        text = "\n".join(str(line.text) for line in chat.lines)
        assert "all done" in text and "declined" in text
        trace = "\n".join(str(line.text) for line in app.query_one("#trace", RichLog).lines)
        assert "model request #1" in trace and "policy: exec_command → prompt" in trace


async def test_tui_slash_commands_and_skill_hints(workspace, tmp_path, monkeypatch):
    monkeypatch.setenv("EDUCODEX_HOME", str(tmp_path / "home"))
    monkeypatch.setenv("OPENROUTER_API_KEY", "test")
    script = tmp_path / "script.json"
    script.write_text("[]")
    app = EducodexTui(["--cwd", str(workspace), "--fake-model", str(script)])
    async with app.run_test() as pilot:
        for _ in range(100):
            if app.thread_id:
                break
            await asyncio.sleep(0.05)
        await pilot.click("Input")
        await pilot.press(*"/mem")
        await pilot.pause()
        hints = str(app.query_one("#hints").render())
        assert "/memory-update" in hints and "/memory-drop" in hints and "/compact" not in hints
        app.query_one("Input").value = ""
        await pilot.press(*"use $")
        for _ in range(100):  # the skill list comes from skills/list
            if "$skill-creator" in str(app.query_one("#hints").render()):
                break
            await asyncio.sleep(0.05)
        assert "$skill-creator" in str(app.query_one("#hints").render())
        app.query_one("Input").value = "/memory-update"
        await pilot.press("enter")
        chat = app.query_one("#chat", RichLog)
        for _ in range(100):
            if any("memories are off" in str(line.text) for line in chat.lines):
                break
            await asyncio.sleep(0.05)
        assert any("memories are off" in str(line.text) for line in chat.lines)
