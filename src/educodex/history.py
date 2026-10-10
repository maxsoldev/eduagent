"""Conversation history: the growing list of response items for one thread.

Mirrors codex-rs/core/src/context_manager/history.rs. `for_prompt()` returns what gets sent;
`normalize` makes sure every tool call has an output (the API rejects dangling calls),
mirroring context_manager/normalize.rs.
"""

from educodex.items import ResponseItem, approx_tokens, is_tool_call, tool_output


class History:
    def __init__(self) -> None:
        self.items: list[ResponseItem] = []
        self.last_usage: dict | None = None  # usage from the most recent model response
        self._usage_at = 0  # history length when that usage was reported

    def record(self, *items: ResponseItem) -> None:
        self.items.extend(items)

    def replace(self, items: list[ResponseItem]) -> None:
        """Used by compaction: swap the whole history for a shorter one."""
        self.items = list(items)
        self.set_usage(None)

    def set_usage(self, usage: dict | None) -> None:
        self.last_usage = usage
        self._usage_at = len(self.items)

    def for_prompt(self) -> list[ResponseItem]:
        return normalize(self.items)

    def token_count(self) -> int:
        """Tokens in the context: the API's count for what it has seen, plus an estimate for items
        added since (e.g. tool outputs). Mirrors context_manager/history.rs."""
        if self.last_usage:
            return self.last_usage.get("total_tokens", 0) + sum(approx_tokens(i) for i in self.items[self._usage_at :])
        return sum(approx_tokens(i) for i in self.items)


def normalize(items: list[ResponseItem]) -> list[ResponseItem]:
    """Add an 'aborted' output for calls without one; drop outputs whose call is missing."""
    call_ids = {i["call_id"] for i in items if is_tool_call(i)}
    output_ids = {i["call_id"] for i in items if i.get("type", "").endswith("_output")}
    result = []
    for item in items:
        if item.get("type", "").endswith("_output") and item["call_id"] not in call_ids:
            continue
        result.append(item)
        if is_tool_call(item) and item["call_id"] not in output_ids:
            result.append(tool_output(item, "aborted"))
    return result
