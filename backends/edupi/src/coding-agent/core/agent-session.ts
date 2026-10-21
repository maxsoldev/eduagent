// Mirrors pi packages/coding-agent/src/core/agent-session.ts (pinned 16f5f0af4): the session around
// the Agent that every mode drives. It builds the system prompt before each run, turns a prompt into a
// run (or queues it while one is active), forwards the Agent's events plus its own (agent_settled,
// queue_update, compaction_start/end), saves finished messages, compacts (by hand, at the threshold,
// after an overflow) and answers get_state. The methods are in pi's order.
import { readFileSync } from "node:fs";
import type { Agent } from "../../agent/agent.ts";
import type { AgentContext, AgentEvent, AgentMessage, QueueMode } from "../../agent/types.ts";
import { clampThinkingLevel } from "../../ai/models.ts";
import type {
	AssistantMessage,
	ImageContent,
	Model,
	SystemMessage,
	TextContent,
	ThinkingLevel,
	ToolResultMessage,
} from "../../ai/types.ts";
import { isContextOverflow } from "../../ai/utils/overflow.ts";
import { contentText, getCurrentSystemMessage } from "../../ai/utils/transcript.ts";
import { stripFrontmatter } from "../utils/frontmatter.ts";
import {
	type CompactionPreparation,
	type CompactionResult,
	calculateContextTokens,
	compact,
	estimateProjectedContextTokens,
	estimateTokens,
	prepareCompaction,
	shouldCompact,
} from "./compaction/compaction.ts";
import type { Probe } from "./probe.ts";
import type { DefaultResourceLoader } from "./resource-loader.ts";
import {
	type CompactionEntry,
	getLatestCompactionEntry,
	type SessionEntry,
	type SessionManager,
} from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";
import { type BuildSystemPromptOptions, buildSystemPromptSections, diffSystemPromptSections } from "./system-prompt.ts";
import { toolSystemPromptContributions } from "./tools/index.ts";

export type CompactionReason = "manual" | "threshold" | "overflow";

/** The Agent's events, with willRetry on agent_end, plus the session's own events. */
export type AgentSessionEvent =
	| Exclude<AgentEvent, { type: "agent_end" }>
	| { type: "agent_end"; messages: AgentMessage[]; willRetry: boolean }
	| { type: "agent_settled"; aborted: boolean }
	| { type: "queue_update"; steering: readonly string[]; followUp: readonly string[] }
	| { type: "thinking_level_changed"; level: ThinkingLevel }
	| { type: "compaction_start"; reason: CompactionReason }
	| { type: "entry_appended"; entry: SessionEntry }
	| {
			type: "compaction_end";
			reason: CompactionReason;
			result: CompactionResult | undefined;
			aborted: boolean;
			willRetry: boolean;
			errorMessage?: string;
	  };

export type AgentSessionEventListener = (event: AgentSessionEvent) => void;

export type QueuedInputDisposition = "handled" | "queued";
export type PromptDisposition = QueuedInputDisposition | "started";

export interface PromptOptions {
	images?: ImageContent[];
	/** While a run is active, queue the prompt as a steering or follow-up message. */
	streamingBehavior?: "steer" | "followUp";
	/** Called once the prompt is accepted, before the first model request. */
	preflightResult?: (disposition: PromptDisposition) => void;
}

export interface AgentSessionConfig {
	agent: Agent;
	sessionManager: SessionManager;
	settingsManager: SettingsManager;
	/** The key for a provider, or undefined if none is configured. */
	getApiKey: (provider: string) => string | undefined;
	/** The loaded AGENTS.md files and skills. */
	resourceLoader: DefaultResourceLoader;
	/** edupi's teaching hooks (prompt, skills, compaction); pi has none. */
	probe?: Probe;
}

export class AgentSession {
	readonly agent: Agent;
	readonly sessionManager: SessionManager;
	readonly settingsManager: SettingsManager;
	readonly resourceLoader: DefaultResourceLoader;
	private readonly _getApiKey: (provider: string) => string | undefined;
	private readonly _probe: Probe | undefined;
	private _eventListeners: AgentSessionEventListener[] = [];

