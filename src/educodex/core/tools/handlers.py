"""Built-in tool handlers: exec_command, write_stdin, apply_patch, update_plan.

Each handler: check policy -> maybe ask for approval -> run (sandboxed) -> format output.
Mirrors codex-rs/core/src/tools/handlers/ and tools/orchestrator.rs (approval + sandbox selection).
"""

import os
import time
from pathlib import Path
from typing import TYPE_CHECKING, Any

from educodex.core.policy.approval import decide_exec, decide_patch
from educodex.core.policy.rules import BANNED_PREFIX_SUGGESTIONS, PrefixRule
from educodex.core.policy.segments import plain_segments
from educodex.core.sandbox import seatbelt
from educodex.core.tools import specs
from educodex.core.tools.apply_patch import PatchError, apply_planned, plan_changes
from educodex.core.tools.output import format_exec_output, format_legacy_output
from educodex.core.tools.registry import ToolCall, ToolError, TurnAborted

if TYPE_CHECKING:
    from educodex.core.turn import TurnContext

SANDBOX_DENIAL_HINTS = ("operation not permitted", "permission denied", "read-only file system", "seccomp",
                        "sandbox", "landlock", "failed to write file")


def _is_likely_sandbox_denied(output: str, exit_code: int | None) -> bool:
    """sandboxing/src/denial.rs: a non-zero exit plus a well-known denial message."""
    return bool(exit_code) and any(hint in output.lower() for hint in SANDBOX_DENIAL_HINTS)


async def _approve(ctx: "TurnContext", method: str, item_id: str, params: dict[str, Any]) -> tuple[str, Any]:
    """Ask the client. Returns (accept | acceptForSession | acceptWithExecpolicyAmendment | decline, raw)."""
    decision, raw = await ctx.request_approval(method, {"threadId": ctx.thread_id, "turnId": ctx.turn_id, "itemId": item_id, **params})
    if decision == "cancel":
        raise TurnAborted("cancelled at approval prompt")
    return decision, raw


