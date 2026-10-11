"""A fragment is one piece of model-visible context with a role and wrapper tags.

Mirrors codex-rs/context-fragments/src/fragment.rs: `render()` is start marker + body + end marker.
"""

from dataclasses import dataclass


@dataclass(frozen=True)
class Fragment:
    kind: str  # stable id, e.g. "permissions" or "environment_context"
    role: str  # "developer" or "user"
    text: str  # fully rendered, including wrapper tags
    source: str  # where it came from (shown in the UI and the guide)
