"""Phase 1: turn each recent session log into a raw memory and a rollout summary.

Mirrors codex-rs/memories/write/src/phase1.rs, rollout_input.rs, phase1_output.rs and the
claim query in state/src/runtime/memories.rs. For each chosen session log:
  1. keep only messages and tool calls/outputs (no developer messages, no reasoning), and drop
     the AGENTS.md and <skill> parts of user messages
  2. redact secrets, cut to 70% of the model's usable context window (head and tail kept)
  3. one model call, no tools: system prompt stage_one_system.md, a strict JSON schema
  4. store {raw_memory, rollout_summary, rollout_slug}; empty fields mean "nothing to remember"
Codex runs up to 8 calls at once; we run them one by one.
"""

import json
import re
import time
from pathlib import Path
from typing import TYPE_CHECKING

from educodex import vendor
from educodex.core.client import ModelClient, Prompt
from educodex.core.items import message_text, user_message
from educodex.core.memories.storage import MemoryStore, Stage1Output
from educodex.core.models import model_info
from educodex.core.rollout import read_rollout
from educodex.core.tools.output import truncate_middle

if TYPE_CHECKING:
    from educodex.core.turn import TurnContext

EXTRACT_MODEL = "openai/gpt-5.6-luna"  # [memories] extract_model; Codex's default for OpenAI
REASONING_EFFORT = "low"
MAX_ROLLOUTS_PER_RUN = 2  # [memories] max_rollouts_per_startup
MAX_ROLLOUT_AGE_DAYS = 10  # [memories] max_rollout_age_days
# Codex waits until a thread has been idle for 6 hours ([memories] min_rollout_idle_hours), as
# it runs on its own and the user may come back to the thread. You start /memory-update yourself.
MIN_ROLLOUT_IDLE_HOURS = 0
CONTEXT_WINDOW_PERCENT = 70
OUTPUT_SCHEMA = {
    "type": "object",
    "properties": {
        "rollout_summary": {"type": "string"},
        "rollout_slug": {"type": ["string", "null"]},
        "raw_memory": {"type": "string"},
    },
    "required": ["rollout_summary", "rollout_slug", "raw_memory"],
    "additionalProperties": False,
}

# codex-rs/secrets/src/sanitizer.rs: best effort, a few well-known patterns.
SECRET_PATTERNS = [
    (re.compile(r"(?i:\bBearer)[ \t]+[A-Za-z0-9._~+/-]{16,}=*"), "Bearer [REDACTED_SECRET]"),
    (re.compile(r"sk-[A-Za-z0-9]{20,}"), "[REDACTED_SECRET]"),
    (re.compile(r"\bAKIA[0-9A-Z]{16}\b"), "[REDACTED_SECRET]"),
    (
        re.compile(r"""(?i)\b(api[_-]?key|token|secret|password)\b(\s*[:=]\s*)(["']?)[^\s"']{8,}"""),
        r"\1\2\3[REDACTED_SECRET]",
    ),
]
KEPT_ITEM_TYPES = (
    "message",
    "function_call",
    "function_call_output",
    "custom_tool_call",
    "custom_tool_call_output",
    "web_search_call",
)


def redact_secrets(text: str) -> str:
    for pattern, replacement in SECRET_PATTERNS:
        text = pattern.sub(replacement, text)
    return text


def _excluded_part(part: dict) -> bool:
    """AGENTS.md and injected skills are not the user's words (rollout_input.rs)."""
    text = part.get("text", "").strip()
    return (text.startswith("# AGENTS.md instructions") and text.endswith("</INSTRUCTIONS>")) or (
        text.startswith("<skill>") and text.endswith("</skill>")
    )


def filter_items(lines: list[dict]) -> list[dict]:
    """The response items worth learning from (`sanitize_response_item_for_memories`)."""
    kept = []
    for line in lines:
        item = line["payload"] if line["type"] == "response_item" else None
        if not item or item.get("type") not in KEPT_ITEM_TYPES or item.get("role") == "developer":
            continue
        if item.get("type") == "message" and item.get("role") == "user":
            content = [p for p in item.get("content", []) if not _excluded_part(p)]
            if not content:
                continue
            item = {**item, "content": content}
        kept.append(item)
    return kept


