"""The <environment_context> user fragment: where the agent is running.

Mirrors codex-rs/core/src/context/world_state/environment.rs and context/environment_context.rs.
"""

import datetime
import os
from pathlib import Path
from xml.sax.saxutils import escape

from educodex.core.context.fragments import Fragment


def _timezone() -> str:
    tz = os.environ.get("TZ")
    if tz:
        return tz
    try:
        link = os.readlink("/etc/localtime")  # e.g. /var/db/timezone/zoneinfo/Europe/Berlin
        return link.split("zoneinfo/", 1)[1]
    except (OSError, IndexError):
        return datetime.datetime.now().astimezone().tzname() or "UTC"


def _filesystem(sandbox_mode: str, writable_roots: list[str]) -> str:
    roots = "".join(f"<root>{escape(r)}</root>" for r in writable_roots)
    if sandbox_mode == "danger-full-access":
        profile = '<permission_profile type="disabled"><file_system type="unrestricted" /></permission_profile>'
    else:
        entries = '<entry access="read"><special>:root</special></entry>'
        if sandbox_mode == "workspace-write":
            entries += "".join(f'<entry access="write"><path>{escape(r)}</path></entry>' for r in writable_roots)
        profile = f'<permission_profile type="managed"><file_system type="restricted">{entries}</file_system></permission_profile>'
    return f"<filesystem><workspace_roots>{roots}</workspace_roots>{profile}</filesystem>"


def render_environment_context(
    cwd: Path, sandbox_mode: str, writable_roots: list[str], today: datetime.date | None = None
) -> Fragment:
    shell = Path(os.environ.get("SHELL", "/bin/zsh")).name
    lines = [
        f"  <cwd>{escape(str(cwd))}</cwd>",
        f"  <shell>{escape(shell)}</shell>",
        f"  <current_date>{(today or datetime.date.today()).isoformat()}</current_date>",
        f"  <timezone>{escape(_timezone())}</timezone>",
        f"  {_filesystem(sandbox_mode, writable_roots)}",
    ]
    body = "\n" + "\n".join(lines) + "\n"
    return Fragment(
        kind="environment_context",
        role="user",
        text=f"<environment_context>{body}</environment_context>",
        source="educodex/core/context/environment.py (cwd, $SHELL, date, timezone, sandbox)",
    )
