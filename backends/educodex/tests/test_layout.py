"""Where educodex keeps its home in the eduagent repo layout."""

from pathlib import Path

from educodex.core.config import Config


def test_default_home_is_under_the_eduagent_suite_folder(monkeypatch):
    monkeypatch.delenv("EDUCODEX_HOME", raising=False)
    assert Config(cwd=Path("/tmp")).home == Path.home() / ".eduagent" / ".educodex"


def test_home_env_override_still_wins(monkeypatch, tmp_path):
    monkeypatch.setenv("EDUCODEX_HOME", str(tmp_path / "h"))
    assert Config(cwd=Path("/tmp")).home == tmp_path / "h"

