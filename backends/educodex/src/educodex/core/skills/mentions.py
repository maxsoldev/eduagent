"""Explicit skill use: which skills did the user ask for in this turn?

Mirrors codex-rs/skills/src/mentions.rs (`extract_tool_mentions`) and selection.rs
(`collect_explicit_skill_mentions`). In order:
  1. `{"type": "skill", "name", "path"}` input items (a client picked the skill from a list)
     match by path.
  2. `[$name](path/to/SKILL.md)` links in the text match by path.
  3. Plain `$name` matches only if exactly one loaded skill has that name. `$PATH`, `$HOME` and
     similar environment variables are never skill mentions.
"""

import re
from pathlib import Path

from educodex.core.skills.loader import Skill, SkillLoadOutcome

NAME = r"[A-Za-z0-9_:-]+"
LINKED_MENTION = re.compile(rf"\[\$({NAME})\]\s*\(([^)]*)\)")
PLAIN_MENTION = re.compile(rf"\$({NAME})")
COMMON_ENV_VARS = {"PATH", "HOME", "USER", "SHELL", "PWD", "TMPDIR", "TEMP", "TMP", "LANG", "TERM", "XDG_CONFIG_HOME"}
NOT_SKILL_PREFIXES = ("app://", "mcp://", "plugin://")


def extract_mentions(text: str) -> tuple[set[str], set[str]]:
    """Return (linked paths, plain names) mentioned in the text."""
    paths = {
        m.group(2).strip()
        for m in LINKED_MENTION.finditer(text)
        if m.group(1).upper() not in COMMON_ENV_VARS and m.group(2).strip()
    }
    plain_text = LINKED_MENTION.sub(" ", text)  # a linked mention is not also a plain one
    names = {m.group(1) for m in PLAIN_MENTION.finditer(plain_text) if m.group(1).upper() not in COMMON_ENV_VARS}
    return paths, names


def _same_file(skill: Skill, path: str) -> bool:
    candidate = Path(path.removeprefix("skill://")).expanduser()
    return candidate == skill.path or candidate.resolve() == skill.path.resolve()


def collect_explicit_skill_mentions(inputs: list[dict], outcome: SkillLoadOutcome) -> list[Skill]:
    selected: list[Skill] = []
    blocked_names = {i.get("name") for i in inputs if i.get("type") == "skill"}

    def select(skill: Skill) -> None:
        if all(s.path != skill.path for s in selected):
            selected.append(skill)

    for item in inputs:
        if item.get("type") == "skill":
            for skill in outcome.skills:
                if _same_file(skill, item.get("path", "")):
                    select(skill)
                    break
    counts: dict[str, int] = {}
    for skill in outcome.skills:
        counts[skill.name] = counts.get(skill.name, 0) + 1
    for item in inputs:
        if item.get("type") != "text":
            continue
        paths, names = extract_mentions(item.get("text", ""))
        paths = {p for p in paths if not p.startswith(NOT_SKILL_PREFIXES)}
        for skill in outcome.skills:
            if any(_same_file(skill, p) for p in paths):
                select(skill)
        for skill in outcome.skills:
            if skill.name in names and skill.name not in blocked_names and counts[skill.name] == 1:
                if all(s.name != skill.name for s in selected):
                    select(skill)
    return selected
