"""World state: the context fragments that describe the current situation, and how they change.

Mirrors codex-rs/core/src/session/world_state.rs + context_manager/updates.rs:
  * At the start of a thread every fragment is emitted.
  * On later turns only fragments whose text changed are emitted again, as NEW messages
    appended to history. Earlier messages are never edited, so the prompt prefix stays the
    same and the provider's prompt cache keeps hitting.
  * Fragments are grouped into one message per role (developer first, then user), each
    fragment being a separate content part.
"""

from educodex.core.config import Config
from educodex.core.context.agents_md import render_agents_md
from educodex.core.context.environment import render_environment_context
from educodex.core.context.fragments import Fragment
from educodex.core.context.permissions import render_permissions
from educodex.core.items import ResponseItem, message
from educodex.core.models import catalog, model_info
from educodex.core.sandbox import seatbelt
from educodex.core.skills.loader import SkillLoadOutcome
from educodex.core.skills.render import render_available_skills


def collaboration_mode_text(model: str) -> str | None:
    """Codex's default collaboration mode ("Default", vs "Plan") is described to the model per model."""
    try:
        raw = catalog()[model_info(model).slug]  # same lookup as the session, incl. prefix fallback
    except KeyError:
        return None
    return ((raw.get("model_messages") or {}).get("collaboration_modes") or {}).get("default")


def writable_roots(config: Config) -> list[str]:
    """What the sandbox really lets the agent write: cwd, /tmp and $TMPDIR (as Codex's workspace-write)."""
    if config.sandbox_mode != "workspace-write":
        return []
    return [str(r) for r in seatbelt.writable_roots(config.cwd, config.exclude_tmp_writable_roots)]


def build_fragments(
    config: Config, skills: SkillLoadOutcome | None = None, memories: Fragment | None = None
) -> list[Fragment]:
    """All fragments for the current config, in Codex's order (core/src/session/mod.rs
    `build_initial_context_with_world_state`): developer instructions, thread context from
    extensions (memories), then the world-state sections, where skills go before permissions."""
    roots = writable_roots(config)
    fragments: list[Fragment] = []
    if config.developer_instructions:
        fragments.append(
            Fragment(
                "developer_instructions", "developer", config.developer_instructions, "config.developer_instructions"
            )
        )
    if memories:
        fragments.append(memories)
    if skills and config.include_skill_instructions:
        model = model_info(config.model)
        if catalog_fragment := render_available_skills(skills, model.include_skills_usage_instructions):
            fragments.append(catalog_fragment)
    fragments.append(render_permissions(config.sandbox_mode, config.approval_policy, config.network_access, roots))
    if mode := collaboration_mode_text(config.model):
        fragments.append(
            Fragment(
                "collaboration_mode",
                "developer",
                f"<collaboration_mode>{mode}</collaboration_mode>",
                "vendor/codex/models.json → model_messages.collaboration_modes.default",
            )
        )
    if agents := render_agents_md(config.cwd, config.home):
        fragments.append(agents)
    fragments.append(render_environment_context(config.cwd, config.sandbox_mode, roots))  # roots: write entries
    return fragments


def diff(previous: dict[str, str] | None, current: list[Fragment]) -> list[Fragment]:
    """Fragments that are new or whose text changed since the last snapshot."""
    if previous is None:
        return current
    return [f for f in current if previous.get(f.kind) != f.text]


def to_messages(fragments: list[Fragment]) -> list[ResponseItem]:
    """One message per role: developer bundle first, then user bundle."""
    messages = []
    for role in ("developer", "user"):
        texts = [f.text for f in fragments if f.role == role]
        if texts:
            messages.append(message(role, *texts))
    return messages


def snapshot(fragments: list[Fragment]) -> dict[str, str]:
    return {f.kind: f.text for f in fragments}
