"""Exec policy rules: user-written allow/prompt/forbid rules for command prefixes.

Mirrors codex-rs/execpolicy/ (README.md). Codex reads Starlark files; we read the same call syntax
with Python's `ast` module, supporting only `prefix_rule(pattern=[...], decision="...")`:

    prefix_rule(pattern=["git", "status"], decision="allow")
    prefix_rule(pattern=["git", "push"], decision="prompt", justification="pushing is visible to others")
    prefix_rule(pattern=["rm", "-rf"], decision="forbidden")
"""

import ast
from dataclasses import dataclass
from pathlib import Path

DECISIONS = ("allow", "prompt", "forbidden")
STRICTNESS = {d: i for i, d in enumerate(DECISIONS)}  # forbidden is strictest

# Prefixes a model may never propose as an allow rule: they would approve almost anything
# (copied from codex-rs/core/src/exec_policy.rs BANNED_PREFIX_SUGGESTIONS).
BANNED_PREFIX_SUGGESTIONS = {
    ("/bin/bash",),
    ("/bin/bash", "-c"),
    ("/bin/bash", "-lc"),
    ("/bin/sh",),
    ("/bin/sh", "-c"),
    ("/bin/sh", "-lc"),
    ("/bin/zsh",),
    ("/bin/zsh", "-c"),
    ("/bin/zsh", "-lc"),
    ("Rscript",),
    ("bash",),
    ("bash", "-c"),
    ("bash", "-lc"),
    ("bun",),
    ("bun", "-e"),
    ("bun", "run"),
    ("cmd",),
    ("cmd", "/c"),
    ("cmd", "/k"),
    ("cmd.exe",),
    ("cmd.exe", "/c"),
    ("cmd.exe", "/k"),
    ("dash",),
    ("dash", "-c"),
    ("deno",),
    ("deno", "eval"),
    ("env",),
    ("fish",),
    ("fish", "-c"),
    ("git",),
    ("julia",),
    ("julia", "-e"),
    ("ksh",),
    ("ksh", "-c"),
    ("lua",),
    ("lua", "-e"),
    ("node",),
    ("node", "-e"),
    ("nodejs",),
    ("nodejs", "-e"),
    ("npm", "run"),
    ("osascript",),
    ("perl",),
    ("perl", "-e"),
    ("php",),
    ("php", "-r"),
    ("pnpm", "run"),
    ("powershell",),
    ("powershell", "-Command"),
    ("powershell", "-EncodedCommand"),
    ("powershell", "-File"),
    ("powershell", "-c"),
    ("powershell.exe",),
    ("powershell.exe", "-Command"),
    ("powershell.exe", "-EncodedCommand"),
    ("powershell.exe", "-File"),
    ("powershell.exe", "-c"),
    ("pwsh",),
    ("pwsh", "-Command"),
    ("pwsh", "-EncodedCommand"),
    ("pwsh", "-File"),
    ("pwsh", "-c"),
    ("pwsh", "-e"),
    ("pwsh", "-ec"),
    ("pwsh", "-f"),
    ("py",),
    ("py", "-3"),
    ("pypy",),
    ("pypy3",),
    ("python",),
    ("python", "-"),
    ("python", "-c"),
    ("python3",),
    ("python3", "-"),
    ("python3", "-c"),
    ("pythonw",),
    ("pyw",),
    ("rm",),
    ("ruby",),
    ("ruby", "-e"),
    ("sh",),
    ("sh", "-c"),
    ("sh", "-lc"),
    ("sudo",),
    ("yarn", "run"),
    ("zsh",),
    ("zsh", "-c"),
    ("zsh", "-lc"),
}


@dataclass(frozen=True)
class PrefixRule:
    pattern: tuple[str, ...]
    decision: str
    justification: str | None = None

    def matches(self, argv: list[str]) -> bool:
        return tuple(argv[: len(self.pattern)]) == self.pattern


def parse_rules(text: str) -> list[PrefixRule]:
    rules = []
    for node in ast.parse(text).body:
        call = node.value if isinstance(node, ast.Expr) else None
        if not (isinstance(call, ast.Call) and getattr(call.func, "id", None) == "prefix_rule"):
            raise ValueError(f"line {node.lineno}: only prefix_rule(...) calls are supported")
        kwargs = {kw.arg: ast.literal_eval(kw.value) for kw in call.keywords}
        if kwargs.get("decision", "allow") not in DECISIONS:
            raise ValueError(f"line {node.lineno}: decision must be one of {DECISIONS}")
        rules.append(PrefixRule(tuple(kwargs["pattern"]), kwargs.get("decision", "allow"), kwargs.get("justification")))
    return rules


def load_rules(home: Path, extra: list[dict]) -> list[PrefixRule]:
    """Rules from <home>/rules/*.rules plus any passed in config."""
    rules = [PrefixRule(tuple(r["pattern"]), r.get("decision", "allow"), r.get("justification")) for r in extra]
    rules_dir = home / "rules"
    if rules_dir.is_dir():
        for path in sorted(rules_dir.glob("*.rules")):
            rules += parse_rules(path.read_text())
    return rules
