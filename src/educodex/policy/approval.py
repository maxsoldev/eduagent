"""Should this command run? Mirrors codex-rs/core/src/exec_policy.rs and core/src/safety.rs.

Outcomes:
  allow      run now: inside the sandbox, unless an allow-rule (or danger-full-access) says otherwise
  prompt     ask the user first
  forbidden  refuse and tell the model why

Each segment of `a && b | c` gets its own decision (a matching rule, else the heuristics);
the strictest one wins. Only an approved `require_escalated` request leaves the sandbox.
"""

from dataclasses import dataclass
from pathlib import Path

from educodex.policy.dangerous import is_dangerous, is_dangerous_command
from educodex.policy.rules import STRICTNESS, PrefixRule
from educodex.policy.segments import plain_segments

PROTECTED_SUBPATHS = (".git", ".codex", ".agents")  # read-only even inside writable roots


@dataclass
class ExecDecision:
    decision: str  # "allow" | "prompt" | "forbidden"
    sandboxed: bool  # run inside the OS sandbox?
    reason: str  # human-readable explanation (shown in the trace and to the model when forbidden)
    matched_rules: list[str]


def _heuristic(dangerous: bool, approval_policy: str, restricted: bool, escalate: bool) -> tuple[str, str]:
    """render_decision_for_unmatched_command (exec_policy.rs ~L770)."""
    if dangerous:
        if approval_policy == "never":
            return "forbidden", "dangerous command (forced rm) and approval_policy is never"
        return "prompt", "dangerous command (forced rm) always needs approval"
    if approval_policy == "never":
        if escalate:
            return "forbidden", "escalation requested but approval_policy is never"
        return "allow", "approval_policy is never: rely on the sandbox"
    if not restricted:
        return "allow", "danger-full-access: no sandbox, command not flagged as dangerous"
    if escalate:
        return "prompt", "model asked to run outside the sandbox (require_escalated)"
    return "allow", "run inside the sandbox; it enforces the limits"


def decide_exec(
    cmd: str,
    approval_policy: str,
    sandbox_mode: str,
    rules: list[PrefixRule],
    requires_escalation: bool,
    approved_for_session: set[str],
) -> ExecDecision:
    restricted = sandbox_mode != "danger-full-access"
    if requires_escalation and approval_policy == "never":  # checked before any rule (exec_policy.rs)
        return ExecDecision("forbidden", False, "escalation requested but approval_policy is never", [])
    if cmd in approved_for_session:
        return ExecDecision("allow", restricted and not requires_escalation,
                            "approved earlier in this session (acceptForSession)", [])

    segments = plain_segments(cmd)
    if segments is None:  # opaque script: no rule can match it
        decision, reason = _heuristic(is_dangerous_command(cmd), approval_policy, restricted, requires_escalation)
        return ExecDecision(decision, restricted and not requires_escalation, f"complex shell syntax, no rules apply; {reason}", [])

    decisions, reasons, matched = [], [], []
    for segment in segments:
        matching = [r for r in rules if r.matches(segment)]
        rule = max(matching, key=lambda r: STRICTNESS[r.decision]) if matching else None  # strictest match wins
        if rule:
            decision = rule.decision
            if decision == "prompt" and approval_policy == "never":
                decision = "forbidden"
            decisions.append(decision)
            matched.append(" ".join(rule.pattern))
            reasons.append(f"`{' '.join(segment)}` matched rule {list(rule.pattern)} -> {rule.decision}")
        else:
            decision, reason = _heuristic(is_dangerous(segment), approval_policy, restricted, requires_escalation)
            decisions.append(decision)
            reasons.append(f"`{' '.join(segment)}`: {reason}")
    overall = max(decisions, key=STRICTNESS.get)
    # An allow rule means "run unrestricted" - but only if *every* segment is covered by one.
    all_allowed_by_rules = len(matched) == len(segments) and overall == "allow"
    sandboxed = restricted and not all_allowed_by_rules and not requires_escalation
    return ExecDecision(overall, sandboxed, "; ".join(reasons), matched)


def is_writable(path: Path, writable_roots: list[Path]) -> bool:
    """Inside a writable root, but not inside any root's protected .git/.codex/.agents
    (safety.rs can_write_path). Hard-linked files could point outside the workspace, so they ask."""
    if not any(path.is_relative_to(root) for root in writable_roots):
        return False
    if any(path.is_relative_to(root / name) for root in writable_roots for name in PROTECTED_SUBPATHS):
        return False
    return not (path.is_file() and path.stat().st_nlink > 1)


def decide_patch(
    paths: list[Path], approval_policy: str, sandbox_mode: str, writable_roots: list[Path]
) -> ExecDecision:
    """assess_patch_safety: auto-approve writes inside writable roots, else ask (or reject under never)."""
    if sandbox_mode == "danger-full-access":
        return ExecDecision("allow", False, "danger-full-access: all writes allowed", [])
    if sandbox_mode == "workspace-write" and all(is_writable(p, writable_roots) for p in paths):
        return ExecDecision("allow", False, "all paths are inside the writable roots", [])
    if approval_policy == "never":
        return ExecDecision("forbidden", False, "patch writes outside the writable roots and approval_policy is never", [])
    return ExecDecision("prompt", False, "patch writes outside the writable roots, into a protected folder, or the sandbox is read-only", [])