	// Run state
	private _isAgentRunActive = false; // from _startRun until agent_settled
	private _agentRunAbortRequested = false; // agent_settled reports it as `aborted`
	private _idleWaiters: (() => void)[] = []; // resolved after agent_settled

	// The texts of the queued messages, for queue_update. The messages themselves are in the Agent.
	private _steeringMessages: string[] = [];
	private _followUpMessages: string[] = [];

	// System prompt state
	private _baseSystemPromptOptions!: BuildSystemPromptOptions;
	private _skillsReported = false;

	// Compaction state
	private _compactionAbortController: AbortController | undefined = undefined; // manual
	private _autoCompactionAbortController: AbortController | undefined = undefined; // threshold, overflow
	private _overflowRecoveryAttempted = false; // one compact-and-retry per user message
	private _lastAssistantMessage: AssistantMessage | undefined = undefined; // of the current run
	private _lastAssistantToolResults: ToolResultMessage[] = [];
	/** The entry each message of the context was saved as (a context edit needs its id). */
	private _entryIdsByMessage = new WeakMap<AgentMessage, string>();

	constructor(config: AgentSessionConfig) {
		this.agent = config.agent;
		this.sessionManager = config.sessionManager;
		this.settingsManager = config.settingsManager;
		this._getApiKey = config.getApiKey;
		this.resourceLoader = config.resourceLoader;
		this._probe = config.probe;

		this.agent.subscribe(this._handleAgentEvent);
		this._installAgentNextTurnRefresh();
		this._refreshFinalizedContext(); // records the entry of each restored message
		this._rebuildSystemPrompt(this.agent.state.tools.map((tool) => tool.name));
		this._probe?.sessionStarted?.({ sessionId: this.sessionId });
	}

	/**
	 * Before each later model call of a run (after tool results): compact if the context is above
	 * the threshold. The next turn then starts from the context rebuilt from the session file.
	 */
	private async _compactBeforeNextAssistantResponse(context: AgentContext): Promise<AgentContext> {
		const projection = this.sessionManager.buildSessionProjection();
		const tokens = estimateProjectedContextTokens(projection, this.sessionManager.getBranch()).tokens;
		if (!shouldCompact(tokens, this.model.contextWindow, this.settingsManager.getCompactionSettings()))
			return { ...context, messages: projection.messages };
		await this._runAutoCompaction("threshold", false);
		return { ...context, messages: this.sessionManager.buildSessionProjection().messages };
	}

	/** Each later turn of a run gets the rebuilt context and the current model and thinking level. */
	private _installAgentNextTurnRefresh(): void {
		this.agent.prepareNextTurn = async ({ context }) => ({
			context: await this._compactBeforeNextAssistantResponse(context),
			model: this.agent.state.model,
			thinkingLevel: this.agent.state.thinkingLevel,
		});
	}

	// =========================================================================
	// Event Subscription
	// =========================================================================

	/** After compaction or an omission, the Agent's messages are rebuilt from the session file. */
	private _refreshFinalizedContext(): void {
		const projection = this.sessionManager.buildSessionProjection();
		for (const entry of projection.entries) {
			for (const message of entry.messages) this._entryIdsByMessage.set(message, entry.sourceEntry.id);
		}
		this.agent.state.messages = projection.messages;
	}

	private _emit(event: AgentSessionEvent): void {
		for (const listener of this._eventListeners) listener(event);
	}

	private _emitQueueUpdate(): void {
		this._emit({
			type: "queue_update",
			steering: [...this._steeringMessages],
			followUp: [...this._followUpMessages],
		});
	}

	private _resolveIdleWaitIfIdle(): void {
		if (!this.isIdle) return;
		for (const resolve of this._idleWaiters.splice(0)) resolve();
	}

	private _emitAgentSettled(): void {
		this._isAgentRunActive = false;
		this._emit({ type: "agent_settled", aborted: this._agentRunAbortRequested });
		this._resolveIdleWaitIfIdle();
	}

