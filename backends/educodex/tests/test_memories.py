"""Memories: the read path, phase 1 input/output, and the whole /memory-update pipeline."""

import asyncio
import json
import subprocess

from educodex.core.config import Config
from educodex.core.context import world_state
from educodex.core.items import message_text
from educodex.core.memories import memory_root
from educodex.core.memories.phase1 import filter_items, redact_secrets
from educodex.core.memories.read import render_memory_instructions
from educodex.core.memories.storage import MemoryStore, Stage1Output, rollout_summary_file_stem
from tests.conftest import find


def say(text):
    return {"type": "message", "text": text}


def test_read_path_fragment(tmp_path):
    home = tmp_path / "home"
    assert render_memory_instructions(home) is None
    (memory_root(home)).mkdir(parents=True)
    (memory_root(home) / "memory_summary.md").write_text("v1\n## User preferences\n- tabs\n")
    fragment = render_memory_instructions(home)
    assert fragment.role == "developer" and fragment.text.startswith("## Memory\n\nYou have access to a memory folder")
    assert f"- {memory_root(home)}/MEMORY.md (searchable registry" in fragment.text
    assert "========= MEMORY_SUMMARY BEGINS =========\nv1\n## User preferences\n- tabs\n=" in fragment.text
    config = Config(cwd=tmp_path, home=home, developer_instructions="Be brief.")
    dev = world_state.to_messages(world_state.build_fragments(config, memories=fragment))[0]
    assert [p["text"][:9] for p in dev["content"]][:2] == ["Be brief.", "## Memory"]  # before world state


def test_phase1_input_filter_and_redaction():
    lines = [
        {"type": "session_meta", "payload": {"id": "t"}},
        {"type": "response_item", "payload": {"type": "message", "role": "developer", "content": [{"text": "perm"}]}},
        {
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [
                    {
                        "type": "input_text",
                        "text": "# AGENTS.md instructions for /x\n\n<INSTRUCTIONS>\nhi\n</INSTRUCTIONS>",
                    },
                    {"type": "input_text", "text": "<environment_context>...</environment_context>"},
                ],
            },
        },
        {
            "type": "response_item",
            "payload": {
                "type": "message",
                "role": "user",
                "content": [{"type": "input_text", "text": "<skill>\n<name>a</name>\n</skill>"}],
            },
        },
        {"type": "response_item", "payload": {"type": "reasoning", "summary": []}},
        {"type": "response_item", "payload": {"type": "function_call", "name": "exec_command", "arguments": "{}"}},
        {"type": "event_msg", "payload": {"type": "user_message", "message": "x"}},
    ]
    kept = filter_items(lines)
    assert [i["type"] for i in kept] == ["message", "function_call"]
    assert [p["text"][:5] for p in kept[0]["content"]] == ["<envi"]
    assert redact_secrets("key sk-abcdefghijklmnopqrstuvwx and password=hunter22 Bearer abcdefghijklmnopqrst") == (
        "key [REDACTED_SECRET] and password=[REDACTED_SECRET] Bearer [REDACTED_SECRET]"
    )


def test_rollout_summary_file_stem():
    memory = Stage1Output(
        "0f3c5a5e-0000-4000-8000-00000000abcd", 1_760_000_000, "m", "s", "Fix Flaky Test!", "/r", "/c"
    )
    assert rollout_summary_file_stem(memory) == "2025-10-09T08-53-20-0brn-fix_flaky_test"


def git_commits(root) -> int:
    out = subprocess.run(["git", "-C", str(root), "rev-list", "--count", "HEAD"], capture_output=True, text=True)
    return int(out.stdout.strip())


async def test_memory_update_pipeline(make_session, tmp_path):
    # An earlier thread to learn from.
    old, _, _ = await make_session([[say("Noted.")]])
    await old.run("Always use tabs in this repo.")
    await old.close()

    stage1 = {
        "raw_memory": "---\ndescription: tabs\n---\n### Task 1\nUser wants tabs.",
        "rollout_summary": "# User prefers tabs",
        "rollout_slug": "Tabs preference",
    }
    write = (
        "printf 'v1\\n## User Profile\\nLikes tabs.\\n' > memory_summary.md && "
        "printf '# Task Group: style\\n- tabs\\n' > MEMORY.md"
    )
    script = [
        [say(json.dumps(stage1))],  # phase 1: one session log
        [{"type": "function_call", "name": "exec_command", "arguments": json.dumps({"cmd": write})}],  # phase 2 agent
        [say("Memories consolidated.")],
    ]
    session, fake, events = await make_session(script, memories=True)
    assert session.memory_instructions is None  # no memory_summary.md yet
    session.start_memory_update()
    item = await session._turn_task
    assert item["status"] == "completed", item

    phase1_body = fake.requests[0]
    assert phase1_body["model"] == "openai/gpt-5.6-luna" and phase1_body["tools"] == []
    assert message_text(phase1_body["input"][0]).startswith("## Memory Writing Agent: Phase 1 (Single Rollout)")
    assert phase1_body["text"]["format"]["name"] == "codex_output_schema"
    assert "Always use tabs in this repo." in message_text(phase1_body["input"][1])
    assert item["phase1"][0]["status"] == "succeededWithOutput"

    agent_body = fake.requests[1]
    assert agent_body["model"] == "openai/gpt-5.6-terra"
    assert message_text(agent_body["input"][-1]).startswith("## Memory Writing Agent: Phase 2 (Consolidation)")
    root = memory_root(session.config.home)
    assert (root / "MEMORY.md").read_text() == "# Task Group: style\n- tabs\n"
    assert "User wants tabs." in (root / "raw_memories.md").read_text()
    assert [p.name for p in (root / "rollout_summaries").iterdir()][0].endswith("-tabs_preference.md")
    assert item["phase2"]["status"] == "succeeded" and git_commits(root) == 1
    assert not (root / "phase2_workspace_diff.md").exists()
    assert find(events, "trace/memoryAgent") and find(events, "trace/memoryExtracted")

    # New threads get the summary; this one keeps what it started with (until it compacts).
    assert session.memory_instructions is None
    fresh, _, _ = await make_session([], memories=True)
    assert "Likes tabs." in fresh.memory_instructions.text
    # The old thread is not read again, and nothing changed for phase 2.
    session.start_memory_update()
    again = await session._turn_task
    assert again["phase1"] == [] and again["phase2"]["status"] == "noChanges" and len(fake.requests) == 3
    assert MemoryStore(session.config.home).outputs[old.thread_id].rollout_slug == "Tabs preference"


async def test_memory_update_needs_the_feature(make_session):
    session, _, _ = await make_session([])
    try:
        session.start_memory_update()
    except RuntimeError as err:
        assert "memories are off" in str(err)
    else:
        raise AssertionError("expected an error")
    await asyncio.sleep(0)


def test_memory_citation_is_hidden_and_parsed():
    from educodex.core.memories.citations import parse_memory_citation, strip_citations

    text = (
        "Use tabs.\n<oai-mem-citation>\n<citation_entries>\nMEMORY.md:3-4|note=[tabs rule]\n</citation_entries>\n"
        "<rollout_ids>\nabc\n</rollout_ids>\n</oai-mem-citation>"
    )
    visible, citations = strip_citations(text)
    assert visible == "Use tabs.\n"
    assert parse_memory_citation(citations) == {
        "entries": [{"path": "MEMORY.md", "lineStart": 3, "lineEnd": 4, "note": "tabs rule"}],
        "threadIds": ["abc"],
    }
    assert strip_citations("a<oai-mem-citation>unclosed") == ("a", ["unclosed"])
    assert parse_memory_citation([]) is None
