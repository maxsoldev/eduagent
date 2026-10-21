// Mirrors pi packages/ai/src/models.ts (pinned 16f5f0af4), the thinking-level part: which levels
// a model supports, and how a level it does not support is clamped. pi also reads a per-model
// thinkingLevelMap (from OpenRouter's supported efforts); edupi has none, so xhigh and max are
// never supported and clamp down to high.
import type { Model, ThinkingLevel } from "./types.ts";

const EXTENDED_THINKING_LEVELS: ThinkingLevel[] = ["off", "minimal", "low", "medium", "high", "xhigh", "max"];

/** A model without reasoning has only "off". xhigh and max need an explicit map entry in pi. */
export function getSupportedThinkingLevels(model: Model): ThinkingLevel[] {
	if (!model.reasoning) return ["off"];
	return EXTENDED_THINKING_LEVELS.filter((level) => level !== "xhigh" && level !== "max");
}

/** An unsupported level becomes the next higher supported level, else the next lower one. */
export function clampThinkingLevel(model: Model, level: ThinkingLevel): ThinkingLevel {
	const availableLevels = getSupportedThinkingLevels(model);
	if (availableLevels.includes(level)) return level;

	const requestedIndex = EXTENDED_THINKING_LEVELS.indexOf(level);
	if (requestedIndex === -1) return availableLevels[0] ?? "off";
	for (let i = requestedIndex; i < EXTENDED_THINKING_LEVELS.length; i++) {
		if (availableLevels.includes(EXTENDED_THINKING_LEVELS[i])) return EXTENDED_THINKING_LEVELS[i];
	}
	for (let i = requestedIndex - 1; i >= 0; i--) {
		if (availableLevels.includes(EXTENDED_THINKING_LEVELS[i])) return EXTENDED_THINKING_LEVELS[i];
	}
	return availableLevels[0] ?? "off";
}
