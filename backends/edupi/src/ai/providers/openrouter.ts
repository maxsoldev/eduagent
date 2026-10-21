// Mirrors pi packages/ai/src/providers/openrouter.ts (pinned 16f5f0af4): the OpenRouter provider.
// OpenRouter is an OpenAI-compatible endpoint, so its chat models use the "openai-completions"
// API with OpenRouter's base URL. pi reads model metadata from a generated catalog; edupi accepts
// any OpenRouter model id and fills in the defaults of pi's models.json (core/model-config.ts).
import type { Model } from "../types.ts";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_API_KEY_ENV = "OPENROUTER_API_KEY";
export const DEFAULT_MODEL_ID = "openai/gpt-6-luna";

/** A chat model on OpenRouter, for example "openai/gpt-6-luna" or "anthropic/claude-sonnet-5". */
export function openRouterModel(id: string = DEFAULT_MODEL_ID): Model {
  return {
    id,
    name: id,
    api: "openai-completions",
    provider: "openrouter",
    baseUrl: OPENROUTER_BASE_URL,
    reasoning: false,
    input: ["text"],
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 },
    contextWindow: 128000,
    maxTokens: 16384,
  };
}
