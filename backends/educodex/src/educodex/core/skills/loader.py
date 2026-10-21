"""Skill discovery: find every SKILL.md in the skill roots and read its frontmatter.

Mirrors codex-rs/ext/skills/src/host_roots.rs (roots), loader/discovery.rs (scan),
skills/src/parser.rs (frontmatter) and loader/host_merge.rs (dedupe and order).

Roots, in Codex's order (<home> is Codex's $CODEX_HOME):
  <home>/skills           user    (Codex marks it deprecated but still reads it)
  ~/.agents/skills        user
  <home>/skills/.system   system  (bundled skills, see system.py)
  .agents/skills          repo    (in every directory from the project root down to cwd)

A SKILL.md starts with YAML frontmatter:
  ---
  name: my-skill              (optional: defaults to the folder name; at most 64 characters)
  description: When to use it (required)
  ---
"""

from dataclasses import dataclass, field
from pathlib import Path

import yaml

from educodex.core.config import Config
from educodex.core.context.agents_md import project_dirs

SKILLS_FILENAME = "SKILL.md"
SYSTEM_SKILLS_DIR = ".system"
MAX_NAME_LEN = 64
MAX_SCAN_DEPTH = 6
SCOPE_RANK = {"repo": 0, "user": 1, "system": 2, "admin": 3}


@dataclass(frozen=True)
class SkillRoot:
    path: Path
    scope: str  # repo | user | system (Codex also has admin: /etc/codex/skills)


@dataclass(frozen=True)
class Skill:
    """SkillMetadata in Codex (skills/src/model.rs)."""

    name: str
    description: str
    short_description: str | None
    path: Path  # the SKILL.md where it was found (not resolved through symlinks)
    scope: str
    root: Path  # the skill root it was found in


@dataclass(frozen=True)
class SkillError:
    path: Path
    message: str


@dataclass
class SkillLoadOutcome:
    roots: list[SkillRoot] = field(default_factory=list)
    skills: list[Skill] = field(default_factory=list)
    errors: list[SkillError] = field(default_factory=list)


class SkillParseError(Exception):
    pass


def system_skills_root(home: Path) -> Path:
    return home / "skills" / SYSTEM_SKILLS_DIR


def skill_roots(config: Config) -> list[SkillRoot]:
    roots = [
        SkillRoot(config.home / "skills", "user"),
        SkillRoot(Path.home() / ".agents" / "skills", "user"),
        SkillRoot(system_skills_root(config.home), "system"),
    ]
    roots += [SkillRoot(d / ".agents" / "skills", "repo") for d in project_dirs(config.cwd)
              if (d / ".agents" / "skills").is_dir()]
    unique: list[SkillRoot] = []
    for root in roots:  # dedupe by exact path, first one wins
        if root.path not in [r.path for r in unique]:
            unique.append(root)
    return unique


def find_skill_files(root: SkillRoot) -> list[Path]:
    """Every SKILL.md under the root, up to 6 folders deep, skipping hidden folders."""
    found: list[Path] = []

    def walk(directory: Path, depth: int) -> None:
        try:
            entries = sorted(directory.iterdir())
        except OSError:  # a missing root is simply empty
            return
        for entry in entries:
            if entry.name == SKILLS_FILENAME and entry.is_file():
                found.append(entry)
            elif entry.is_dir() and not entry.name.startswith(".") and depth < MAX_SCAN_DEPTH:
                if entry.is_symlink() and root.scope == "system":  # Codex follows symlinks except here
                    continue
                walk(entry, depth + 1)

    walk(root.path, 0)
    return found


def _single_line(value: object) -> str:
    return " ".join(str(value).split()) if value is not None else ""


def parse_skill_frontmatter(contents: str, default_name: str) -> tuple[str, str, str | None]:
    """Return (name, description, short_description) or raise SkillParseError."""
    lines = contents.splitlines()
    closing = next((i for i, line in enumerate(lines) if i > 0 and line.strip() == "---"), None)
    if not lines or lines[0].strip() != "---" or closing in (None, 1):  # also an empty block
        raise SkillParseError("missing YAML frontmatter delimited by ---")
    try:
        data = yaml.safe_load("\n".join(lines[1:closing])) or {}
    except yaml.YAMLError as err:
        raise SkillParseError(f"invalid YAML: {err}") from err
    if not isinstance(data, dict):
        raise SkillParseError("invalid YAML: frontmatter is not a mapping")
    name = _single_line(data.get("name")) or default_name
    description = _single_line(data.get("description"))
    metadata = data.get("metadata")
    if not isinstance(metadata, dict):
        metadata = {}
    short_description = _single_line(metadata.get("short-description")) or None
    if len(name) > MAX_NAME_LEN:
        raise SkillParseError(f"invalid name: exceeds maximum length of {MAX_NAME_LEN} characters")
    if not description:
        raise SkillParseError("missing field `description`")
    return name, description, short_description


def load_skill(path: Path, root: SkillRoot) -> Skill:
    name, description, short = parse_skill_frontmatter(path.read_text(), _single_line(path.parent.name) or "skill")
    return Skill(name, description, short, path, root.scope, root.path)


def load_skills(config: Config) -> SkillLoadOutcome:
    """Scan all roots. Codex caches this per cwd; we scan again on every turn."""
    outcome = SkillLoadOutcome(roots=skill_roots(config))
    seen: set[Path] = set()
    for root in outcome.roots:
        for path in find_skill_files(root):
            if path.resolve() in seen:  # the same SKILL.md through two roots or a symlink
                continue
            seen.add(path.resolve())
            try:
                outcome.skills.append(load_skill(path, root))
            except (SkillParseError, OSError, UnicodeDecodeError) as err:
                if root.scope != "system":  # Codex drops broken system skills silently
                    outcome.errors.append(SkillError(path, str(err)))
    # Skills with the same name from different roots are all kept; `$name` then matches none.
    outcome.skills.sort(key=lambda s: (SCOPE_RANK[s.scope], s.name, str(s.path)))
    return outcome
