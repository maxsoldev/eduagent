// Mirrors pi packages/coding-agent/src/core/model-registry.ts (pinned 16f5f0af4): finds a model
// by provider and id. pi's registry merges its generated catalog, models.json and a refreshed
// OpenRouter list. edupi knows only OpenRouter: it reads OpenRouter's model list once at start
// (pi refreshes it in the background), and fills in pi's defaults for ids the list lacks.
import { fetchOpenRouterModels, modelFromOpenRouter, openRouterModel } from "../../ai/providers/openrouter.ts";
import type { Model } from "../../ai/types.ts";

export class ModelRegistry {
	private constructor(private readonly models: Map<string, Model>) {}

	/** Reads OpenRouter's list. Offline (pi's --offline) or on failure, every model gets the defaults. */
	static async load(options: { fetch?: typeof globalThis.fetch; offline?: boolean } = {}): Promise<ModelRegistry> {
		const models = new Map<string, Model>();
		if (!options.offline) {
			try {
				for (const entry of await fetchOpenRouterModels(options.fetch))
					models.set(entry.id, modelFromOpenRouter(entry));
			} catch (error) {
				console.error(
					`edupi: could not read OpenRouter's model list (${error instanceof Error ? error.message : error}); using default model limits`,
				);
			}
		}
		return new ModelRegistry(models);
	}

	/** The models OpenRouter's list gave (none offline). */
	getAll(): Model[] {
		return [...this.models.values()];
	}

	/** The model with this id. edupi has one provider, so other providers find nothing. */
	find(provider: string, modelId: string): Model | undefined {
		if (provider !== "openrouter") return undefined;
		return this.models.get(modelId) ?? openRouterModel(modelId);
	}
}
