"""The <permissions instructions> developer fragment: tells the model its sandbox and approval rules.

Mirrors codex-rs/prompts/src/permissions_instructions.rs. The text comes from Codex's own
templates (vendor/codex/templates/permissions/), composed in the same order:
sandbox text, approval text, writable roots.
"""

from educodex import vendor
from educodex.core.context.fragments import Fragment

SANDBOX_TEMPLATES = {
    "read-only": "templates/permissions/sandbox_mode/read_only.md",
    "workspace-write": "templates/permissions/sandbox_mode/workspace_write.md",
    "danger-full-access": "templates/permissions/sandbox_mode/danger_full_access.md",
}
APPROVAL_TEMPLATES = {
    "on-request": "templates/permissions/approval_policy/on_request.md",
    "never": "templates/permissions/approval_policy/never.md",
}


def _append_section(text: str, section: str) -> str:
    if not text.endswith("\n"):  # also on empty text, so the fragment body starts with "\n"
        text += "\n"
    return text + section


def render_permissions(
    sandbox_mode: str, approval_policy: str, network_access: bool, writable_roots: list[str]
) -> Fragment:
    sandbox = vendor.read(SANDBOX_TEMPLATES[sandbox_mode]).rstrip()
    sandbox = sandbox.replace("{{ network_access }}", "enabled" if network_access else "restricted")
    text = _append_section("", sandbox)
    text = _append_section(text, vendor.read(APPROVAL_TEMPLATES[approval_policy]))
    if writable_roots and sandbox_mode == "workspace-write":
        quoted = [f"`{root}`" for root in writable_roots]
        roots = (
            f" The writable root is {quoted[0]}."
            if len(quoted) == 1
            else f" The writable roots are {', '.join(quoted)}."
        )
        text = _append_section(text, roots)
    if not text.endswith("\n"):
        text += "\n"
    return Fragment(
        kind="permissions",
        role="developer",
        text=f"<permissions instructions>{text}</permissions instructions>",
        source=f"vendor/codex/{SANDBOX_TEMPLATES[sandbox_mode]} + {APPROVAL_TEMPLATES[approval_policy]}",
    )