	private _handleAgentEvent = async (event: AgentEvent): Promise<void> => {
		// A queued message that starts leaves its queue first, so a client sees the queue change before the message.
		if (event.type === "message_start" && event.message.role === "user") {
			this._overflowRecoveryAttempted = false; // a new user message allows a new overflow recovery
			const messageText = contentText(event.message.content, "");
			if (messageText) {
				const steeringIndex = this._steeringMessages.indexOf(messageText);
				if (steeringIndex !== -1) {
					this._steeringMessages.splice(steeringIndex, 1);
					this._emitQueueUpdate();
				} else {
					const followUpIndex = this._followUpMessages.indexOf(messageText);
					if (followUpIndex !== -1) {
						this._followUpMessages.splice(followUpIndex, 1);
						this._emitQueueUpdate();
					}
				}
			}
		}

		this._emit(event.type === "agent_end" ? { ...event, willRetry: false } : event); // edupi has no auto-retry

		// Each finished message becomes a "message" entry, child of the last entry.
		if (event.type === "message_end") {
			const message = event.message;
			if (
				message.role === "system" ||
				message.role === "user" ||
				message.role === "assistant" ||
				message.role === "toolResult"
			) {
				this._entryIdsByMessage.set(message, this.sessionManager.appendMessage(message));
			}
			if (message.role === "assistant") {
				this._lastAssistantMessage = message;
				if (message.stopReason !== "error") this._overflowRecoveryAttempted = false;
			}
		}
		if (event.type === "turn_end") this._lastAssistantToolResults = event.toolResults;
	};

	/** Leaves the failed reply (and its tool results) out of the context with context_edit entries. */
	private _omitRecoveryAttempt(message: AssistantMessage, toolResults: AgentMessage[] = []): void {
		for (const target of [message, ...toolResults]) {
			const targetId = this._entryIdsByMessage.get(target);
			if (!targetId) continue;
			const entry = this.sessionManager.getEntry(this.sessionManager.appendContextEdit(targetId, null));
			if (entry) this._emit({ type: "entry_appended", entry });
		}
		this._refreshFinalizedContext();
	}

	private _findLastAssistantMessage(): AssistantMessage | undefined {
		return this.agent.state.messages.findLast((msg) => msg.role === "assistant");
	}

	subscribe(listener: AgentSessionEventListener): () => void {
		this._eventListeners.push(listener);
		return () => {
			this._eventListeners = this._eventListeners.filter((l) => l !== listener);
		};
	}

	// =========================================================================
	// Read-only State Access
	// =========================================================================

	get model(): Model {
		return this.agent.state.model;
	}

	get thinkingLevel(): ThinkingLevel {
		return this.agent.state.thinkingLevel;
	}

	get isStreaming(): boolean {
		return this._isAgentRunActive;
	}

	/** No active run and no compaction. */
	get isIdle(): boolean {
		return !this._isAgentRunActive && !this.isCompacting;
	}

	get isCompacting(): boolean {
		return this._compactionAbortController !== undefined || this._autoCompactionAbortController !== undefined;
	}

	get messages(): AgentMessage[] {
		return this.agent.state.messages;
	}

	get steeringMode(): QueueMode {
		return this.agent.steeringMode; // pi's default "one-at-a-time" (settings-defaults.ts)
	}

	get followUpMode(): QueueMode {
		return this.agent.followUpMode;
	}

	/** The session file. It exists once the first message is saved. */
	get sessionFile(): string {
		return this.sessionManager.getSessionFile();
	}

	get sessionId(): string {
		return this.sessionManager.getSessionId();
	}

	/** Gathers the prompt's inputs: cwd, skills, AGENTS.md files, tool snippets and guidelines. */
	private _rebuildSystemPrompt(toolNames: string[]): void {
		const toolSnippets: Record<string, string> = {};
		const toolGuidelines: Record<string, string[]> = {};
		for (const name of toolNames) {
			const contribution = toolSystemPromptContributions[name];
			if (!contribution) continue; // tools without a snippet are not listed
			toolSnippets[name] = contribution.snippet;
			toolGuidelines[name] = [...contribution.guidelines];
		}
		this._baseSystemPromptOptions = {
			cwd: this.resourceLoader.cwd,
			skills: this.resourceLoader.getSkills().skills,
			contextFiles: this.resourceLoader.getAgentsFiles().agentsFiles,
			selectedTools: toolNames,
			toolSnippets,
			toolGuidelines,
		};
	}

