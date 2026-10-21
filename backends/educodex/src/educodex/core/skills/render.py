"""What the model sees of skills.

  * The catalog: a developer fragment `<skills_instructions>` in the developer bundle, just
    before `<permissions instructions>`. One line per skill: name, description, short path.
    The model reads a SKILL.md itself (with its shell tool) when a task matches.
  * An injected skill: when the user mentions `$name`, a user message `<skill>` with the whole
    SKILL.md goes right after the user's message.

Mirrors codex-rs/ext/skills/src/catalog_prompt.rs, render.rs, aliases.rs and fragments.rs.
Paths are shortened with root aliases (`r0` = `/path/to/root`). Codex uses the aliased form
when it is cheaper, which is the usual case; educodex always uses it.
Not ported: the context budget (2% of the context window), which shortens descriptions and
drops skills when there are too many.
"""

from educodex.core.context.fragments import Fragment
from educodex.core.items import ResponseItem, user_message
from educodex.core.skills.loader import Skill, SkillLoadOutcome

SKILLS_INTRO_WITH_HOST_ALIASES = "A skill is a set of local instructions to follow that is stored in a `SKILL.md` file. Below is the list of skills that can be used. Each entry includes a name, description, and a short path that can be expanded into an absolute path using the skill roots table."  # noqa: E501
SKILLS_HOW_TO_USE_WITH_HOST_ALIASES = """- Discovery: The list above is the skills available in this session (name + description + short path). Skill bodies live on disk at the listed paths after expanding the matching alias from `### Skill roots`.
- Trigger rules: If the user names a skill (with `$SkillName` or plain text) OR the task clearly matches a skill's description shown above, you must use that skill for that turn. Multiple mentions mean use them all. Do not carry skills across turns unless re-mentioned.
- Missing/blocked: If a named skill isn't in the list or the path can't be read, say so briefly and continue with the best fallback.
- How to use a skill (progressive disclosure):
  1) After deciding to use a skill, the main agent must expand the listed short `path` with the matching alias from `### Skill roots`, then open and read its `SKILL.md` completely before taking task actions. If a read is truncated or paginated, continue until EOF.
  2) When `SKILL.md` references relative paths (e.g., `scripts/foo.py`), resolve them relative to the directory containing that expanded `SKILL.md` first, and only consider other paths if needed.
  3) If `SKILL.md` points to extra folders such as `references/`, use its routing instructions to identify the files required for the task. The main agent must read each required instruction or reference file itself before acting on it. Do not delegate reading, summarizing, or interpreting skill instructions to a subagent. Subagents may still perform task work when the selected skill allows it.
  4) If `scripts/` exist, prefer running or patching them instead of retyping large code blocks.
  5) If `assets/` or templates exist, reuse them instead of recreating from scratch.
- Coordination and sequencing:
  - If multiple skills apply, choose the minimal set that covers the request and state the order you'll use them.
  - Announce which skill(s) you're using and why (one short line). If you skip an obvious skill, say why.
- Context hygiene:
  - Progressive disclosure applies to selecting relevant files, not partially reading a selected instruction file. Do not load unrelated references, scripts, or assets.
  - Avoid deep reference-chasing: prefer opening only files directly linked from `SKILL.md` unless you're blocked.
  - When variants exist (frameworks, providers, domains), pick only the relevant reference file(s) and note that choice.
- Safety and fallback: If a skill can't be applied cleanly (missing files, unclear instructions), state the issue, pick the next-best approach, and continue."""  # noqa: E501
MAX_CATALOG_SKILL_DESCRIPTION_CHARS = 1_024
# The host catalog lists skills by scope in this order, then by name (render.rs, CoreCompatible).
CATALOG_SCOPE_ORDER = {"system": 0, "admin": 1, "repo": 2, "user": 3}


def _description(skill: Skill) -> str:
    text = skill.description
    if len(text) > MAX_CATALOG_SKILL_DESCRIPTION_CHARS:
        text = text[: MAX_CATALOG_SKILL_DESCRIPTION_CHARS - 3] + "..."
    return text


def render_available_skills(outcome: SkillLoadOutcome, include_usage_instructions: bool) -> Fragment | None:
    if not outcome.skills:
        return None
    skills = sorted(outcome.skills, key=lambda s: (CATALOG_SCOPE_ORDER[s.scope], s.name, str(s.path)))
    # One alias per root that has skills, numbered in root discovery order.
    used = {s.root for s in skills}
    aliases = {r.path: f"r{i}" for i, r in enumerate(r for r in outcome.roots if r.path in used)}
    root_lines = [f"- `{alias}` = `{path}`" for path, alias in aliases.items()]
    skill_lines = [
        f"- {s.name}: {_description(s)} (file: {aliases[s.root]}/{s.path.relative_to(s.root)})" for s in skills
    ]
    if include_usage_instructions:  # per model in models.json; false for most current models
        skill_lines += ["### How to use skills", SKILLS_HOW_TO_USE_WITH_HOST_ALIASES]
    lines = [
        "## Skills",
        SKILLS_INTRO_WITH_HOST_ALIASES,
        "### Skill roots",
        *root_lines,
        "### Available skills",
        *skill_lines,
    ]
    return Fragment(
        kind="skills",
        role="developer",
        text="<skills_instructions>\n" + "\n".join(lines) + "\n</skills_instructions>",
        source=", ".join(str(r.path) for r in outcome.roots if r.path in used),
    )


def skill_instructions(skill: Skill) -> ResponseItem:
    """The whole SKILL.md as a user message (fragments.rs `SkillInstructions`)."""
    contents = skill.path.read_text()
    return user_message(f"<skill>\n<name>{skill.name}</name>\n<path>{skill.path}</path>\n{contents}\n</skill>")
