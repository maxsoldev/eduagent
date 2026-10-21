"""Skills: folders of instructions (a SKILL.md plus optional scripts/, references/, assets/).

The model sees only a short catalog (name, description, path) in every request. It reads the
full SKILL.md with its shell tool when a task matches ("progressive disclosure"). When the user
names a skill with `$name`, the harness adds the full SKILL.md to the turn.

  loader.py    find the skill roots, scan them, parse the frontmatter
  system.py    install the bundled skills into <home>/skills/.system
  render.py    the <skills_instructions> catalog and the <skill> injection
  mentions.py  `$name` mentions in the user's message -> the skills to inject

Mirrors codex-rs/skills/ and codex-rs/ext/skills/.
"""
