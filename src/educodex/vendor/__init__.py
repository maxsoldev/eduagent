"""Files copied verbatim from Codex by scripts/sync_vendor.py (see vendor/codex/SOURCE.md)."""

import re
from pathlib import Path

CODEX = Path(__file__).parent / "codex"


def read(relative: str) -> str:
    return (CODEX / relative).read_text()


def render(relative: str, **values: str) -> str:
    """Fill a Codex template's `{{ name }}` placeholders (codex-rs/utils/template/)."""
    # One pass, so a value that itself contains "{{ x }}" is left alone.
    return re.sub(r"\{\{ (\w+) \}\}", lambda m: values[m.group(1)], read(relative))