def find_candidates(home: Path, current_thread_id: str, store: MemoryStore, now: float) -> list[dict]:
    """Recent session logs (newest first) with a user message, not read since they last changed."""
    candidates = []
    for path in (home / "sessions").rglob("rollout-*.jsonl"):
        updated_at = path.stat().st_mtime
        if not (now - MAX_ROLLOUT_AGE_DAYS * 86_400 <= updated_at <= now - MIN_ROLLOUT_IDLE_HOURS * 3_600):
            continue
        lines = read_rollout(path)
        meta = next((line["payload"] for line in lines if line["type"] == "session_meta"), None)
        if not meta or meta["id"] == current_thread_id:  # the current thread is still going on
            continue
        if not any(line["type"] == "event_msg" and line["payload"].get("type") == "user_message" for line in lines):
            continue
        previous = store.outputs.get(meta["id"])
        if previous and previous.source_updated_at >= updated_at:
            continue
        candidates.append(
            {"threadId": meta["id"], "path": path, "cwd": meta.get("cwd", ""), "updatedAt": updated_at, "lines": lines}
        )
    candidates.sort(key=lambda c: c["updatedAt"], reverse=True)
    return candidates[:MAX_ROLLOUTS_PER_RUN]


def build_stage_one_input(rollout_path: Path, cwd: str, contents: str) -> str:
    info = model_info(EXTRACT_MODEL)
    limit = info.context_window * info.effective_context_window_percent // 100 * CONTEXT_WINDOW_PERCENT // 100
    return vendor.render(
        "templates/memories/stage_one_input.md",
        rollout_path=str(rollout_path),
        rollout_cwd=cwd,
        rollout_contents=truncate_middle(contents, limit)[0],
    )


async def extract(ctx: "TurnContext", client: ModelClient, candidate: dict) -> Stage1Output:
    contents = redact_secrets(json.dumps(filter_items(candidate["lines"]), ensure_ascii=False))
    prompt = Prompt(
        input=[user_message(build_stage_one_input(candidate["path"], candidate["cwd"], contents))],
        tools=[],
        base_instructions=vendor.read("templates/memories/stage_one_system.md"),
        parallel_tool_calls=False,
        output_schema=OUTPUT_SCHEMA,
    )
    body = client.build_request(prompt)
    await ctx.probe.memory_extraction_requested(ctx, candidate["threadId"], str(candidate["path"]), body)
    text = ""
    async for event in client.stream(body):
        if event.type == "response.output_text.delta":
            text += event.data.get("delta", "")
        elif event.type == "response.output_item.done" and not text and event.data["item"].get("type") == "message":
            text = message_text(event.data["item"])
    output = json.loads(text)
    if set(output) != set(OUTPUT_SCHEMA["properties"]):
        raise ValueError(f"unexpected fields in stage-1 output: {sorted(output)}")
    return Stage1Output(
        thread_id=candidate["threadId"],
        source_updated_at=candidate["updatedAt"],
        raw_memory=redact_secrets(output["raw_memory"]),
        rollout_summary=redact_secrets(output["rollout_summary"]),
        rollout_slug=redact_secrets(output["rollout_slug"]) if output["rollout_slug"] else None,
        rollout_path=str(candidate["path"]),
        cwd=candidate["cwd"],
    )


async def run(ctx: "TurnContext", store: MemoryStore) -> list[dict]:
    """Extract memories from up to two session logs. Returns one result per log."""
    session = ctx.session
    candidates = find_candidates(session.config.home, session.thread_id, store, time.time())
    await ctx.probe.memory_candidates(ctx, [{"threadId": c["threadId"], "path": str(c["path"])} for c in candidates])
    results = []
    client = ModelClient(
        EXTRACT_MODEL,
        model_info(EXTRACT_MODEL),
        session.config.api_key,
        session.config.base_url,
        session.thread_id,
        REASONING_EFFORT,
        "none",
        session.transport,
    )
    try:
        for candidate in candidates:
            try:
                output = await extract(ctx, client, candidate)
            except Exception as err:  # Codex marks the job failed and retries an hour later
                result = {"threadId": candidate["threadId"], "status": "failed", "error": str(err)}
            else:
                if not output.raw_memory or not output.rollout_summary:  # the "no-op gate" said: nothing new
                    output.raw_memory = output.rollout_summary = ""
                store.outputs[output.thread_id] = output
                store.save()
                status = "succeededWithOutput" if output.raw_memory else "succeededNoOutput"
                result = {
                    "threadId": output.thread_id,
                    "status": status,
                    "slug": output.rollout_slug,
                    "rawMemory": output.raw_memory,
                    "rolloutSummary": output.rollout_summary,
                }
            await ctx.probe.memory_extracted(ctx, result)
            results.append(result)
    finally:
        await client.aclose()
    return results
