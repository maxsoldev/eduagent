"""Session configuration. Mirrors the subset of codex-rs/core/src/config/ that educodex uses."""

import os
from dataclasses import dataclass, field
from pathlib import Path

DEFAULT_MODEL = "openai/gpt-6-luna"
DEFAULT_BASE_URL = "https://openrouter.ai/api/v1"

# AskForApproval (protocol/src/protocol.rs). Codex also has internal `untrusted` and `granular`.
APPROVAL_POLICIES = ("on-request", "never")
# SandboxMode (protocol/src/config_types.rs).
SANDBOX_MODES = ("read-only", "workspace-write", "danger-full-access")


@dataclass
class Config:
    cwd: Path = field(default_factory=Path.cwd)
    model: str = DEFAULT_MODEL
    base_url: str = DEFAULT_BASE_URL
    api_key: str | None = None
    approval_policy: str = "on-request"
    sandbox_mode: str = "workspace-write"
    network_access: bool = False
    reasoning_effort: str | None = None  # None -> model default
    # Codex defaults to the model's default_reasoning_summary ("none" for current models).
    # educodex asks for "auto" so you can watch the model's reasoning summaries.
    reasoning_summary: str = "auto"
    developer_instructions: str | None = None
    base_instructions: str | None = None  # overrides the model catalog prompt
    include_plan_tool: bool = True  # off by default in Codex ([tools.update_plan] enabled = true)
    home: Path = field(default_factory=lambda: Path(os.environ.get("EDUCODEX_HOME", Path.home() / ".eduagent" / ".educodex")))
    mcp_servers: dict[str, dict] = field(default_factory=dict)  # name -> {"command": ..., "args": [...]}
    rules: list[dict] = field(default_factory=list)  # exec policy prefix rules
    hooks: dict[str, list[str]] = field(default_factory=dict)  # event -> shell commands
    # [skills] include_instructions and [skills.bundled] enabled in Codex's config.toml.
    include_skill_instructions: bool = True
    bundled_skills: bool = True
    # [features] memories (Codex: off by default). Codex also has [memories] use_memories and
    # generate_memories (both true when the feature is on); one switch is enough here.
    memories: bool = False
    # A thread that writes no session log, so memories never learn from it (the memory agent).
    ephemeral: bool = False
    # workspace-write without /tmp and $TMPDIR (Codex's exclude_slash_tmp + exclude_tmpdir_env_var).
    exclude_tmp_writable_roots: bool = False

    def __post_init__(self) -> None:
        self.cwd = Path(self.cwd).resolve()
        if self.approval_policy not in APPROVAL_POLICIES:
            raise ValueError(f"approval_policy must be one of {APPROVAL_POLICIES}")
        if self.sandbox_mode not in SANDBOX_MODES:
            raise ValueError(f"sandbox_mode must be one of {SANDBOX_MODES}")


def load_api_key(cwd: Path) -> str | None:
    """Read OPENROUTER_API_KEY from the environment or a .env file (cwd or its parents)."""
    if key := os.environ.get("OPENROUTER_API_KEY"):
        return key
    for directory in [cwd, *cwd.parents]:
        env_file = directory / ".env"
        if env_file.is_file():
            for line in env_file.read_text().splitlines():
                name, _, value = line.partition("=")
                if name.strip() == "OPENROUTER_API_KEY":
                    return value.strip().strip("'\"")
    return None
