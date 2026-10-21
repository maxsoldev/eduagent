"""Model-visible names for MCP tools. Mirrors codex-rs/codex-mcp/src/tools.rs + mcp/mod.rs.

Each server becomes a `namespace` tool called `mcp__<server>`; its tools keep their own
(sanitised) names inside it. Names may only contain [A-Za-z0-9_].
"""

import re

MCP_PREFIX = "mcp__"


def sanitize(name: str) -> str:
    return re.sub(r"[^A-Za-z0-9_]", "_", name) or "_"


def namespace_for(server: str) -> str:
    ns = sanitize(server)
    return ns if ns.startswith(MCP_PREFIX) else f"{MCP_PREFIX}{ns}"


def qualified(namespace: str, tool: str) -> str:
    """Internal routing key, e.g. mcp__weather__get_forecast (Codex's legacy flat name)."""
    return f"{namespace}__{tool}"
