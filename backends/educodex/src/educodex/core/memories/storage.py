"""Phase-1 results and the files phase 2 reads.

Codex keeps phase-1 results in SQLite (`stage1_outputs` in memories_1.sqlite, plus job tables
with leases and retries: codex-rs/state/). educodex keeps the same rows in one JSON file,
<home>/memories_1.json, outside the memory folder so the memory agent never sees it.
The file writers mirror codex-rs/memories/write/src/storage.rs.
"""

import datetime
import json
import uuid
from dataclasses import asdict, dataclass
from pathlib import Path

ROLLOUT_SUMMARIES_DIR = "rollout_summaries"
RAW_MEMORIES_FILENAME = "raw_memories.md"
MAX_RAW_MEMORIES_FOR_CONSOLIDATION = 256  # [memories] max_raw_memories_for_consolidation
MAX_UNUSED_DAYS = 30  # [memories] max_unused_days


@dataclass
class Stage1Output:
    thread_id: str
    source_updated_at: float  # mtime of the session log when it was read (epoch seconds)
    raw_memory: str  # empty: the model found nothing worth remembering
    rollout_summary: str
    rollout_slug: str | None
    rollout_path: str
    cwd: str


class MemoryStore:
    """Phase-1 outputs keyed by thread id."""

    def __init__(self, home: Path) -> None:
        self.path = home / "memories_1.json"
        data = json.loads(self.path.read_text()) if self.path.is_file() else {}
        self.outputs = {k: Stage1Output(**v) for k, v in data.get("stage1_outputs", {}).items()}

    def save(self) -> None:
        self.path.parent.mkdir(parents=True, exist_ok=True)
        self.path.write_text(json.dumps({"stage1_outputs": {k: asdict(v) for k, v in self.outputs.items()}}, indent=2))

    def phase2_selection(self, now: float) -> list[Stage1Output]:
        """Non-empty memories used in the last 30 days, newest 256, in thread-id order.
        Codex ranks by how often the model cited a memory first; we have no citations."""
        cutoff = now - MAX_UNUSED_DAYS * 86_400
        rows = [o for o in self.outputs.values() if o.raw_memory and o.source_updated_at >= cutoff]
        rows.sort(key=lambda o: o.source_updated_at, reverse=True)
        return sorted(rows[:MAX_RAW_MEMORIES_FOR_CONSOLIDATION], key=lambda o: o.thread_id)


def _iso(timestamp: float) -> str:
    return datetime.datetime.fromtimestamp(int(timestamp), datetime.UTC).isoformat()  # RFC 3339, whole seconds


def rollout_summary_file_stem(memory: Stage1Output) -> str:
    """<timestamp>-<4-char hash>[-<slug>], e.g. 2026-10-14T09-30-00-a1B2-fix_flaky_test."""
    alphabet = "0123456789abcdefghijklmnopqrstuvwxyzABCDEFGHIJKLMNOPQRSTUVWXYZ"
    timestamp, seed = memory.source_updated_at, 0
    try:
        thread_uuid = uuid.UUID(memory.thread_id)
        seed = thread_uuid.int & 0xFFFF_FFFF
        if thread_uuid.version == 7:  # Codex thread ids are UUIDv7: the time they were created
            timestamp = (thread_uuid.int >> 80) / 1000
    except ValueError:
        for byte in memory.thread_id.encode():
            seed = (seed * 31 + byte) & 0xFFFF_FFFF
    value, short_hash = seed % 14_776_336, ""
    for _ in range(4):
        short_hash = alphabet[value % 62] + short_hash
        value //= 62
    prefix = datetime.datetime.fromtimestamp(timestamp, datetime.UTC).strftime("%Y-%m-%dT%H-%M-%S") + f"-{short_hash}"
    slug = "".join(c.lower() if c.isascii() and c.isalnum() else "_" for c in (memory.rollout_slug or "")[:60])
    slug = slug.rstrip("_")
    return f"{prefix}-{slug}" if slug else prefix


def sync_rollout_summaries(root: Path, memories: list[Stage1Output]) -> None:
    """One file per selected memory; files of memories no longer selected are deleted."""
    directory = root / ROLLOUT_SUMMARIES_DIR
    directory.mkdir(parents=True, exist_ok=True)
    keep = {rollout_summary_file_stem(m) for m in memories}
    for path in directory.glob("*.md"):
        if path.stem not in keep:
            path.unlink()
    for m in memories:
        header = (
            f"thread_id: {m.thread_id}\nupdated_at: {_iso(m.source_updated_at)}\n"
            f"rollout_path: {m.rollout_path}\ncwd: {m.cwd}\n\n"
        )
        (directory / f"{rollout_summary_file_stem(m)}.md").write_text(header + m.rollout_summary + "\n")


def rebuild_raw_memories_file(root: Path, memories: list[Stage1Output]) -> None:
    body = "# Raw Memories\n\n"
    if not memories:
        body += "No raw memories yet.\n"
    else:
        body += "Merged stage-1 raw memories (stable ascending thread-id order):\n\n"
        for m in memories:
            body += (
                f"## Thread `{m.thread_id}`\nupdated_at: {_iso(m.source_updated_at)}\ncwd: {m.cwd}\n"
                f"rollout_path: {m.rollout_path}\nrollout_summary_file: {rollout_summary_file_stem(m)}.md\n\n"
                f"{m.raw_memory.strip()}\n\n"
            )
    (root / RAW_MEMORIES_FILENAME).write_text(body)
