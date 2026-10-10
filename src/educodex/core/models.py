"""The model catalog: per-model settings that drive harness behaviour.

Mirrors codex-rs/models-manager/ (models.json + ModelInfo in protocol/src/openai_models.rs).
Codex fetches a fresh catalog from the backend; we only use the vendored copy.
"""

import json
from dataclasses import dataclass
from functools import cache

from educodex import vendor


@dataclass(frozen=True)
class ModelInfo:
    slug: str
    display_name: str
    base_instructions: str  # model_messages.instructions_template, sent as the first developer message
    context_window: int
    auto_compact_token_limit: int | None
    truncation_limit_tokens: int  # truncation_policy.limit: cap for tool output sent to the model
    apply_patch_tool_type: str | None  # "freeform" -> custom grammar tool
    supports_parallel_tool_calls: bool
    supports_reasoning_summary_parameter: bool  # may we send reasoning.summary?
    default_reasoning_level: str | None
    default_reasoning_summary: str | None
    default_verbosity: str | None
    support_verbosity: bool
    # How Codex itself would call this model. educodex always uses classic tools in `tools`
    # (what Codex does for gpt-5.5); see docs/guide/06-model-catalog.md.
    codex_tool_mode: str | None  # "code_mode_only": Codex exposes one JavaScript `exec` tool instead
    codex_use_responses_lite: bool  # Codex sends tools as an `additional_tools` input item

    def effective_auto_compact_limit(self) -> int:
        """Codex compacts at min(configured limit, 90% of the context window)."""
        ninety_percent = self.context_window * 9 // 10
        if self.auto_compact_token_limit is None:
            return ninety_percent
        return min(self.auto_compact_token_limit, ninety_percent)


@cache
def catalog() -> dict[str, dict]:
    return {m["slug"]: m for m in json.loads(vendor.read("models.json"))["models"]}


def model_info(model: str) -> ModelInfo:
    """Look up a model by slug. OpenRouter slugs like 'openai/gpt-6-luna' map to 'gpt-6-luna'."""
    slug = model.split("/", 1)[-1]
    raw = catalog().get(slug)
    if raw is None:  # like Codex, fall back to the longest catalog slug that prefixes this one
        prefixes = [s for s in catalog() if slug.startswith(s)]
        if not prefixes:
            raise KeyError(f"model {slug!r} is not in the Codex catalog (vendor/codex/models.json)")
        slug = max(prefixes, key=len)
        raw = catalog()[slug]
    return ModelInfo(
        slug=slug,
        display_name=raw.get("display_name", slug),
        base_instructions=raw["model_messages"]["instructions_template"],
        context_window=raw["context_window"],
        auto_compact_token_limit=raw.get("auto_compact_token_limit"),
        truncation_limit_tokens=raw["truncation_policy"]["limit"],
        apply_patch_tool_type=raw.get("apply_patch_tool_type"),
        supports_parallel_tool_calls=raw.get("supports_parallel_tool_calls", False),
        supports_reasoning_summary_parameter=raw.get("supports_reasoning_summary_parameter", True),
        default_reasoning_level=raw.get("default_reasoning_level"),
        default_reasoning_summary=raw.get("default_reasoning_summary"),
        default_verbosity=raw.get("default_verbosity"),
        support_verbosity=raw.get("support_verbosity", False),
        codex_tool_mode=raw.get("tool_mode"),
        codex_use_responses_lite=raw.get("use_responses_lite", False),
    )
