"""Where educodex keeps its home and finds the guide in the eduagent repo layout."""

from pathlib import Path

from starlette.testclient import TestClient

from educodex.app_server.main import build_app
from educodex.app_server.processor import MessageProcessor
from educodex.core.config import Config


def test_default_home_is_under_the_eduagent_suite_folder(monkeypatch):
    monkeypatch.delenv("EDUCODEX_HOME", raising=False)
    assert Config(cwd=Path("/tmp")).home == Path.home() / ".eduagent" / ".educodex"


def test_home_env_override_still_wins(monkeypatch, tmp_path):
    monkeypatch.setenv("EDUCODEX_HOME", str(tmp_path / "h"))
    assert Config(cwd=Path("/tmp")).home == tmp_path / "h"


def test_app_server_serves_educodex_guide_chapters(tmp_path):
    app = build_app(MessageProcessor(Config(cwd=tmp_path, home=tmp_path / "home", api_key="t")))
    with TestClient(app) as client:
        response = client.get("/guide/05")
    assert response.status_code == 200
    assert response.text.startswith("# ")
    assert "prompt" in response.text.lower().splitlines()[0]
