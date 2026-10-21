"""Formatting tool output for the model, and keeping it small.

Mirrors codex-rs/core/src/tools/context.rs (`response_header`) and
utils/string/src/truncate.rs + utils/output-truncation/. Output longer than the model's
`truncation_policy.limit` (10,000 tokens for gpt-6-luna) keeps its beginning and end and drops
the middle, replaced by a marker such as `…1234 tokens truncated…`.
"""

import secrets

BYTES_PER_TOKEN = 4


def approx_token_count(text: str) -> int:
    return (len(text.encode()) + BYTES_PER_TOKEN - 1) // BYTES_PER_TOKEN


def truncate_middle(text: str, max_tokens: int) -> tuple[str, int | None]:
    """Keep head and tail within max_tokens; return (text, original token count if truncated)."""
    data = text.encode()
    max_bytes = max_tokens * BYTES_PER_TOKEN
    if len(data) <= max_bytes:
        return text, None
    left = max_bytes // 2
    right = max_bytes - left
    head = data[:left].decode(errors="ignore")
    tail = data[len(data) - right :].decode(errors="ignore")
    removed = (len(data) - max_bytes + BYTES_PER_TOKEN - 1) // BYTES_PER_TOKEN
    return f"{head}…{removed} tokens truncated…{tail}", approx_token_count(text)


def format_exec_output(
    output: str,
    wall_time: float,
    exit_code: int | None,
    max_tokens: int,
    session_id: int | None = None,
) -> str:
    """The text an exec_command call returns, e.g.

    Chunk ID: 4dbff6
    Wall time: 0.0123 seconds
    Process exited with code 0
    Original token count: 868
    Output:
    ...
    """
    truncated, original = truncate_middle(output, max_tokens)
    lines = [f"Chunk ID: {secrets.token_hex(3)}", f"Wall time: {wall_time:.4f} seconds"]
    if exit_code is not None:
        lines.append(f"Process exited with code {exit_code}")
    if session_id is not None:
        lines.append(f"Process running with session ID {session_id}")
    lines.append(f"Original token count: {original or approx_token_count(output)}")
    lines.append("Output:")
    return "\n".join(lines) + "\n" + truncated


def format_legacy_output(output: str, wall_time: float, exit_code: int) -> str:
    """Older exec format, still used for apply_patch results (core/tests/suite/apply_patch_serialization.rs)."""
    return f"Exit code: {exit_code}\nWall time: {wall_time:.1f} seconds\nOutput:\n{output}"
