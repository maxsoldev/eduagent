"""Skills: discovery, the catalog the model sees, and `$name` injection."""

from pathlib import Path

import pytest

from educodex.core.compact import is_real_user_message
from educodex.core.config import Config
from educodex.core.context import world_state
from educodex.core.items import message_text
from educodex.core.skills.loader import SkillParseError, load_skills, parse_skill_frontmatter
from educodex.core.skills.mentions import collect_explicit_skill_mentions, extract_mentions
from educodex.core.skills.render import render_available_skills, skill_instructions
from tests.conftest import find


def write_skill(root: Path, folder: str, frontmatter: str, body: str = "Do the thing.") -> Path:
    path = root / folder / "SKILL.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    path.write_text(f"---\n{frontmatter}\n---\n\n{body}\n")
    return path


def test_frontmatter_rules():
    assert parse_skill_frontmatter("---\nname: a\ndescription: Use   it\n  now\n---\nbody", "dir") == ("a", "Use it now", None)
    assert parse_skill_frontmatter("---\ndescription: x\nmetadata:\n  short-description: s\n---", "dir") == ("dir", "x", "s")
    for bad, message in [("no frontmatter", "missing YAML frontmatter"), ("---\n---\n", "missing YAML frontmatter"),
                         ("---\nname: a\n---", "missing field `description`"),
                         (f"---\nname: {'n' * 65}\ndescription: d\n---", "exceeds maximum length of 64")]:
        with pytest.raises(SkillParseError, match=message):
            parse_skill_frontmatter(bad, "dir")


def test_discovery_roots_order_and_errors(workspace, tmp_path, user_home):
    home = tmp_path / "home"
    write_skill(workspace / ".agents" / "skills", "deploy", "name: deploy\ndescription: Deploy the app")
    write_skill(workspace / ".agents" / "skills", ".hidden/x", "name: hidden\ndescription: never found")
    write_skill(user_home / ".agents" / "skills", "notes", "name: notes\ndescription: Take notes")
    write_skill(home / "skills", "broken", "name: broken")
    sub = workspace / "pkg"
    write_skill(sub / ".agents" / "skills", "pkg-only", "name: pkg-only\ndescription: Only in pkg")
    outcome = load_skills(Config(cwd=sub, home=home))
    assert [(s.name, s.scope) for s in outcome.skills] == [("deploy", "repo"), ("pkg-only", "repo"), ("notes", "user")]
    assert [e.message for e in outcome.errors] == ["missing field `description`"]
    assert [r.scope for r in outcome.roots] == ["user", "user", "system", "repo", "repo"]


def test_catalog_text_matches_codex(workspace, tmp_path):
    home = tmp_path / "home"
    write_skill(workspace / ".agents" / "skills", "deploy", "name: deploy\ndescription: Deploy the app")
    write_skill(home / "skills", "notes", "name: notes\ndescription: Take notes")
    fragment = render_available_skills(load_skills(Config(cwd=workspace, home=home)), include_usage_instructions=False)
    assert fragment.role == "developer"
    assert fragment.text == (
        "<skills_instructions>\n## Skills\n"
        "A skill is a set of local instructions to follow that is stored in a `SKILL.md` file. Below is the list of "
        "skills that can be used. Each entry includes a name, description, and a short path that can be expanded into "
        "an absolute path using the skill roots table.\n"
        f"### Skill roots\n- `r0` = `{home / 'skills'}`\n- `r1` = `{workspace / '.agents' / 'skills'}`\n"
        "### Available skills\n"
        "- deploy: Deploy the app (file: r1/deploy/SKILL.md)\n"
        "- notes: Take notes (file: r0/notes/SKILL.md)\n</skills_instructions>")
    with_usage = render_available_skills(load_skills(Config(cwd=workspace, home=home)), include_usage_instructions=True)
    assert "### How to use skills\n- Discovery:" in with_usage.text


def test_mentions(workspace, tmp_path):
    home = tmp_path / "home"
    deploy = write_skill(workspace / ".agents" / "skills", "deploy", "name: deploy\ndescription: d")
    write_skill(home / "skills", "a", "name: twin\ndescription: d")
    write_skill(home / "skills", "b", "name: twin\ndescription: d")
    outcome = load_skills(Config(cwd=workspace, home=home))
    assert extract_mentions("use $deploy and [$x](/p/SKILL.md), not $PATH") == ({"/p/SKILL.md"}, {"deploy"})

    def names(*inputs):
        return [s.name for s in collect_explicit_skill_mentions(list(inputs), outcome)]

    assert names({"type": "text", "text": "please $deploy now"}) == ["deploy"]
    assert names({"type": "text", "text": "$twin"}) == []  # ambiguous: two skills share the name
    assert names({"type": "text", "text": f"[$whatever]({deploy})"}) == ["deploy"]
    assert names({"type": "text", "text": "$deploy"}, {"type": "skill", "name": "deploy", "path": str(deploy)}) == ["deploy"]
    assert message_text(skill_instructions(outcome.skills[0])) == (
        f"<skill>\n<name>deploy</name>\n<path>{deploy}</path>\n{deploy.read_text()}\n</skill>")


def test_catalog_goes_before_permissions(workspace, tmp_path):
    home = tmp_path / "home"
    write_skill(workspace / ".agents" / "skills", "deploy", "name: deploy\ndescription: d")
    config = Config(cwd=workspace, home=home, developer_instructions="Be brief.")
    dev = world_state.to_messages(world_state.build_fragments(config, load_skills(config)))[0]
    texts = [p["text"] for p in dev["content"]]
    assert texts[0] == "Be brief." and texts[1].startswith("<skills_instructions>")
    assert texts[2].startswith("<permissions instructions>")
    config.include_skill_instructions = False
    dev = world_state.to_messages(world_state.build_fragments(config, load_skills(config)))[0]
    assert not any(p["text"].startswith("<skills_instructions>") for p in dev["content"])


async def test_turn_injects_mentioned_skill(make_session, workspace):
    deploy = write_skill(workspace / ".agents" / "skills", "deploy", "name: deploy\ndescription: Deploy the app")
    session, fake, events = await make_session([[{"type": "message", "text": "ok"}], [{"type": "message", "text": "ok"}]])
    await session.run("please $deploy it")
    body = fake.requests[0]["input"]
    catalog = message_text(body[1])
    assert catalog.startswith("<skills_instructions>") and "- deploy: Deploy the app (file: r1/deploy/SKILL.md)" in catalog
    assert "- skill-creator: Create or update a Codex skill" in catalog  # the bundled system skill
    assert message_text(body[-2]) == "please $deploy it"
    assert message_text(body[-1]).startswith("<skill>\n<name>deploy</name>")
    assert not is_real_user_message(body[-1])  # compaction drops injected skills like other context
    assert find(events, "trace/skillInjected")[0]["path"] == str(deploy)
    # The catalog did not change, so the second turn does not repeat it.
    await session.run("thanks")
    second = fake.requests[1]["input"][len(body) + 1:]
    assert [message_text(i) for i in second if i.get("type") == "message"] == ["thanks"]


async def test_failed_system_skills_install_does_not_stop_the_thread(make_session, tmp_path, capsys):
    # Two backend processes can share one home and install at the same time. Codex logs and goes on.
    (tmp_path / "home").mkdir()
    (tmp_path / "home" / "skills").write_text("not a folder")
    session, _, _ = await make_session([[{"type": "message", "text": "ok"}]])
    assert (await session.run("hi"))["status"] == "completed"
    assert "failed to install system skills" in capsys.readouterr().err
