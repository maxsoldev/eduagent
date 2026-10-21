"""Tool specs: the JSON the model sees in the request's `tools` array.

Copied field-for-field from Codex:
  exec_command / write_stdin  codex-rs/core/src/tools/handlers/shell_spec.rs
  update_plan                 codex-rs/core/src/tools/handlers/plan_spec.rs
  apply_patch                 codex-rs/core/src/tools/handlers/apply_patch_spec.rs
The descriptions are prompts too: the model decides how to use a tool from this text alone.
"""

from typing import Any

from educodex import vendor

APPROVAL_PARAMETERS = {
    "sandbox_permissions": {
        "type": "string",
        "enum": ["use_default", "require_escalated"],
        "description": "Per-command sandbox override. Defaults to `use_default`; use `require_escalated` for unsandboxed execution.",
    },
    "justification": {
        "type": "string",
        "description": "User-facing approval question for `require_escalated`; omit otherwise.",
    },
    "prefix_rule": {
        "type": "array",
        "items": {"type": "string"},
        "description": 'Reusable approval prefix for `cmd`, only with `sandbox_permissions: "require_escalated"`; for example ["git", "pull"].',
    },
}


def exec_command_spec() -> dict[str, Any]:
    return {
        "type": "function",
        "name": "exec_command",
        "description": "Runs a command in a PTY, returning output or a session ID for ongoing interaction.",
        "strict": False,
        "parameters": {
            "type": "object",
            "properties": {
                "cmd": {"type": "string", "description": "Shell command to execute."},
                "justification": APPROVAL_PARAMETERS["justification"],
                "login": {
                    "type": "boolean",
                    "description": "True runs the shell with -l/-i semantics; false disables them. Defaults to true.",
                },
                "max_output_tokens": {
                    "type": "number",
                    "description": "Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy.",
                },
                "prefix_rule": APPROVAL_PARAMETERS["prefix_rule"],
                "sandbox_permissions": APPROVAL_PARAMETERS["sandbox_permissions"],
                "shell": {
                    "type": "string",
                    "description": "Shell binary to launch. Defaults to the user's default shell.",
                },
                "tty": {
                    "type": "boolean",
                    "description": "True allocates a PTY for the command; false or omitted uses plain pipes.",
                },
                "workdir": {
                    "type": "string",
                    "description": "Working directory for the command. Defaults to the turn cwd.",
                },
                "yield_time_ms": {
                    "type": "number",
                    "description": "Wait before yielding output. Defaults to 10000 ms; effective range is 250-30000 ms.",
                },
            },
            "required": ["cmd"],
            "additionalProperties": False,
        },
    }


def write_stdin_spec() -> dict[str, Any]:
    return {
        "type": "function",
        "name": "write_stdin",
        "description": "Writes characters to an existing unified exec session and returns recent output.",
        "strict": False,
        "parameters": {
            "type": "object",
            "properties": {
                "chars": {
                    "type": "string",
                    "description": "Bytes to write to stdin. Defaults to empty, which polls without writing.",
                },
                "max_output_tokens": {
                    "type": "number",
                    "description": "Output token budget. Defaults to 10000 tokens; larger requests may be capped by policy.",
                },
                "session_id": {"type": "number", "description": "Identifier of the running unified exec session."},
                "yield_time_ms": {
                    "type": "number",
                    "description": "Wait before yielding output. Non-empty writes default to 250 ms and cap at 30000 ms; empty polls wait 5000-300000 ms by default.",
                },
            },
            "required": ["session_id"],
            "additionalProperties": False,
        },
    }


def update_plan_spec() -> dict[str, Any]:
    return {
        "type": "function",
        "name": "update_plan",
        "description": "Updates the task plan.\nProvide an optional explanation and a list of plan items, each with a step and status.\nAt most one step can be in_progress at a time.\n",
        "strict": False,
        "parameters": {
            "type": "object",
            "properties": {
                "explanation": {"type": "string", "description": "Optional explanation for this plan update."},
                "plan": {
                    "type": "array",
                    "description": "The list of steps",
                    "items": {
                        "type": "object",
                        "properties": {
                            "status": {
                                "type": "string",
                                "enum": ["pending", "in_progress", "completed"],
                                "description": "Step status.",
                            },
                            "step": {"type": "string", "description": "Task step text."},
                        },
                        "required": ["step", "status"],
                        "additionalProperties": False,
                    },
                },
            },
            "required": ["plan"],
            "additionalProperties": False,
        },
    }


def apply_patch_spec() -> dict[str, Any]:
    """A freeform ("custom") tool: the model writes raw text that must match a Lark grammar."""
    return {
        "type": "custom",
        "name": "apply_patch",
        "description": "The `apply_patch` tool can be used to edit files. This is a FREEFORM tool, so do not wrap the patch in JSON.",
        "format": {"type": "grammar", "syntax": "lark", "definition": vendor.read("apply_patch.lark")},
    }
