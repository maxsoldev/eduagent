"""Files copied verbatim from Codex by scripts/sync_vendor.py (see vendor/codex/SOURCE.md)."""

from pathlib import Path

CODEX = Path(__file__).parent / "codex"


def read(relative: str) -> str:
    return (CODEX / relative).read_text()
