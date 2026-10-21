"""A tiny MCP server for demos: a notes store with one tool of each safety class.

  list_notes   readOnlyHint=true      -> runs without approval (and may run in parallel)
  add_note     no hints               -> Codex treats it as possibly side-effecting: asks first
  clear_notes  destructiveHint=true   -> always asks

Run it through educodex:  educodex exec --mcp notes="python examples/mcp/notes_server.py" "..."
"""

import json
import os
from pathlib import Path

from mcp.server.mcpserver import MCPServer
from mcp.types import ToolAnnotations

STORE = Path(os.environ.get("NOTES_FILE", Path.home() / ".eduagent" / ".educodex" / "notes.json"))
server = MCPServer("notes")


def _load() -> list[str]:
    return json.loads(STORE.read_text()) if STORE.exists() else []


def _save(notes: list[str]) -> None:
    STORE.parent.mkdir(parents=True, exist_ok=True)
    STORE.write_text(json.dumps(notes, indent=2))


@server.tool(annotations=ToolAnnotations(read_only_hint=True))
def list_notes() -> str:
    """List all saved notes."""
    notes = _load()
    return "\n".join(f"{i + 1}. {n}" for i, n in enumerate(notes)) or "(no notes)"


@server.tool()
def add_note(text: str) -> str:
    """Save a short note."""
    notes = _load() + [text]
    _save(notes)
    return f"saved note #{len(notes)}"


@server.tool(annotations=ToolAnnotations(destructive_hint=True))
def clear_notes() -> str:
    """Delete every note."""
    _save([])
    return "all notes deleted"


if __name__ == "__main__":
    server.run()
