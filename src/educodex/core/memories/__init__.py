"""Memories: what the agent learned in earlier threads, kept as files in <home>/memories/.

Read path (read.py): every new thread gets the "## Memory" developer fragment. It holds
memory_summary.md and tells the model to grep MEMORY.md and rollout_summaries/ with its shell.

Write path (`/memory-update`, start.py), two phases:
  1. phase1.py: for each recent session log, one model call with a strict JSON schema
     extracts a raw memory and a rollout summary.
  2. phase2.py: a sandboxed sub-agent reads them and rewrites MEMORY.md and memory_summary.md.

<home>/memories/
  memory_summary.md     always in the prompt (first line must be "v1")
  MEMORY.md             searchable handbook, written by phase 2
  raw_memories.md       all phase-1 raw memories, the input of phase 2
  rollout_summaries/    one summary per session log
  extensions/ad_hoc/    notes the user asked the agent to remember
  .git/                 baseline, so phase 2 sees what changed since its last run

Mirrors codex-rs/memories/ and codex-rs/ext/memories/ (the v1 pipeline, Codex's default).
Codex starts the write path in the background on every turn (when the `memories` feature is
on); educodex runs it only when you ask, so you can watch each step.
"""

from pathlib import Path


def memory_root(home: Path) -> Path:
    return home / "memories"
