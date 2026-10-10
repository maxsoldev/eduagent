"""Heuristic for commands that must never run without a human saying yes.

Mirrors codex-rs/shell-command/src/command_safety/is_dangerous_command.rs (POSIX part):
a forced `rm` (`-f`, `-rf`, `--force`), also when wrapped in `sudo`, `env` or `bash -lc "..."`.
"""

from educodex.policy.segments import split_segments

MAX_WRAPPER_DEPTH = 8


def _rm_is_forced(args: list[str]) -> bool:
    for arg in args:
        if arg == "--":
            return False
        if arg == "--force" or (arg.startswith("-") and not arg.startswith("--") and "f" in arg[1:]):
            return True
    return False


SHELL_KEYWORDS = {"if", "then", "else", "elif", "do", "while", "until", "!", "{", "time"}


def is_dangerous(argv: list[str], depth: int = 0) -> bool:
    if depth > MAX_WRAPPER_DEPTH:
        return True
    while argv and argv[0] in SHELL_KEYWORDS:  # `if x; then rm -rf y; fi` -> segment ["then", "rm", ...]
        argv = argv[1:]
    if not argv:
        return False
    name = argv[0].rsplit("/", 1)[-1]
    if name == "rm":
        return _rm_is_forced(argv[1:])
    if name == "sudo":
        return is_dangerous(argv[1:], depth + 1)
    if name == "env":
        rest = argv[1:]
        while rest and ("=" in rest[0] or rest[0].startswith("-")):  # skip env's options and VAR=value
            rest = rest[1:]
        return is_dangerous(rest, depth + 1)
    if name in ("bash", "sh", "zsh") and len(argv) >= 3 and argv[1] in ("-c", "-lc"):
        return is_dangerous_command(argv[2], depth + 1)
    return False


def is_dangerous_command(cmd: str, depth: int = 0) -> bool:
    try:
        return any(is_dangerous(segment, depth) for segment in split_segments(cmd))
    except ValueError:  # unbalanced quotes: the shell would reject it too (Codex: parse fails -> not dangerous)
        return False
