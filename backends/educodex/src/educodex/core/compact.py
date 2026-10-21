"""Compaction: when the context window fills up, replace history with a summary.

Mirrors codex-rs/core/src/compact.rs (local "inline" compaction):
  1. ask the model, with no tools, to write a handoff summary (prompt: templates/compact/prompt.md)
  2. new history = recent real user messages (up to 20k tokens)
                   + fresh context fragments, inserted before the last user message
                   + one user message: summary_prefix.md + the summary
Codex prefers remote compaction: a normal /responses request ending in a `compaction_trigger` item,
answered with one encrypted `compaction` item (core/src/compact_remote_v2*.rs; the older
/responses/compact endpoint was removed). The local version shows the idea in plain text.
"""

from typing import TYPE_CHECKING

from educodex import vendor
from educodex.core.client import Prompt
from educodex.core.context import world_state
from educodex.core.items import ResponseItem, message_text, user_message
from educodex.core.tools.output import approx_token_count, truncate_middle

if TYPE_CHECKING:
    from educodex.core.turn import TurnContext

COMPACT_USER_MESSAGE_MAX_TOKENS = 20_000
CONTEXT_PREFIXES = ("<environment_context>", "# AGENTS.md instructions", "<permissions instructions>", "<skill>")


def summary_prompt() -> str:
    return vendor.read("templates/compact/prompt.md")


def summary_prefix() -> str:
    return vendor.read("templates/compact/summary_prefix.md")


def is_real_user_message(item: ResponseItem) -> bool:
    """A message the human typed, not injected context and not an earlier summary."""
    if item.get("type") != "message" or item.get("role") != "user":
        return False
    text = message_text(item)
    return not text.startswith(CONTEXT_PREFIXES + ("<turn_aborted>",)) and not text.startswith(f"{summary_prefix()}\n")


def build_compacted_history(
    history: list[ResponseItem], summary: str, context: list[ResponseItem]
) -> list[ResponseItem]:
    users = [i for i in history if is_real_user_message(i)]
    kept, remaining = [], COMPACT_USER_MESSAGE_MAX_TOKENS
    for item in reversed(users):  # newest first, until the budget runs out
        if remaining <= 0:
            break
        text = message_text(item)
        tokens = approx_token_count(text)
        if tokens > remaining:  # the oldest one that does not fit is truncated, not dropped
            item = user_message(truncate_middle(text, remaining)[0])
        kept.insert(0, item)
        remaining -= tokens
    new_history = kept[:-1] + context + kept[-1:]
    new_history.append(user_message(f"{summary_prefix()}\n{summary or '(no summary available)'}"))
    return new_history


async def run_compact(ctx: "TurnContext", reason: str = "manual") -> str:
    session = ctx.session
    before = session.history.items
    before_tokens = session.history.token_count()
    item = {"type": "contextCompaction", "id": f"compact-{ctx.turn_id}-{ctx.iteration}"}
    await ctx.item_started(item)

    prompt = Prompt(
        input=[*session.history.for_prompt(), user_message(summary_prompt())],
        tools=[],
        base_instructions=session.base_instructions,
        parallel_tool_calls=False,
    )
    body = session.client.build_request(prompt)
    await ctx.probe.compaction_requested(ctx, reason, body, before_tokens)
    summary = ""
    async for event in session.client.stream(body):
        if event.type == "response.output_item.done" and event.data["item"].get("type") == "message":
            summary = message_text(event.data["item"])

    session.refresh_memory_instructions()  # Codex rebuilds the thread context, so a new summary shows up
    fragments = world_state.build_fragments(session.config, session.skills, session.memory_instructions)
    session.context_snapshot = world_state.snapshot(fragments)
    new_history = build_compacted_history(before, summary, world_state.to_messages(fragments))
    session.history.replace(new_history)
    session.rollout.compacted(summary, new_history)
    await ctx.probe.compacted(ctx, reason, summary, len(before), before_tokens, new_history)
    await ctx.item_completed(item)
    await ctx.emit("thread/compacted")
    return summary
