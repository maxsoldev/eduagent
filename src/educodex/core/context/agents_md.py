"""AGENTS.md discovery: project instructions written by humans for agents.

Mirrors codex-rs/core/src/agents_md.rs and core/src/context/user_instructions.rs:
  1. global file in the harness home (AGENTS.override.md, else AGENTS.md)
  2. project files from the git root down to cwd (one per directory, override wins)
  3. joined with blank lines; a "--- project-doc ---" separator marks where project files start
"""

from pathlib import Path

from educodex.core.context.fragments import Fragment

CANDIDATES = ("AGENTS.override.md", "AGENTS.md")
PROJECT_DOC_SEPARATOR = "\n\n--- project-doc ---\n\n"
PROJECT_DOC_MAX_BYTES = 32 * 1024


def _first_existing(directory: Path) -> Path | None:
    for name in CANDIDATES:
        candidate = directory / name
        if candidate.is_file() and candidate.read_text().strip():
            return candidate
    return None


def _project_dirs(cwd: Path) -> list[Path]:
    """Directories from the project root (nearest ancestor with .git) down to cwd."""
    for ancestor in [cwd, *cwd.parents]:
        if (ancestor / ".git").exists():
            dirs = [cwd]
            while dirs[-1] != ancestor:
                dirs.append(dirs[-1].parent)
            return list(reversed(dirs))
    return [cwd]


def discover(cwd: Path, home: Path) -> list[Path]:
    """All instruction files that apply, global first."""
    found = [p for p in [_first_existing(home)] if p]
    found += [p for d in _project_dirs(cwd) if (p := _first_existing(d))]
    return found


def render_agents_md(cwd: Path, home: Path) -> Fragment | None:
    paths = discover(cwd, home)
    if not paths:
        return None
    text, remaining = "", PROJECT_DOC_MAX_BYTES
    for index, path in enumerate(paths):
        contents = path.read_text()[:remaining]
        remaining -= len(contents)
        is_project = path.parent != home
        if index:
            previous_is_project = paths[index - 1].parent != home
            text += PROJECT_DOC_SEPARATOR if is_project and not previous_is_project else "\n\n"
        text += contents
        if remaining <= 0:
            break
    return Fragment(
        kind="agents_md",
        role="user",
        text=f"# AGENTS.md instructions for {cwd}\n\n<INSTRUCTIONS>\n{text}\n</INSTRUCTIONS>",
        source=", ".join(str(p) for p in paths),
    )