class ExecCommandHandler:
    name = "exec_command"
    supports_parallel = True  # unified_exec/exec_command.rs: commands may run side by side

    def spec(self) -> dict[str, Any]:
        return specs.exec_command_spec()

    async def handle(self, call: ToolCall, ctx: "TurnContext") -> str:
        args = call.arguments
        cmd = args.get("cmd")
        if not isinstance(cmd, str) or not cmd.strip():
            raise ToolError("exec_command requires a non-empty `cmd` string")
        workdir = Path(ctx.config.cwd, args.get("workdir") or ".").resolve()
        escalate = args.get("sandbox_permissions") == "require_escalated"
        config = ctx.config

        # Session approvals remember the command *and* where/how it runs (Codex keys on more than the text).
        approval_key = f"{workdir}\0{escalate}\0{resolve_shell(args.get('shell'))}\0{cmd}"
        decision = decide_exec(cmd, config.approval_policy, config.sandbox_mode, ctx.rules, escalate,
                               {cmd} if approval_key in ctx.approved_commands else set())
        await ctx.probe.policy_decision(ctx, "exec_command", decision.decision, decision.sandboxed, decision.reason,
                                        decision.matched_rules, command=cmd)

        item = {"type": "commandExecution", "id": call.call_id, "command": cmd, "cwd": str(workdir),
                "processId": None, "status": "inProgress", "commandActions": [], "aggregatedOutput": "",
                "exitCode": None, "durationMs": None}
        await ctx.item_started(item)

        sandboxed = decision.sandboxed
        needs_prompt = decision.decision == "prompt"
        if sandboxed and not seatbelt.available():
            # No OS sandbox here (not macOS). Be safe: ask under on-request; under never, run with a warning.
            needs_prompt = needs_prompt or config.approval_policy == "on-request"
        if decision.decision == "forbidden":
            return await self._finish(ctx, item, "declined", f"exec command rejected: {decision.reason}")
        if needs_prompt:
            proposed = valid_prefix_rule(args.get("prefix_rule"), cmd) if escalate else None
            choices = ["accept", "acceptForSession", *(["acceptWithExecpolicyAmendment"] if proposed else []), "decline", "cancel"]
            answer, raw = await _approve(ctx, "item/commandExecution/requestApproval", call.call_id, {
                "command": cmd, "cwd": str(workdir), "reason": args.get("justification") or decision.reason,
                "proposedExecpolicyAmendment": proposed, "availableDecisions": choices,
            })
            if answer not in ("accept", "acceptForSession", "acceptWithExecpolicyAmendment"):
                return await self._finish(ctx, item, "declined", "exec command rejected by user")
            if answer == "acceptForSession":
                ctx.approved_commands.add(approval_key)
            if answer == "acceptWithExecpolicyAmendment":
                amendment = (raw.get("acceptWithExecpolicyAmendment") or {}).get("execpolicy_amendment") or proposed
                if valid_prefix_rule(amendment, cmd):
                    ctx.rules.append(PrefixRule(tuple(amendment), "allow", "approved by user"))
            # Approval does not remove the sandbox by itself: only an approved require_escalated
            # request runs unsandboxed (decision.sandboxed is already False for those).

        shell = resolve_shell(args.get("shell"))
        argv = [shell, "-lc" if args.get("login", True) else "-c", cmd]
        env = None
        if sandboxed and seatbelt.available():
            sb = seatbelt.build(argv, config.sandbox_mode, config.cwd, config.network_access)
            await ctx.probe.sandbox_command(ctx, sb.argv, sb.policy, sb.params)
            argv, env = sb.argv, seatbelt.sandbox_env(config.network_access)
        elif sandboxed:
            await ctx.probe.sandbox_command(ctx, argv, None, {}, warning="no OS sandbox on this platform; running unsandboxed")

        async def stream(delta: str) -> None:
            await ctx.emit("item/commandExecution/outputDelta", itemId=call.call_id, delta=delta)

        try:
            result = await ctx.processes.start(argv, str(workdir), env, args.get("yield_time_ms"), stream)
        except (OSError, RuntimeError) as err:
            return await self._finish(ctx, item, "failed", f"execution error: {err}")
        item.update(processId=result.session_id, exitCode=result.exit_code, aggregatedOutput=result.output)
        if sandboxed and _is_likely_sandbox_denied(result.output, result.exit_code):
            await ctx.probe.sandbox_denied(ctx, cmd, result.exit_code)
        text = format_exec_output(result.output, result.wall_time, result.exit_code, _max_tokens(args, ctx), result.session_id)
        if result.session_id is not None:
            # Still running: the item completes later, when write_stdin sees the process exit.
            ctx.session.running_items[result.session_id] = item
            return text
        status = "completed" if result.exit_code == 0 else "failed"
        return await self._finish(ctx, item, status, text, result.wall_time)

    async def _finish(self, ctx: "TurnContext", item: dict, status: str, text: str, wall: float = 0.0) -> str:
        item.update(status=status, durationMs=int(wall * 1000))
        await ctx.item_completed(item)
        return text


class WriteStdinHandler:
    name = "write_stdin"
    supports_parallel = True

    def spec(self) -> dict[str, Any]:
        return specs.write_stdin_spec()

    async def handle(self, call: ToolCall, ctx: "TurnContext") -> str:
        args = call.arguments
        try:
            session_id = int(args["session_id"])
            result = await ctx.processes.write(session_id, args.get("chars") or "", args.get("yield_time_ms"))
        except (KeyError, ValueError, TypeError, BrokenPipeError, ConnectionResetError) as err:
            raise ToolError(f"write_stdin failed: {err}") from err
        item = ctx.session.running_items.get(session_id)
        await ctx.emit("item/commandExecution/terminalInteraction", itemId=item["id"] if item else call.call_id,
                       processId=session_id, stdin=args.get("chars") or "")
        if item is not None:
            item["aggregatedOutput"] += result.output
            if result.exit_code is not None:  # the original exec_command item is finished now
                del ctx.session.running_items[session_id]
                item.update(exitCode=result.exit_code, status="completed" if result.exit_code == 0 else "failed")
                await ctx.item_completed(item)
        return format_exec_output(result.output, result.wall_time, result.exit_code, _max_tokens(args, ctx), result.session_id)


