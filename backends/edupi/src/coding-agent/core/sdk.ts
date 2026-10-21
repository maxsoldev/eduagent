// Mirrors pi packages/coding-agent/src/core/sdk.ts (pinned 16f5f0af4), createAgentSession: builds
// the Agent and the AgentSession for one session file. If the file already has messages, the
// Agent starts from the context rebuilt from its entries, with the session's model and thinking
// level. A new session first records its model and thinking level as entries.
import { Agent } from "../../agent/agent.ts";
import type { StreamFn, ThinkingLevel } from "../../agent/types.ts";
import { clampThinkingLevel } from "../../ai/models.ts";
import { DEFAULT_MODEL_ID } from "../../ai/providers/openrouter.ts";
import type { Model } from "../../ai/types.ts";
import { getAgentDir } from "../config.ts";
import { AgentSession } from "./agent-session.ts";
import { DEFAULT_THINKING_LEVEL } from "./defaults.ts";
import { convertToLlm } from "./messages.ts";
import type { ModelRegistry } from "./model-registry.ts";
import type { Probe } from "./probe.ts";
import { DefaultResourceLoader } from "./resource-loader.ts";
import type { SessionManager } from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";
import { createCodingTools } from "./tools/index.ts";

export interface CreateAgentSessionOptions {
	sessionManager: SessionManager;
	/** The model from --model. Without it: the session's model, else edupi's default. */
	model?: Model;
	/** Where the session's model is looked up (its context window and prices). */
	modelRegistry: ModelRegistry;
	streamFn: StreamFn;
	getApiKey: (provider: string) => string | undefined;
	settingsManager: SettingsManager;
	/** Where the tools work. Default: the session's cwd. */
	cwd?: string;
	/** edupi: the teaching extras' hooks. */
	probe?: Probe;
	/** May files from <cwd>/.pi be loaded? Resolved by main.ts (pi: SettingsManager projectTrusted). Default: no. */
	projectTrusted?: boolean;
}

export function createAgentSession(options: CreateAgentSessionOptions): AgentSession {
	const { sessionManager } = options;
	const existingSession = sessionManager.buildSessionContext();
	const hasExistingSession = existingSession.messages.length > 0;
	const hasThinkingEntry = sessionManager.getBranch().some((entry) => entry.type === "thinking_level_change");

	// pi looks the session's model up in its model registry. edupi knows only OpenRouter models.
	let model = options.model;
	if (!model && hasExistingSession && existingSession.model) {
		model = options.modelRegistry.find(existingSession.model.provider, existingSession.model.modelId);
	}
	model ??= options.modelRegistry.find("openrouter", DEFAULT_MODEL_ID)!;

	// The session's level, else pi's default; then clamped to what the model supports.
	let thinkingLevel: ThinkingLevel =
		hasExistingSession && hasThinkingEntry
			? (existingSession.thinkingLevel as ThinkingLevel)
			: DEFAULT_THINKING_LEVEL;
	thinkingLevel = clampThinkingLevel(model, thinkingLevel);

	// pi's default coding tools, working in the session's directory.
	const cwd = options.cwd ?? sessionManager.getCwd();
	// bash reads the session's PI_* variables when a command runs (pi takes them from the tool call's context).
	const tools = createCodingTools(cwd, {
		bash: {
			getSessionEnvironment: () => ({
				sessionId: sessionManager.getSessionId(),
				sessionFile: sessionManager.getSessionFile(),
				provider: agent.state.model.provider,
				model: agent.state.model.id,
				thinkingLevel: agent.state.thinkingLevel,
			}),
		},
	});

	// AGENTS.md files, skills and SYSTEM.md, read once per session.
	const resourceLoader = new DefaultResourceLoader({
		cwd,
		agentDir: getAgentDir(),
		projectTrusted: options.projectTrusted ?? false,
	});
	resourceLoader.reload();

	const agent = new Agent({
		initialState: { model, thinkingLevel, tools, messages: existingSession.messages },
		convertToLlm,
		streamFn: options.streamFn,
		getApiKey: options.getApiKey,
		sessionId: sessionManager.getSessionId(),
		probe: options.probe,
	});

	// Record the settings, so a reopened session restores them.
	if (hasExistingSession) {
		if (!hasThinkingEntry) sessionManager.appendThinkingLevelChange(thinkingLevel);
	} else {
		sessionManager.appendModelChange(model.provider, model.id);
		sessionManager.appendThinkingLevelChange(thinkingLevel);
	}

	return new AgentSession({
		agent,
		sessionManager,
		settingsManager: options.settingsManager,
		getApiKey: options.getApiKey,
		resourceLoader,
		probe: options.probe,
	});
}
