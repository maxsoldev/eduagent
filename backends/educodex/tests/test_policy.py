import pytest

from educodex.core.policy.approval import decide_exec, decide_patch
from educodex.core.policy.dangerous import is_dangerous_command
from educodex.core.policy.rules import PrefixRule, parse_rules
from educodex.core.policy.segments import split_segments


def test_segments():
    assert split_segments("git pull | tee out.txt && echo 'a b'") == [
        ["git", "pull"],
        ["tee", "out.txt"],
        ["echo", "a b"],
    ]


@pytest.mark.parametrize(
    "cmd,dangerous",
    [
        ("rm -rf build", True),
        ("rm -f x", True),
        ("rm --force x", True),
        ("rm x", False),
        ("sudo rm -rf /", True),
        ("bash -lc 'rm -rf x'", True),
        ("ls && rm -fr y", True),
        ("env FOO=1 rm -f z", True),
        ("echo rm -rf", False),
        ("rm -- -f", False),
    ],
)
def test_dangerous(cmd, dangerous):
    assert is_dangerous_command(cmd) is dangerous


def decide(cmd, policy="on-request", sandbox="workspace-write", rules=(), escalate=False, approved=()):
    return decide_exec(cmd, policy, sandbox, list(rules), escalate, set(approved))


def test_default_runs_in_sandbox():
    d = decide("ls")
    assert (d.decision, d.sandboxed) == ("allow", True)


def test_dangerous_prompts_or_forbids():
    assert decide("rm -rf x").decision == "prompt"
    assert decide("rm -rf x", policy="never").decision == "forbidden"


def test_escalation():
    assert decide("curl x", escalate=True).decision == "prompt"
    assert decide("curl x", escalate=True, policy="never").decision == "forbidden"
    assert (
        decide("curl x", sandbox="danger-full-access").decision,
        decide("x", sandbox="danger-full-access").sandboxed,
    ) == ("allow", False)


def test_rules_and_session_approvals():
    rules = [PrefixRule(("git", "status"), "allow"), PrefixRule(("git", "push"), "forbidden")]
    assert decide("git status", rules=rules).decision == "allow"
    assert decide("git status", rules=rules).sandboxed is False
    assert decide("git status && git push", rules=rules).decision == "forbidden"
    assert decide("git status && ls", rules=rules).decision == "allow"  # not fully matched -> heuristics
    assert decide("rm -rf x", approved={"rm -rf x"}).decision == "allow"


def test_parse_rules():
    rules = parse_rules('prefix_rule(pattern=["git", "push"], decision="prompt", justification="visible")\n')
    assert rules == [PrefixRule(("git", "push"), "prompt", "visible")]
    with pytest.raises(ValueError):
        parse_rules("import os")


def test_patch_policy(tmp_path):
    inside, outside = tmp_path / "a.txt", tmp_path.parent / "b.txt"
    assert decide_patch([inside], "on-request", "workspace-write", [tmp_path]).decision == "allow"
    assert decide_patch([outside], "on-request", "workspace-write", [tmp_path]).decision == "prompt"
    assert decide_patch([outside], "never", "workspace-write", [tmp_path]).decision == "forbidden"
    assert decide_patch([inside], "on-request", "read-only", [tmp_path]).decision == "prompt"
