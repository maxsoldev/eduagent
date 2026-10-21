"""Copy the Codex files educodex reuses into src/educodex/vendor/codex/.

Usage: uv run scripts/sync_vendor.py [path/to/codex]   (default: the codex checkout next to the repo)
Records the source commit in SOURCE.md so the copy is pinned and reviewable.
"""

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent  # backends/educodex/
REPO = ROOT.parent.parent
DEST = ROOT / "src" / "educodex" / "vendor" / "codex"

# (source path relative to the codex repo, destination relative to DEST)
FILES = [
    ("LICENSE", "LICENSE"),
    ("NOTICE", "NOTICE"),
    ("codex-rs/models-manager/models.json", "models.json"),
    ("codex-rs/core/assets/tools/apply_patch.lark", "apply_patch.lark"),
    ("codex-rs/prompts/templates/permissions", "templates/permissions"),
    ("codex-rs/prompts/templates/compact", "templates/compact"),
    ("codex-rs/skills/src/assets/samples/skill-creator", "skills/skill-creator"),
    ("codex-rs/memories/write/templates/memories", "templates/memories"),
    ("codex-rs/memories/write/templates/extensions", "templates/memories/extensions"),
    ("codex-rs/ext/memories/templates/memories/read_path.md", "templates/memories/read_path.md"),
    ("codex-rs/sandboxing/src/seatbelt_base_policy.sbpl", "seatbelt/seatbelt_base_policy.sbpl"),
    ("codex-rs/sandboxing/src/seatbelt_network_policy.sbpl", "seatbelt/seatbelt_network_policy.sbpl"),
    ("codex-rs/sandboxing/src/seatbelt_preferences_policy.sbpl", "seatbelt/seatbelt_preferences_policy.sbpl"),
    (
        "codex-rs/sandboxing/src/seatbelt_read_only_platform_defaults.sbpl",
        "seatbelt/seatbelt_read_only_platform_defaults.sbpl",
    ),
]


def main() -> None:
    codex = Path(sys.argv[1] if len(sys.argv) > 1 else REPO.parent / "codex").resolve()
    sha = subprocess.check_output(["git", "-C", codex, "rev-parse", "HEAD"], text=True).strip()
    date = subprocess.check_output(["git", "-C", codex, "log", "-1", "--format=%cs"], text=True).strip()
    if DEST.exists():
        shutil.rmtree(DEST)
    for src, dst in FILES:
        src_path, dst_path = codex / src, DEST / dst
        dst_path.parent.mkdir(parents=True, exist_ok=True)
        if src_path.is_dir():
            shutil.copytree(src_path, dst_path)
        else:
            shutil.copy2(src_path, dst_path)
    lines = [
        "# Vendored Codex files",
        "",
        f"Copied from [openai/codex](https://github.com/openai/codex) at commit `{sha}` ({date})",
        "by `scripts/sync_vendor.py`. Licensed under Apache-2.0 (see `LICENSE` and `NOTICE`).",
        "Do not edit by hand: re-run the script and review the diff.",
        "",
        "| Here | In Codex |",
        "|---|---|",
        *[f"| `{dst}` | [`{src}`](https://github.com/openai/codex/blob/{sha}/{src}) |" for src, dst in FILES],
        "",
    ]
    (DEST / "SOURCE.md").write_text("\n".join(lines))
    print(f"Vendored {len(FILES)} entries from {codex} @ {sha[:10]}")


if __name__ == "__main__":
    main()
