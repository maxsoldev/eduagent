"""Bundled ("system") skills: shipped with the harness and copied to <home>/skills/.system.

Mirrors codex-rs/skills/src/lib.rs (`install_system_skills`). Codex embeds five skills in its
binary; educodex bundles one of them, skill-creator (vendor/codex/skills/). A marker file holds
a fingerprint of the bundled files, so the copy is only rewritten when they change.
"""

import hashlib
import shutil
from pathlib import Path

from educodex import vendor
from educodex.core.skills.loader import system_skills_root

MARKER_FILENAME = ".codex-system-skills.marker"
MARKER_SALT = "v1"


def _fingerprint(directory: Path) -> str:
    digest = hashlib.sha256(MARKER_SALT.encode())
    for path in sorted(p for p in directory.rglob("*") if p.is_file()):
        digest.update(str(path.relative_to(directory)).encode())
        digest.update(path.read_bytes())
    return digest.hexdigest()


def install_system_skills(home: Path) -> None:
    source, dest = vendor.CODEX / "skills", system_skills_root(home)
    fingerprint = _fingerprint(source)
    marker = dest / MARKER_FILENAME
    if marker.is_file() and marker.read_text().strip() == fingerprint:
        return
    if dest.exists():
        shutil.rmtree(dest)
    shutil.copytree(source, dest)
    marker.write_text(fingerprint + "\n")
