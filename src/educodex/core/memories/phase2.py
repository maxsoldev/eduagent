"""Phase 2: a sub-agent consolidates the phase-1 memories into MEMORY.md and memory_summary.md.

Mirrors codex-rs/memories/write/src/phase2.rs:
  1. make sure the memory folder has a git baseline (workspace.py)
  2. write the inputs: rollout_summaries/*.md and raw_memories.md (storage.py)
  3. git diff against the baseline; no change and valid files -> nothing to do
  4. write phase2_workspace_diff.md, the first thing the agent reads
  5. run a locked-down agent in the memory folder with the consolidation prompt
  6. check MEMORY.md and memory_summary.md, then make the folder the new baseline
The agent is a normal educodex Session: the harness runs itself. It can write only inside the
memory folder, has no network, never asks for approval, and has memories off.
Not ported: the global lock with leases and heartbeats, the 6-hour cooldown, retries.
"""

import time
from dataclasses import replace
from pathlib import Path
from typing import TYPE_CHECKING

from educodex import vendor
from educodex.core.events import Event, EventBus
from educodex.core.memories import memory_root, workspace
from educodex.core.memories.storage import MemoryStore, rebuild_raw_memories_file, sync_rollout_summaries

if TYPE_CHECKING:
    from educodex.core.turn import TurnContext

CONSOLIDATION_MODEL = "openai/gpt-5.6-terra"  # [memories] consolidation_model; Codex's default for OpenAI
REASONING_EFFORT = "medium"

# Rust constants in codex-rs/memories/write/src/lib.rs (prompt_blocks), added when extensions/ exists.
EXTENSIONS_FOLDER_STRUCTURE = """
Memory extensions (under {root}/):

- <extension_name>/instructions.md
  - Source-specific guidance for interpreting additional memory signals. If an
    extension folder exists, you must read its instructions.md to determine how to use this memory
    source.

If the user has any memory extensions, you MUST read the instructions for each extension to
determine how to use the memory source. If the workspace diff shows deleted extension resource files,
remove stale memories derived only from those resources. If it has no extension folders, continue
with the standard memory inputs only.
"""
EXTENSIONS_PRIMARY_INPUTS = """
Optional source-specific inputs:
Under `{root}/`:

- `<extension_name>/instructions.md`
  - If extension folders exist, read each instructions.md first and follow it when interpreting
    that extension's memory source.

If the workspace diff shows deleted memory extension resources, use that extension-specific deletion
signal to remove stale memories derived only from those resources.
"""


def build_consolidation_prompt(root: Path) -> str:
    extensions = root / "extensions"
    exists = extensions.is_dir()
    return vendor.render(
        "templates/memories/consolidation.md", memory_root=str(root),
        memory_extensions_folder_structure=EXTENSIONS_FOLDER_STRUCTURE.format(root=extensions) if exists else "",
        memory_extensions_primary_inputs=EXTENSIONS_PRIMARY_INPUTS.format(root=extensions) if exists else "",
        phase2_workspace_diff_file=workspace.DIFF_FILENAME)


def agent_config(parent, root: Path):
    """The parent's config, locked down (phase2.rs `agent::get_config`)."""
    return replace(
        parent, cwd=root, ephemeral=True, memories=False, mcp_servers={}, approval_policy="never",
        # Keep "no sandbox" if the user chose it; otherwise write access to the memory folder only.
        sandbox_mode="danger-full-access" if parent.sandbox_mode == "danger-full-access" else "workspace-write",
        network_access=False, exclude_tmp_writable_roots=True,
        model=CONSOLIDATION_MODEL, reasoning_effort=REASONING_EFFORT)


async def run(ctx: "TurnContext", store: MemoryStore) -> dict:
    from educodex.core.session import Session  # the sub-agent is a Session; avoid an import cycle

    parent = ctx.session
    root = memory_root(parent.config.home)
    workspace.prepare(root)
    selected = store.phase2_selection(time.time())
    sync_rollout_summaries(root, selected)
    rebuild_raw_memories_file(root, selected)
    changes = workspace.diff(root)
    if not changes.changes and workspace.validate_artifacts(root) is None:
        return {"status": "noChanges", "inputs": len(selected), "changes": []}
    workspace.write_diff_file(root, changes)
    await ctx.probe.memory_consolidation_started(ctx, len(selected), changes.changes)

    bus = EventBus()

    async def forward(event: Event) -> None:  # show the sub-agent's work in the parent's trace
        await ctx.probe.memory_agent_event(ctx, event.method, event.params)

    bus.subscribe(forward)
    agent = Session(agent_config(parent.config, root), bus, transport=parent.transport)
    try:
        await agent.start()
        turn = await agent.run(build_consolidation_prompt(root))
    finally:
        await agent.close()
    if turn["status"] != "completed":
        workspace.remove_symlinks(root)
        return {"status": "failed", "error": (turn.get("error") or {}).get("message", turn["status"]), "files": _files(root)}
    if problem := workspace.validate_artifacts(root):
        return {"status": "failed", "error": problem, "files": _files(root)}
    workspace.reset_baseline(root)
    return {"status": "succeeded", "inputs": len(selected), "changes": changes.changes, "files": _files(root),
            "agentThreadId": agent.thread_id}


def _files(root: Path) -> list[str]:
    return sorted(str(p.relative_to(root)) for p in root.rglob("*") if p.is_file() and ".git" not in p.parts)