	/**
	 * Diffs the sections the model has (replayed from the transcript) with the wanted ones. Returns
	 * a system message with the changed sections, or undefined when the prompt is unchanged.
	 */
	private _preparePromptAndToolLoadout(options: BuildSystemPromptOptions): SystemMessage | undefined {
		const sections = buildSystemPromptSections(options);
		const previous = getCurrentSystemMessage(this.agent.state.messages)?.sections;
		const patch = diffSystemPromptSections(previous ?? {}, sections);
		this._reportPrompt(sections, patch, previous === undefined);
		return patch ? { role: "system", content: "", sections: patch, timestamp: Date.now() } : undefined;
	}

	/** edupi: tells the probe what went into the prompt. pi loads skills at startup; the trace reports them with the first run. */
	private _reportPrompt(
		sections: Record<string, string>,
		patch: Record<string, string | null> | undefined,
		firstTurn: boolean,
	): void {
		if (!this._probe) return;
		const loader = this.resourceLoader;
		if (!this._skillsReported) {
			this._skillsReported = true;
			const { skills, diagnostics } = loader.getSkills();
			this._probe.skillsLoaded?.({ roots: loader.getSkillRoots(), skills, diagnostics });
		}
		this._probe.promptAssembled?.({
			sections,
			patch,
			firstTurn,
			contextFiles: loader.getAgentsFiles().agentsFiles.map((file) => file.path),
		});
	}

	// =========================================================================
	// Prompting
	// =========================================================================

	/**
	 * One run: compact first if needed, the system prompt update and the user message, the Agent's
	 * loop, then the post-run check (compact; after an overflow, compact and continue), then agent_settled.
	 */
	private async _startRun(text: string, images: ImageContent[], onStarted?: () => void): Promise<void> {
		this._isAgentRunActive = true;
		this._agentRunAbortRequested = false;
		let messages: AgentMessage[];
		try {
			messages = await this._prepareRun(text, images);
		} catch (error) {
			this._isAgentRunActive = false;
			this._resolveIdleWaitIfIdle();
			throw error;
		}
		onStarted?.();
		try {
			await this.agent.prompt(messages);
			// Go on after an overflow retry, or while messages were queued too late for the loop. Not after an abort.
			while (!this._agentRunAbortRequested) {
				if (await this._handlePostAgentRun()) {
					if (this._agentRunAbortRequested) break;
					await this.agent.continue();
					continue;
				}
				if (this._agentRunAbortRequested || !this.agent.hasQueuedMessages()) break;
				await this.agent.continue();
			}
		} finally {
			this._emitAgentSettled();
		}
	}

	/**
	 * The run's starting messages. The context may be over the threshold already: check it first.
	 * Then a system message with the changed prompt sections (on the first run: all of them), then
	 * the user message. The agent loop adds the tool declarations to the system message.
	 */
	private async _prepareRun(text: string, images: ImageContent[]): Promise<AgentMessage[]> {
		const lastAssistant = this._findLastAssistantMessage();
		if (lastAssistant) await this._checkCompaction(lastAssistant, false);
		const messages: AgentMessage[] = [
			{ role: "user", content: [{ type: "text", text }, ...images], timestamp: Date.now() },
		];
		const updateMessage = this._preparePromptAndToolLoadout(this._baseSystemPromptOptions);
		if (updateMessage) messages.unshift(updateMessage);
		return messages;
	}

	/** After the loop: should it continue? Only after an overflow recovery (pi also: retries). */
	private async _handlePostAgentRun(): Promise<boolean> {
		const message = this._lastAssistantMessage;
		const toolResults = this._lastAssistantToolResults;
		this._lastAssistantMessage = undefined;
		this._lastAssistantToolResults = [];
		if (!message) return false;
		return this._checkCompaction(message, true, toolResults);
	}

