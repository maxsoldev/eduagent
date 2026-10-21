// Mirrors pi packages/ai/src/providers/openrouter.ts and openrouter-api.ts (pinned 16f5f0af4): the
// OpenRouter provider. OpenRouter is an OpenAI-compatible endpoint, so its chat models use the
// "openai-completions" API with OpenRouter's base URL. pi ships a catalog generated from
// OpenRouter's GET /models (ai/scripts/openrouter-catalog.ts); edupi reads the same list when it
// starts. A model the list does not have gets the defaults of pi's models.json (core/model-config.ts).
import type { Model, ThinkingLevel, ThinkingLevelMap } from "../types.ts";

export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1";
export const OPENROUTER_API_KEY_ENV = "OPENROUTER_API_KEY";
export const DEFAULT_MODEL_ID = "openai/gpt-6-luna";

/** The fields pi reads from a model in OpenRouter's GET /models. Prices are $/token decimal strings. */
export interface OpenRouterModel {
	id: string;
	name?: string;
	context_length?: number | null;
	top_provider?: { context_length?: number | null; max_completion_tokens?: number | null };
	pricing?: { prompt?: string; completion?: string; input_cache_read?: string; input_cache_write?: string };
	supported_parameters?: string[];
	architecture?: { modality?: string };
	/** How a model reasons: `mandatory` means it cannot turn reasoning off. */
	reasoning?: { mandatory?: boolean; supported_efforts?: Array<ThinkingLevel | "none"> };
}

const THINKING_LEVELS: readonly ThinkingLevel[] = ["minimal", "low", "medium", "high", "xhigh", "max"];

/**
 * pi's getOpenRouterThinkingLevelMap (scripts/openrouter-reasoning-options.ts) with
 * getEffortThinkingLevelMap inlined: each pi level maps to the same effort, or null if the model
 * does not list it. "off" sends effort "none", unless reasoning is mandatory.
 */
export function getOpenRouterThinkingLevelMap(reasoning: OpenRouterModel["reasoning"]): ThinkingLevelMap | undefined {
	if (!reasoning) return undefined;
	const supported = new Set<string>(reasoning.supported_efforts ?? []);
	const mandatoryMap = reasoning.mandatory === true ? { off: null } : undefined;
	if (!THINKING_LEVELS.some((level) => supported.has(level)) && !supported.has("none")) return mandatoryMap;

	const map: ThinkingLevelMap = {};
	for (const level of THINKING_LEVELS) map[level] = supported.has(level) ? level : null;
	return { ...map, off: reasoning.mandatory === true ? null : "none" };
}

/** One $/token price as $/1M tokens. Missing, invalid and negative prices (router models) are 0. */
function perMillion(value: string | undefined): number {
	const perToken = Number.parseFloat(value ?? "");
	return perToken >= 0 ? Number((perToken * 1_000_000).toFixed(6)) : 0;
}

/** A model from OpenRouter's list, mapped as pi's catalog generator does (buildOpenRouterCatalog). */
export function modelFromOpenRouter(entry: OpenRouterModel): Model {
	const input: ("text" | "image")[] = ["text"];
	if (entry.architecture?.modality?.includes("image")) input.push("image");
	const thinkingLevelMap = getOpenRouterThinkingLevelMap(entry.reasoning);
	return {
		id: entry.id,
		name: entry.name ?? entry.id,
		api: "openai-completions",
		provider: "openrouter",
		baseUrl: OPENROUTER_BASE_URL,
		reasoning: entry.supported_parameters?.includes("reasoning") || false,
		...(thinkingLevelMap && { thinkingLevelMap }),
		input,
		cost: {
			input: perMillion(entry.pricing?.prompt),
			output: perMillion(entry.pricing?.completion),
			cacheRead: perMillion(entry.pricing?.input_cache_read),
			cacheWrite: perMillion(entry.pricing?.input_cache_write),
		},
		// `||`: OpenRouter reports a missing limit as absent, null or 0.
		contextWindow: entry.top_provider?.context_length || entry.context_length || 4096,
		maxTokens: entry.top_provider?.max_completion_tokens || 4096,
	};
}

/** A chat model OpenRouter did not list, with pi's models.json defaults. */
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

/** GET /models: OpenRouter's public model list. No API key is needed. */
export async function fetchOpenRouterModels(
	fetch: typeof globalThis.fetch = globalThis.fetch,
): Promise<OpenRouterModel[]> {
	const response = await fetch(`${OPENROUTER_BASE_URL}/models`, {
		headers: { accept: "application/json" },
		signal: AbortSignal.timeout(15_000),
	});
	if (!response.ok) throw new Error(`OpenRouter model list request failed: ${response.status}`);
	return ((await response.json()) as { data: OpenRouterModel[] }).data;
}
