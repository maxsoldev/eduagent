"""The read path: the "## Memory" developer fragment.

Mirrors codex-rs/ext/memories/src/prompts.rs (`build_memory_tool_developer_instructions`) and
extension.rs. memory_summary.md (cut to 2,500 tokens) goes into Codex's read_path.md template.
No summary, no fragment. The model has no memory tool: it reads the files with its shell.
"""

from pathlib import Path

from educodex import vendor
from educodex.core.context.fragments import Fragment
from educodex.core.memories import memory_root
from educodex.core.tools.output import truncate_middle

SUMMARY_TOKEN_LIMIT = 2_500


def render_memory_instructions(home: Path) -> Fragment | None:
    root = memory_root(home)
    try:
        summary = (root / "memory_summary.md").read_text().strip()
    except OSError:
        return None
    summary, _ = truncate_middle(summary, SUMMARY_TOKEN_LIMIT)
    if not summary:
        return None
    return Fragment(
        kind="memories",
        role="developer",
        text=vendor.render("templates/memories/read_path.md", base_path=str(root), memory_summary=summary),
        source=f"{root / 'memory_summary.md'} in vendor/codex/templates/memories/read_path.md",
    )