	/**
	 * Sends a prompt. While a run is active it needs a streamingBehavior and is queued. Before a run
	 * starts it checks the model's API key; after preflightResult("started"), failures are events.
	 */
	async prompt(text: string, options?: PromptOptions): Promise<void> {
		// Only a manual compaction refuses; during an automatic one a run is active, so the prompt is queued.
		if (this._compactionAbortController !== undefined) {
			throw new Error(
				"Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.",
			);
		}
		const expandedText = this._expandSkillCommand(text); // pi also expands prompt templates here

		if (this.isStreaming) {
			if (!options?.streamingBehavior) {
				throw new Error(
					"Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.",
				);
			}
			if (options.streamingBehavior === "followUp") this._queueFollowUp(expandedText, options.images);
			else this._queueSteer(expandedText, options.images);
			options.preflightResult?.("queued");
			return;
		}

		if (!this._getApiKey(this.model.provider)) {
			throw new Error(
				`No API key found for ${this.model.provider}.\n\nSet OPENROUTER_API_KEY in the environment or in the repo-root .env file.`,
			);
		}
		await this._startRun(expandedText, options?.images ?? [], () => options?.preflightResult?.("started"));
	}

	/**
	 * `/skill:name args` becomes the skill's SKILL.md body (without frontmatter) in a <skill> block,
	 * then the args. Unknown skills pass through unchanged. This also works for skills hidden from the model.
	 */
	private _expandSkillCommand(text: string): string {
		if (!text.startsWith("/skill:")) return text;
		const spaceIndex = text.indexOf(" ");
		const skillName = spaceIndex === -1 ? text.slice(7) : text.slice(7, spaceIndex);
		const args = spaceIndex === -1 ? "" : text.slice(spaceIndex + 1).trim();
		const skill = this.resourceLoader.getSkills().skills.find((s) => s.name === skillName);
		if (!skill) return text;
		const body = stripFrontmatter(readFileSync(skill.filePath, "utf-8")).trim();
		const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
		return args ? `${skillBlock}\n\n${args}` : skillBlock;
	}

	/** Queues a steering message: it goes in after the current turn's tools, before the next model call. */
	async steer(text: string, images?: ImageContent[]): Promise<QueuedInputDisposition> {
		this._queueSteer(this._expandSkillCommand(text), images);
		return "queued";
	}

	/** Queues a follow-up message: it runs when the agent has no more tool calls or steering messages. */
	async followUp(text: string, images?: ImageContent[]): Promise<QueuedInputDisposition> {
		this._queueFollowUp(this._expandSkillCommand(text), images);
		return "queued";
	}

