"""macOS Seatbelt sandbox: run a command under `sandbox-exec` with a generated policy.

Mirrors codex-rs/sandboxing/src/seatbelt.rs (`create_seatbelt_command_args_with_profile`).
The policy is built from Codex's own .sbpl files (vendor/codex/seatbelt/):

    base policy (deny by default)  + "allow reading everything"
  + "allow writing under WRITABLE_ROOT_n, except .git/.codex/.agents"   (workspace-write only)
  + network rules                                                      (only if network is enabled)

Paths are passed as -D parameters rather than pasted into the policy text.
Linux (bubblewrap/landlock) and Windows sandboxes are out of scope.
"""

import os
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

from educodex import vendor

SANDBOX_EXEC = "/usr/bin/sandbox-exec"
PROTECTED_SUBPATHS = (".git", ".codex", ".agents")  # protocol/src/permissions.rs


def available() -> bool:
    return sys.platform == "darwin" and Path(SANDBOX_EXEC).exists()


@dataclass
class SeatbeltCommand:
    argv: list[str]  # full command line, starting with sandbox-exec
    policy: str  # the policy text (shown in the trace)
    params: dict[str, str]  # -D parameters


def writable_roots(cwd: Path, exclude_tmp: bool = False) -> list[Path]:
    """workspace-write roots: cwd plus temp dirs, as in Codex's default WorkspaceWrite policy."""
    roots = [cwd] if exclude_tmp else [cwd, Path("/tmp").resolve(), Path(tempfile.gettempdir()).resolve()]
    seen: list[Path] = []
    for root in roots:
        if root not in seen:
            seen.append(root)
    return seen


def build(command: list[str], sandbox_mode: str, cwd: Path, network_access: bool,
          exclude_tmp: bool = False) -> SeatbeltCommand:
    params: dict[str, str] = {}
    sections = [vendor.read("seatbelt/seatbelt_base_policy.sbpl"), "; allow read-only file operations\n(allow file-read*)"]

    if sandbox_mode == "workspace-write":
        rules = []
        roots = writable_roots(cwd, exclude_tmp)
        for i, root in enumerate(roots):
            params[f"WRITABLE_ROOT_{i}"] = str(root)
            # Protect .git/.codex/.agents of this root and of any root nested in it (cwd under /tmp),
            # also before they exist.
            excluded = [r / name for r in roots if r.is_relative_to(root) for name in PROTECTED_SUBPATHS]
            parts = [f'(subpath (param "WRITABLE_ROOT_{i}"))']
            for j, path in enumerate(excluded):
                params[f"WRITABLE_ROOT_{i}_EXCLUDED_{j}"] = str(path)
                parts.append(f'(require-not (subpath (param "WRITABLE_ROOT_{i}_EXCLUDED_{j}")))')
            rules.append(f"(require-all {' '.join(parts)})")
        sections.append("(allow file-write*\n" + "\n".join(rules) + "\n)")

    if network_access:
        sections.append("(allow network-outbound)\n(allow network-inbound)\n" + vendor.read("seatbelt/seatbelt_network_policy.sbpl"))

    sections.append(vendor.read("seatbelt/seatbelt_preferences_policy.sbpl"))
    policy = "\n".join(sections)
    argv = [SANDBOX_EXEC, "-p", policy, *[f"-D{k}={v}" for k, v in params.items()], "--", *command]
    return SeatbeltCommand(argv, policy, params)


def sandbox_env(network_access: bool) -> dict[str, str]:
    """Env vars Codex sets for sandboxed children (core/src/spawn.rs)."""
    env = dict(os.environ, CODEX_SANDBOX="seatbelt")
    if not network_access:
        env["CODEX_SANDBOX_NETWORK_DISABLED"] = "1"
    return env
