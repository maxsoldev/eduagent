"""The core must not import educodex's observability or its hosts: they plug in through core.probe."""

import ast
from pathlib import Path

import educodex.core

FORBIDDEN = ("educodex.observe", "educodex.app_server", "educodex.cli", "educodex.tui")


def _imports(path: Path) -> list[str]:
    names = []
    for node in ast.walk(ast.parse(path.read_text(), str(path))):
        if isinstance(node, ast.Import):
            names += [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom) and node.module:
            names.append(node.module)
            names += [f"{node.module}.{alias.name}" for alias in node.names]  # from educodex import cli
    return names


def test_core_does_not_import_observe_or_hosts():
    core = Path(educodex.core.__file__).parent
    bad = [
        f"{path.relative_to(core)}: {name}"
        for path in sorted(core.rglob("*.py"))
        for name in _imports(path)
        if any(name == f or name.startswith(f + ".") for f in FORBIDDEN)
    ]
    assert bad == []
