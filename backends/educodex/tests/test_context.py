from educodex.core.config import Config
from educodex.core.context import world_state
from educodex.core.context.agents_md import render_agents_md


def test_initial_layout_matches_codex(workspace, tmp_path):
    """Codex snapshot model_visible_layout: developer bundle, then user bundle [AGENTS.md, env]."""
    (workspace / "AGENTS.md").write_text("Use tabs.")
    config = Config(cwd=workspace, home=tmp_path / "home", developer_instructions="Be brief.")
    messages = world_state.to_messages(world_state.build_fragments(config))
    assert [m["role"] for m in messages] == ["developer", "user"]
    dev = [p["text"] for p in messages[0]["content"]]
    assert dev[0] == "Be brief." and dev[1].startswith("<permissions instructions>\nFilesystem sandboxing")
    assert dev[2].startswith("<collaboration_mode># Collaboration Mode: Default")
    assert "`sandbox_mode` is `workspace-write`" in dev[1] and dev[1].endswith("</permissions instructions>")
    user = [p["text"] for p in messages[1]["content"]]
    assert user[0] == f"# AGENTS.md instructions for {workspace}\n\n<INSTRUCTIONS>\nUse tabs.\n</INSTRUCTIONS>"
    assert user[1].startswith("<environment_context>\n  <cwd>") and user[1].endswith("</environment_context>")


def test_only_changed_fragments_are_reemitted(workspace, tmp_path):
    config = Config(cwd=workspace, home=tmp_path / "home")
    first = world_state.build_fragments(config)
    snap = world_state.snapshot(first)
    assert world_state.diff(snap, world_state.build_fragments(config)) == []
    config.approval_policy = "never"
    changed = world_state.diff(snap, world_state.build_fragments(config))
    assert [f.kind for f in changed] == ["permissions"]


def test_agents_md_merge_order(workspace, tmp_path):
    home = tmp_path / "home"
    home.mkdir()
    (home / "AGENTS.md").write_text("global")
    sub = workspace / "pkg"
    sub.mkdir()
    (workspace / "AGENTS.md").write_text("root")
    (sub / "AGENTS.md").write_text("ignored")
    (sub / "AGENTS.override.md").write_text("override")
    text = render_agents_md(sub, home).text
    assert "global\n\n--- project-doc ---\n\nroot\n\noverride" in text
