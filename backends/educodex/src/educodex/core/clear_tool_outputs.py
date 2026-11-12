"""Tool result clearing: replace old tool outputs with a short placeholder, keep everything else.

educodex extra: Codex has no such feature. It follows the Claude API's context editing strategy
`clear_tool_uses_20250919` (trigger, keep, clear_at_least, exclude_tools) and the quantext Claude Code
plugin's `/clear-tool-outputs [keep N]`. There is no model call: this discards (masking), compaction
summarises. The changed history no longer extends the last request, so the next request misses the
prompt cache once; the requests after it hit again.
"""

from dataclasses import dataclass
from typing import TYPE_CHECKING

from educodex.core.items import ResponseItem, approx_tokens, is_tool_call
from educodex.core.tools.output import approx_token_count

if TYPE_CHECKING:
    from educodex.core.turn import TurnContext

DEFAULT_KEEP = 3
PLACEHOLDER_PREFIX = "[tool output cleared to save context"


def placeholder(output: ResponseItem) -> str:
    """What replaces a tool output: a short note with the output's size."""
    return f"{PLACEHOLDER_PREFIX}: {approx_token_count(str(output['output']))} tokens]"


def is_tool_output(item: ResponseItem) -> bool:
    return item.get("type", "").endswith("_output")  # function_call_output, custom_tool_call_output


def is_cleared(item: ResponseItem) -> bool:
    return str(item.get("output", "")).startswith(PLACEHOLDER_PREFIX)


def tool_name(call: ResponseItem) -> str:
    """The router's name for a call: MCP calls are `<namespace>__<tool>` (tools/registry.py)."""
    return f"{call['namespace']}__{call['name']}" if call.get("namespace") else call["name"]


@dataclass
class Cleared:
    history: list[ResponseItem]  # the new history (the old one if nothing was cleared)
    call_ids: list[str]  # the outputs that got the placeholder
    tokens: int  # about how many tokens that removed


def clear_tool_outputs(
    items: list[ResponseItem], keep: int = DEFAULT_KEEP, exclude_tools: tuple[str, ...] = ()
) -> Cleared:
    """Put the placeholder in every tool output except the newest `keep`. Calls and call ids stay,
    so the history is still valid. Outputs already cleared, from an excluded tool, or shorter than
    the placeholder are left alone and do not count toward `keep` (as in the quantext plugin)."""
    names = {i["call_id"]: tool_name(i) for i in items if is_tool_call(i)}
    candidates = [
        n
        for n, item in enumerate(items)
        if is_tool_output(item)
        and not is_cleared(item)
        and names.get(item["call_id"]) not in exclude_tools
        and len(str(item["output"])) > len(placeholder(item))
    ]
    history, call_ids, tokens = list(items), [], 0
    for n in candidates[: max(len(candidates) - keep, 0)]:
        old = items[n]
        history[n] = {**old, "output": placeholder(old)}
        call_ids.append(old["call_id"])
        tokens += approx_tokens(old) - approx_tokens(history[n])
    return Cleared(history, call_ids, tokens)


def report(cleared: Cleared, keep: int) -> str:
    """The note for the chat (and the rollout line)."""
    if not cleared.call_ids:
        return f"Nothing to clear: no tool outputs older than the newest {keep}."
    return (
        f"Cleared {len(cleared.call_ids)} tool outputs (~{cleared.tokens:,} tokens), kept the newest {keep}. "
        "The next request no longer extends the last one, so it misses the prompt cache once."
    )


async def run_clear_tool_outputs(
    ctx: "TurnContext",
    keep: int = DEFAULT_KEEP,
    reason: str = "manual",
    exclude_tools: tuple[str, ...] = (),
    clear_at_least: int = 0,
) -> Cleared:
    """Clear, then save the new history the way compaction does: a `compacted` rollout line with
    `replacement_history`, so a replay of the session log gets the same history."""
    session = ctx.session
    tokens_before = session.history.token_count()
    cleared = clear_tool_outputs(session.history.items, keep, exclude_tools)
    if not cleared.call_ids or cleared.tokens < clear_at_least:  # not worth breaking the cache
        return Cleared(session.history.items, [], 0)
    session.history.mask(cleared.history, cleared.tokens)
    session.rollout.compacted(report(cleared, keep), cleared.history)
    await ctx.probe.tool_outputs_cleared(ctx, reason, keep, cleared.call_ids, cleared.tokens, tokens_before)
    return cleared


async def auto_clear(ctx: "TurnContext", reason: str) -> None:
    """Auto mode (config.clear_tool_outputs). turn.py calls it just before each auto-compact check,
    so the harness discards first and summarises only when that was not enough."""
    auto = ctx.config.clear_tool_outputs
    if auto and ctx.session.history.token_count() >= auto.trigger_tokens:
        await run_clear_tool_outputs(ctx, auto.keep, reason, auto.exclude_tools, auto.clear_at_least)
