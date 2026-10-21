"""`/memory-update` and `/memory-drop`: run the write pipeline, or forget everything.

Mirrors codex-rs/memories/write/src/start.rs (`start_memories_startup_task`) and control.rs
(`clear_memory_roots_contents`, behind the app-server `memory/reset` method). Codex runs the
pipeline in the background when a turn starts; educodex runs it when you ask, as the session's
task (like manual compaction), so it never overlaps a turn.
"""

import shutil
from pathlib import Path
from typing import TYPE_CHECKING

from educodex import vendor
from educodex.core.memories import memory_root, phase1, phase2
from educodex.core.memories.storage import MemoryStore

if TYPE_CHECKING:
    from educodex.core.turn import TurnContext


def ensure_layout(root: Path) -> None:
    """The folder, plus the ad-hoc notes extension the read path tells the model about."""
    instructions = root / "extensions" / "ad_hoc" / "instructions.md"
    instructions.parent.mkdir(parents=True, exist_ok=True)
    if not instructions.exists():  # never overwrite: the user may have edited it
        instructions.write_text(vendor.read("templates/memories/extensions/ad_hoc/instructions.md"))


async def run_memory_update(ctx: "TurnContext") -> dict:
    session = ctx.session
    item = {"type": "memoryUpdate", "id": ctx.turn_id, "status": "inProgress"}
    await ctx.item_started(item)
    try:
        ensure_layout(memory_root(session.config.home))
        store = MemoryStore(session.config.home)
        item["phase1"] = await phase1.run(ctx, store)
        item["phase2"] = await phase2.run(ctx, store)
        item["status"] = "failed" if item["phase2"]["status"] == "failed" else "completed"
    except Exception as err:
        item.update(status="failed", error=str(err))
    # The current thread keeps its summary: Codex reads it when a thread starts (and at compaction).
    await ctx.item_completed(item)
    return item


def clear_memories(home: Path) -> None:
    """Delete everything the memory pipeline wrote."""
    shutil.rmtree(memory_root(home), ignore_errors=True)
    (home / "memories_1.json").unlink(missing_ok=True)