class ApplyPatchHandler:
    name = "apply_patch"
    supports_parallel = False

    def spec(self) -> dict[str, Any]:
        return specs.apply_patch_spec()

    async def handle(self, call: ToolCall, ctx: "TurnContext") -> str:
        started = time.monotonic()
        patch = call.input or call.arguments.get("input", "")
        try:
            planned = plan_changes(patch, ctx.config.cwd)
        except PatchError as err:  # Codex returns the bare error text here
            return f"apply_patch verification failed: {err}"
        changes = [{"path": c.path, "kind": {"type": c.kind, **({"move_path": c.move_path} if c.move_path else {})},
                    "diff": c.diff} for c, _ in planned]
        item = {"type": "fileChange", "id": call.call_id, "changes": changes, "status": "inProgress"}
        await ctx.item_started(item)

        paths = [w.path for _, writes in planned for w in writes]
        roots = [Path(r).resolve() for r in seatbelt.writable_roots(ctx.config.cwd)]
        decision = decide_patch(paths, ctx.config.approval_policy, ctx.config.sandbox_mode, roots)
        await ctx.probe.policy_decision(ctx, "apply_patch", decision.decision, False, decision.reason, [],
                                        paths=[str(p) for p in paths])
        if decision.decision == "forbidden":
            return await self._done(ctx, item, "declined", f"patch rejected: {decision.reason}", started, 1)
        if decision.decision == "prompt" and not ctx.patch_paths_approved_for_session(paths):
            answer, _ = await _approve(ctx, "item/fileChange/requestApproval", call.call_id, {"reason": decision.reason})
            if answer not in ("accept", "acceptForSession"):
                return await self._done(ctx, item, "declined", "patch rejected by user", started, 1)
            if answer == "acceptForSession":
                ctx.session.approved_patch_paths.update(paths)
        try:
            summary = apply_planned(planned)
        except OSError as err:
            return await self._done(ctx, item, "failed", f"apply_patch failed: {err}", started, 1)
        return await self._done(ctx, item, "completed", summary, started, 0)

    async def _done(self, ctx: "TurnContext", item: dict, status: str, text: str, started: float, code: int) -> str:
        item["status"] = status
        await ctx.item_completed(item)
        return format_legacy_output(text, time.monotonic() - started, code)


class UpdatePlanHandler:
    name = "update_plan"
    supports_parallel = False

    def spec(self) -> dict[str, Any]:
        return specs.update_plan_spec()

    async def handle(self, call: ToolCall, ctx: "TurnContext") -> str:
        plan = call.arguments.get("plan")
        if not isinstance(plan, list):
            raise ToolError("update_plan requires a `plan` array")
        steps = [{"step": str(p.get("step", "")), "status": _plan_status(p.get("status"))} for p in plan]
        await ctx.emit("turn/plan/updated", explanation=call.arguments.get("explanation"), plan=steps)
        return "Plan updated"


def valid_prefix_rule(rule: Any, cmd: str) -> list[str] | None:
    """A proposed rule must be a non-empty list of words, not a banned catch-all like ["bash"],
    and must cover every segment of the command (exec_policy.rs)."""
    if not (isinstance(rule, list) and rule and all(isinstance(w, str) and w for w in rule)):
        return None
    if tuple(rule) in BANNED_PREFIX_SUGGESTIONS:
        return None
    segments = plain_segments(cmd)
    if not segments or not all(tuple(seg[: len(rule)]) == tuple(rule) for seg in segments):
        return None
    return rule


KNOWN_SHELLS = {"bash": "/bin/bash", "zsh": "/bin/zsh", "sh": "/bin/sh"}


def resolve_shell(requested: str | None) -> str:
    """The model may pick a shell *type*, never a binary: a path like /tmp/evil.sh must not run
    (shell-command/src/shell_detect.rs, get_shell_by_model_provided_path)."""
    name = os.path.basename(requested or os.environ.get("SHELL", "/bin/zsh"))
    return KNOWN_SHELLS.get(name, "/bin/sh")


def _max_tokens(args: dict, ctx: "TurnContext") -> int:
    """The model may ask for less output, never more than its truncation policy (tools/context.rs)."""
    limit = ctx.model_info.truncation_limit_tokens
    try:
        return min(int(args.get("max_output_tokens") or limit), limit)
    except (TypeError, ValueError):
        return limit


def _plan_status(status: Any) -> str:
    """App-server v2 uses camelCase: in_progress -> inProgress."""
    return {"in_progress": "inProgress"}.get(str(status), str(status))


def builtin_handlers(include_plan_tool: bool, apply_patch_tool_type: str | None = "freeform") -> list:
    """The built-in tools, in Codex's order (spec_plan.rs). The catalog decides whether apply_patch exists."""
    handlers = [ExecCommandHandler(), WriteStdinHandler()]
    if include_plan_tool:
        handlers.append(UpdatePlanHandler())
    if apply_patch_tool_type:
        handlers.append(ApplyPatchHandler())
    return handlers