	private _queueSteer(text: string, images?: ImageContent[]): void {
		this._steeringMessages.push(text);
		this._emitQueueUpdate();
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }, ...(images ?? [])];
		this.agent.steer({ role: "user", content, timestamp: Date.now() });
	}

	private _queueFollowUp(text: string, images?: ImageContent[]): void {
		this._followUpMessages.push(text);
		this._emitQueueUpdate();
		const content: (TextContent | ImageContent)[] = [{ type: "text", text }, ...(images ?? [])];
		this.agent.followUp({ role: "user", content, timestamp: Date.now() });
	}

	/** Steering plus follow-up messages that wait for the loop. */
	get pendingMessageCount(): number {
		return this._steeringMessages.length + this._followUpMessages.length;
	}

	/** Aborts the active run (stream and tools) and any compaction, and resolves once idle. The queues stay. */
	async abort(): Promise<void> {
		if (this._isAgentRunActive) this._agentRunAbortRequested = true;
		this.abortCompaction();
		this.agent.abort();
		await this.waitForIdle();
	}

	/** Resolves once the session is idle: after agent_settled, or when a compaction outside a run ends. */
	waitForIdle(): Promise<void> {
		if (this.isIdle) return Promise.resolve();
		return new Promise((resolve) => this._idleWaiters.push(resolve));
	}

	// =========================================================================
	// Thinking Level Management
	// =========================================================================

	/**
	 * Sets the thinking level, clamped to what the model supports. Only a real change is saved as
	 * a thinking_level_change entry and announced with thinking_level_changed. The next model call uses it.
	 */
	setThinkingLevel(level: ThinkingLevel): void {
		const effectiveLevel = clampThinkingLevel(this.model, level); // a supported level stays as it is
		const isChanging = effectiveLevel !== this.agent.state.thinkingLevel;
		this.agent.state.thinkingLevel = effectiveLevel;
		if (isChanging) {
			this.sessionManager.appendThinkingLevelChange(effectiveLevel);
			this._emit({ type: "thinking_level_changed", level: effectiveLevel });
		}
	}

	// =========================================================================
	// Compaction
	// =========================================================================

	/** pi's built-in summary, for every reason. edupi's probe sees each summary request body. */
	private async _runDefaultCompaction(
		preparation: CompactionPreparation,
		model: Model,
		customInstructions: string | undefined,
		signal: AbortSignal,
		reason: CompactionReason,
	): Promise<CompactionResult> {
		const onPayload = (body: unknown) => {
			void this._probe?.compactionRequest?.({ reason, tokensBefore: preparation.tokensBefore, body });
			return undefined;
		};
		return compact(
			preparation,
			model,
			this._getApiKey(model.provider),
			this.agent.streamFunction,
			customInstructions,
			signal,
			this.agent.state.thinkingLevel,
			onPayload,
		);
	}

	/**
	 * edupi: the steps compact() and _runAutoCompaction() share after the summary (pi repeats
	 * them in both). Saves the compaction entry and rebuilds the Agent's messages from it.
	 */
	private _saveCompaction(compacted: CompactionResult, reason: CompactionReason): CompactionResult {
		const { summary, firstKeptEntryId, tokensBefore, usage, details } = compacted;
		this.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, undefined, usage);
		this._refreshFinalizedContext();
		const messagesAfter = this.sessionManager.buildSessionProjection().messages;
		const estimatedTokensAfter = messagesAfter.reduce((tokens, message) => tokens + estimateTokens(message), 0);
		const result = { summary, firstKeptEntryId, tokensBefore, estimatedTokensAfter, usage, details };
		void this._probe?.compacted?.({ reason, ...result, messages: this.agent.state.messages });
		return result;
	}

	private _clearManualCompactionState(): void {
		this._compactionAbortController = undefined;
		this._resolveIdleWaitIfIdle();
	}

	/** Manual compaction (RPC `compact`, pi's /compact). A running turn is aborted first. Never retries. */
	async compact(customInstructions?: string): Promise<CompactionResult> {
		await this.abort();
		this._compactionAbortController = new AbortController();
		this._emit({ type: "compaction_start", reason: "manual" });
		try {
			const pathEntries = this.sessionManager.getBranch();
			const preparation = prepareCompaction(pathEntries, this.settingsManager.getCompactionSettings());
			if (!preparation) {
				const lastEntry = pathEntries[pathEntries.length - 1];
				if (lastEntry?.type === "compaction") throw new Error("Already compacted");
				throw new Error("Nothing to compact (session too small)");
			}

			const result = await this._runDefaultCompaction(
				preparation,
				this.model,
				customInstructions,
				this._compactionAbortController.signal,
				"manual",
			);
			if (this._compactionAbortController.signal.aborted) throw new Error("Compaction cancelled");

			const compactionResult = this._saveCompaction(result, "manual");
			this._clearManualCompactionState(); // compaction_end listeners may send a prompt: be idle first
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: compactionResult,
				aborted: false,
				willRetry: false,
			});
			return compactionResult;
		} catch (error) {
			const message = error instanceof Error ? error.message : String(error);
			const aborted = this._compactionAbortController?.signal.aborted ?? false;
			this._clearManualCompactionState();
			this._emit({
				type: "compaction_end",
				reason: "manual",
				result: undefined,
				aborted,
				willRetry: false,
				errorMessage: aborted ? undefined : `Compaction failed: ${message}`,
			});
			throw error;
		}
	}

	/** Cancels a running compaction (manual or automatic). */
	abortCompaction(): void {
		this._compactionAbortController?.abort();
		this._autoCompactionAbortController?.abort();
	}

	// The automatic cases, checked before a prompt and after each run. Returns whether the run goes on.
	// 1. Overflow with retry: the provider refused the context: drop the failed reply, compact, and
	//    continue the run once.
	// 2. Overflow without retry: the reply succeeded but its input exceeded the window. Compact.
	// 3. Threshold: the context is above contextWindow - reserveTokens. Compact, no retry.
	private async _checkCompaction(
		assistantMessage: AssistantMessage,
		skipAbortedCheck = true,
		toolResults: AgentMessage[] = [],
	): Promise<boolean> {
		const settings = this.settingsManager.getCompactionSettings();
		if (!settings.enabled) return false;
		if (skipAbortedCheck && assistantMessage.stopReason === "aborted") return false;

		// An overflow of another model (the user switched models) says nothing about this one.
		const model = this.model;
		const sameModel = model.provider === assistantMessage.provider && model.id === assistantMessage.model;
		const contextWindow = model.contextWindow;

		// A reply from before the latest compaction has a stale usage: it must not compact again.
		const compactionEntry = getLatestCompactionEntry(this.sessionManager.getBranch());
		if (this._isBeforeCompaction(assistantMessage, compactionEntry)) return false;

		// Cases 1 and 2: context overflow.
		if (sameModel && isContextOverflow(assistantMessage, contextWindow)) {
			const willRetry = assistantMessage.stopReason !== "stop";
			if (!willRetry) return this._runAutoCompaction("overflow", false);

			if (this._overflowRecoveryAttempted) {
				const errorMessage =
					"Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model.";
				this._emit({
					type: "compaction_end",
					reason: "overflow",
					result: undefined,
					aborted: false,
					willRetry: false,
					errorMessage,
				});
				return false;
			}
			this._overflowRecoveryAttempted = true;
			this._omitRecoveryAttempt(assistantMessage, toolResults);
			return this._runAutoCompaction("overflow", willRetry);
		}

		// Case 3: threshold. After a context edit the reply's usage no longer matches the context, and an
		// error or zero usage gives no number: estimate the context then. Else use the reply's usage.
		const projection = this.sessionManager.buildSessionProjection();
		let contextTokens = calculateContextTokens(assistantMessage.usage);
		const hasContextEdit = projection.entries.some((entry) => entry.sourceEntry.type === "context_edit");
		if (hasContextEdit || assistantMessage.stopReason === "error" || contextTokens === 0) {
			contextTokens = estimateProjectedContextTokens(projection, this.sessionManager.getBranch()).tokens;
		}
		if (shouldCompact(contextTokens, contextWindow, settings)) return this._runAutoCompaction("threshold", false);
		return false;
	}

	/**
	 * Whether a message was saved before the compaction entry. pi compares timestamps; edupi
	 * compares the entries' order, because with the fast faux provider both can fall in one millisecond.
	 */
	private _isBeforeCompaction(message: AgentMessage, compactionEntry: CompactionEntry | null): boolean {
		if (!compactionEntry) return false;
		const branch = this.sessionManager.getBranch();
		const entryId = this._entryIdsByMessage.get(message); // every message of the context has one
		return branch.findIndex((entry) => entry.id === entryId) < branch.indexOf(compactionEntry);
	}

	/** Threshold or overflow compaction. Returns whether the run should continue (the overflow retry). */
	private async _runAutoCompaction(reason: "overflow" | "threshold", willRetry: boolean): Promise<boolean> {
		let abortController: AbortController | undefined; // set once compaction_start is sent
		try {
			const preparation = prepareCompaction(
				this.sessionManager.getBranch(),
				this.settingsManager.getCompactionSettings(),
			);
			if (!preparation) return false; // nothing to summarise: no events at all

			abortController = new AbortController();
			this._autoCompactionAbortController = abortController;
			this._emit({ type: "compaction_start", reason });
			const compactResult = await this._runDefaultCompaction(
				preparation,
				this.model,
				undefined,
				abortController.signal,
				reason,
			);
			abortController.signal.throwIfAborted();

			const result = this._saveCompaction(compactResult, reason);
			this._emit({ type: "compaction_end", reason, result, aborted: false, willRetry });
			return willRetry;
		} catch (error) {
			if (abortController) {
				const message = error instanceof Error ? error.message : "compaction failed";
				const aborted = abortController.signal.aborted;
				const errorMessage = aborted
					? undefined
					: reason === "overflow"
						? `Context overflow recovery failed: ${message}`
						: `Auto-compaction failed: ${message}`;
				this._emit({ type: "compaction_end", reason, result: undefined, aborted, willRetry: false, errorMessage });
			}
			return false;
		} finally {
			this._autoCompactionAbortController = undefined;
			this._resolveIdleWaitIfIdle();
		}
	}

	get autoCompactionEnabled(): boolean {
		return this.settingsManager.getCompactionEnabled();
	}
}
