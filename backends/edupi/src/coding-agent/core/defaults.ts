// Mirrors pi packages/coding-agent/src/core/defaults.ts (pinned 16f5f0af4): the thinking level a
// new session starts with. It is clamped to what the model supports ("off" without reasoning).
import type { ThinkingLevel } from "../../agent/types.ts";

export const DEFAULT_THINKING_LEVEL: ThinkingLevel = "medium";
