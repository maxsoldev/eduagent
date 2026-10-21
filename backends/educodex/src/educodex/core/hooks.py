"""Hooks: user-configured shell commands that run at fixed points in the loop.

Mirrors codex-rs/hooks/ (events PreToolUse, PostToolUse, UserPromptSubmit, Stop).
Each hook gets a JSON description of the event on stdin. Exit code 2 plus a reason on stderr means "block":
  PreToolUse        -> the tool does not run; the model gets "... blocked by PreToolUse hook: <reason> ..."
  UserPromptSubmit  -> the prompt is rejected and the turn ends
  Stop              -> the reason becomes a new user message and the loop continues
                       (the hook sees stop_hook_active=true then, so it can avoid looping forever)
  PostToolUse       -> the reason replaces the tool output the model sees
Codex also accepts JSON output from hooks, timeouts of 600 s and parallel hooks; educodex keeps it minimal.
"""

import asyncio
import json
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from educodex.core.tools.registry import ToolCall
    from educodex.core.turn import TurnContext

BLOCK_EXIT_CODE = 2
HOOK_TIMEOUT_SECONDS = 600  # Codex default
TOOL_NAMES_FOR_HOOKS = {"exec_command": "Bash"}  # Codex shows shell tools to hooks as "Bash"


class HookBlocked(Exception):
    pass


async def _run(ctx: "TurnContext", event: str, payload: dict[str, Any]) -> list[tuple[int, str, str]]:
    results = []
    for command in ctx.config.hooks.get(event, []):
        proc = await asyncio.create_subprocess_shell(
            command,
            cwd=str(ctx.config.cwd),
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.PIPE,
        )
        body = json.dumps(
            {
                "hook_event_name": event,
                "session_id": ctx.thread_id,
                "turn_id": ctx.turn_id,
                "cwd": str(ctx.config.cwd),
                **payload,
            }
        )
        try:
            out_b, err_b = await asyncio.wait_for(proc.communicate(body.encode()), timeout=HOOK_TIMEOUT_SECONDS)
            code = proc.returncode or 0
        except TimeoutError:  # a stuck hook fails, it does not hang the agent
            proc.kill()
            await proc.wait()
            out_b, err_b, code = b"", f"hook timed out after {HOOK_TIMEOUT_SECONDS}s".encode(), -1
        out, err = out_b.decode(errors="replace"), err_b.decode(errors="replace")
        results.append((code, out, err))
        await ctx.probe.hook_ran(ctx, event, command, code, out, err)
    return results


def _blocking_reason(results: list[tuple[int, str, str]]) -> str | None:
    """Exit 2 blocks only with a reason on stderr (hooks/src/events/pre_tool_use.rs)."""
    for code, _, err in results:
        if code == BLOCK_EXIT_CODE and err.strip():
            return err.strip()
    return None


def _hook_view(call: "ToolCall") -> tuple[str, dict[str, Any]]:
    name = TOOL_NAMES_FOR_HOOKS.get(call.name, call.name)
    if call.name == "exec_command":
        return name, {"command": call.arguments.get("cmd", "")}
    if call.name == "apply_patch":
        return name, {"command": call.input}
    return name, call.arguments or {"input": call.input}


async def run_user_prompt_submit(ctx: "TurnContext", prompt: str) -> str:
    if reason := _blocking_reason(await _run(ctx, "UserPromptSubmit", {"prompt": prompt})):
        raise HookBlocked(reason)
    return prompt


async def run_pre_tool_use(ctx: "TurnContext", call: "ToolCall") -> str | None:
    """Returns the message for the model if a hook blocked the call (core/src/hook_runtime.rs)."""
    name, tool_input = _hook_view(call)
    reason = _blocking_reason(await _run(ctx, "PreToolUse", {"tool_name": name, "tool_input": tool_input}))
    if reason is None:
        return None
    if name in ("Bash", "apply_patch"):
        return f"Command blocked by PreToolUse hook: {reason}. Command: {tool_input['command']}"
    return f"Tool call blocked by PreToolUse hook: {reason}. Tool: {name}"


async def run_post_tool_use(ctx: "TurnContext", call: "ToolCall", output: str) -> str:
    """Returns the output the model will see (a blocking PostToolUse hook replaces it)."""
    name, tool_input = _hook_view(call)
    reason = _blocking_reason(
        await _run(ctx, "PostToolUse", {"tool_name": name, "tool_input": tool_input, "tool_response": output})
    )
    return reason if reason is not None else output


async def run_stop(ctx: "TurnContext", stop_hook_active: bool) -> str | None:
    """A Stop hook can keep the agent going: exit 2 with an instruction on stderr."""
    return _blocking_reason(await _run(ctx, "Stop", {"stop_hook_active": stop_hook_active}))
