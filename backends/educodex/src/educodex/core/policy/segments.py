"""Split a shell command into independent segments at |, &&, ||, ;.

Codex evaluates each segment separately for rules and danger checks (the permissions prompt says
"The command string is split into independent command segments"). It only trusts *plain* commands:
anything with substitutions, redirections, subshells or newlines is treated as one opaque script
that no prefix rule can match (core/src/exec_policy.rs, parse_shell_lc_plain_commands).
"""

import shlex

OPERATORS = {"|", "||", "&&", ";", "&"}
COMPLEX_SYNTAX = ("$", "`", ">", "<", "(", ")", "\n", "#")  # variables too: `$CMD` could be anything


def is_plain(cmd: str) -> bool:
    return not any(token in cmd for token in COMPLEX_SYNTAX)


def split_segments(cmd: str) -> list[list[str]]:
    """Words of each segment. Raises ValueError on unbalanced quotes."""
    lexer = shlex.shlex(cmd, posix=True, punctuation_chars=";&|")
    lexer.whitespace_split = True
    lexer.commenters = ""  # shlex would treat `a#b` as a comment; bash only does at a word start
    segments, current = [], []
    for token in lexer:
        if token and set(token) <= set(";&|") and token not in OPERATORS:
            raise ValueError(f"unsupported shell operator {token!r}")  # e.g. `|&`: treat as opaque
        if token in OPERATORS:
            if current:
                segments.append(current)
            current = []
        else:
            current.append(token)
    if current:
        segments.append(current)
    return segments


def plain_segments(cmd: str) -> list[list[str]] | None:
    """Segments if the command is plain enough to match rules against, else None."""
    if not is_plain(cmd):
        return None
    try:
        return split_segments(cmd) or None
    except ValueError:
        return None
