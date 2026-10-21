import json
import os
import queue
import subprocess
import sys
import threading
from pathlib import Path

import pytest

from educodex.core.config import Config
from educodex.core.events import EventBus
from educodex.core.session import Session
from educodex.observe.tracer import Tracer
from educodex.testing.fake_model import FakeModel


@pytest.fixture(autouse=True)
def user_home(tmp_path: Path, monkeypatch) -> Path:
    """A fake $HOME, so ~/.agents/skills of the real user never leaks into a test."""
    home = tmp_path / "user-home"
    home.mkdir()
    monkeypatch.setenv("HOME", str(home))
    return home


@pytest.fixture
def workspace(tmp_path: Path) -> Path:
    ws = tmp_path / "ws"
    ws.mkdir()
    subprocess.run(["git", "init", "-q"], cwd=ws, check=True)
    return ws


@pytest.fixture
async def make_session(workspace: Path, tmp_path: Path):
    """make_session(script, **config) -> (session, fake_model, events)"""
    created = []

    async def factory(script, decisions=None, **overrides):
        fake = FakeModel(script)
        bus = EventBus()
        events = []
        bus.subscribe(events.append)
        answers = list(decisions or [])
        asked = []

        async def ask(method, params):
            asked.append((method, params))
            answer = answers.pop(0) if answers else "decline"
            return {"action": answer} if method == "mcpServer/elicitation/request" else {"decision": answer}

        config = Config(cwd=workspace, home=tmp_path / "home", api_key="test", **overrides)
        session = Session(config, bus, ask, transport=fake, probe=Tracer())
        session.asked = asked
        await session.start()
        created.append(session)
        return session, fake, events

    yield factory
    for session in created:
        await session.close()


def methods(events):
    return [e.method for e in events]


def find(events, method):
    return [e.params for e in events if e.method == method]


class StdioClient:
    """Drives `educodex app-server --listen stdio://` as a child process: one JSON message per line."""

    def __init__(self, proc: subprocess.Popen):
        self.proc = proc
        self.lines: queue.Queue = queue.Queue()
        self.seen: list[dict] = []  # every message that was not a reply we waited for
        self._ids = iter(range(1, 1_000_000))
        threading.Thread(target=lambda: [self.lines.put(line) for line in proc.stdout], daemon=True).start()

    def send(self, message: dict) -> None:
        self.proc.stdin.write(json.dumps(message) + "\n")
        self.proc.stdin.flush()

    def recv(self, timeout: float = 15) -> dict:
        return json.loads(self.lines.get(timeout=timeout))

    def request(self, method: str, params: dict | None = None) -> dict:
        rid = next(self._ids)
        self.send({"id": rid, "method": method, "params": params or {}})
        while (msg := self.recv()).get("id") != rid or "method" in msg:
            self.seen.append(msg)
        return msg

    def until(self, method: str) -> dict:
        """Read messages (kept in `seen`) until a notification or request with this method arrives."""
        return self.until_any(method)

    def until_any(self, *methods: str) -> dict:
        """Like until, for the first of several methods."""
        while (msg := self.recv()).get("method") not in methods:
            self.seen.append(msg)
        self.seen.append(msg)
        return msg


@pytest.fixture
def app_server(workspace: Path, tmp_path: Path):
    """app_server(script, *flags) -> StdioClient running in `workspace` with a fake model and a temp home."""
    procs = []

    def start(script, *flags):
        path = tmp_path / f"script{len(procs)}.json"
        path.write_text(json.dumps(script))
        env = {**os.environ, "EDUCODEX_HOME": str(tmp_path / "home"), "OPENROUTER_API_KEY": "test"}
        proc = subprocess.Popen(
            [
                sys.executable,
                "-m",
                "educodex.cli",
                "app-server",
                "--listen",
                "stdio://",
                "--fake-model",
                str(path),
                *flags,
            ],
            cwd=workspace,
            env=env,
            text=True,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
        )
        procs.append(proc)
        return StdioClient(proc)

    yield start
    for proc in procs:
        proc.stdin.close()  # EOF: the server shuts down, like Codex's stdio transport
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()
