import subprocess
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
