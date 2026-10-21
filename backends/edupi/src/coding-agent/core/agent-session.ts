// Mirrors pi packages/coding-agent/src/core/agent-session.ts (pinned 16f5f0af4): the coding
// agent's session around the Agent. Every mode (pi's TUI, print, JSON, RPC) drives an
// AgentSession. It turns a prompt into a run, forwards the Agent's events with the session's
// own events added (agent_settled, compaction_start/end), saves each finished message to the
// session file, compacts the context (by hand, at the threshold, after an overflow), and
// answers the state questions of get_state. Before each run it builds the system prompt from the
// resource loader's files and puts the changed sections into the transcript.
import { readFileSync } from "node:fs";
import type { Agent } from "../../agent/agent.ts";
import type { AgentContext, AgentEvent, AgentMessage } from "../../agent/types.ts";
import type { AssistantMessage, ImageContent, Model, SystemMessage, ThinkingLevel, ToolResultMessage } from "../../ai/types.ts";
import { isContextOverflow, isRecoverableLength } from "../../ai/utils/overflow.ts";
import { getCurrentSystemMessage } from "../../ai/utils/transcript.ts";
import { stripFrontmatter } from "../utils/frontmatter.ts";
import {
  type CompactionPreparation,
  type CompactionResult,
  calculateContextTokens,
  compact,
  estimateContextTokens,
  estimateProjectedContextTokens,
  estimateTokens,
  prepareCompaction,
  shouldCompact,
} from "./compaction/compaction.ts";
import type { Probe } from "./probe.ts";
import type { DefaultResourceLoader } from "./resource-loader.ts";
import { type CompactionEntry, getLatestCompactionEntry, type SessionEntry, type SessionManager, type SessionProjection } from "./session-manager.ts";
import type { SettingsManager } from "./settings-manager.ts";
import { type BuildSystemPromptOptions, buildSystemPromptSections, diffSystemPromptSections } from "./system-prompt.ts";
import { toolSystemPromptContributions } from "./tools/index.ts";

export type CompactionReason = "manual" | "threshold" | "overflow";

/** The Agent's events, with willRetry on agent_end, plus the session's own events. */
export type AgentSessionEvent =
  | Exclude<AgentEvent, { type: "agent_end" }>
  | { type: "agent_end"; messages: AgentMessage[]; willRetry: boolean }
  | { type: "agent_settled"; aborted: boolean }
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

export type PromptDisposition = "handled" | "queued" | "started";

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
  /** The loaded AGENTS.md files, skills and SYSTEM.md files. */
  resourceLoader: DefaultResourceLoader;
  /** edupi's teaching hooks (prompt, skills, compaction); pi has none. */
  probe?: Probe;
}

function estimateMessagesTokens(messages: AgentMessage[]): number {
  let tokens = 0;
  for (const message of messages) tokens += estimateTokens(message);
  return tokens;
}

export class AgentSession {
  readonly agent: Agent;
  readonly sessionManager: SessionManager;
  readonly settingsManager: SettingsManager;
  private readonly _getApiKey: (provider: string) => string | undefined;
  private readonly _probe: Probe | undefined;
  private _eventListeners: AgentSessionEventListener[] = [];
  private _isAgentRunActive = false; // from _startRun until agent_settled
  private _unsubscribeAgent: () => void;
  readonly resourceLoader: DefaultResourceLoader;
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
    this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
    this.agent.prepareNextTurn = ({ context }) => this._compactBeforeNextAssistantResponse(context);
    this._refreshFinalizedContext(); // records the entry of each restored message
    this._rebuildSystemPrompt(this.agent.state.tools.map((tool) => tool.name));
  }

  /** Gathers the prompt's inputs: cwd, skills, AGENTS.md files, SYSTEM.md, APPEND_SYSTEM.md, tool snippets and guidelines. */
  private _rebuildSystemPrompt(toolNames: string[]): void {
    const toolSnippets: Record<string, string> = {};
    const toolGuidelines: Record<string, string[]> = {};
    for (const name of toolNames) {
      const contribution = toolSystemPromptContributions[name];
      if (!contribution) continue; // tools without a snippet are not listed
      toolSnippets[name] = contribution.snippet;
      toolGuidelines[name] = [...contribution.guidelines];
    }
    const append = this.resourceLoader.getAppendSystemPrompt();
    this._baseSystemPromptOptions = {
      cwd: this.resourceLoader.cwd,
      skills: this.resourceLoader.getSkills().skills,
      contextFiles: this.resourceLoader.getAgentsFiles().agentsFiles,
      customPrompt: this.resourceLoader.getSystemPrompt(),
      appendSystemPrompt: append.length > 0 ? append.join("\n\n") : "",
      selectedTools: toolNames,
      toolSnippets,
      toolGuidelines,
    };
  }

  /** Stops listening to the Agent and drops the listeners (the session is being replaced). */
  dispose(): void {
    this._unsubscribeAgent();
    this._eventListeners = [];
  }

  subscribe(listener: AgentSessionEventListener): () => void {
    this._eventListeners.push(listener);
    return () => {
      this._eventListeners = this._eventListeners.filter((l) => l !== listener);
    };
  }

  private _emit(event: AgentSessionEvent): void {
    for (const listener of this._eventListeners) listener(event);
  }

  private _handleAgentEvent = async (event: AgentEvent): Promise<void> => {
    // A new user message allows a new overflow recovery.
    if (event.type === "message_start" && event.message.role === "user") this._overflowRecoveryAttempted = false;

    this._emit(event.type === "agent_end" ? { ...event, willRetry: false } : event); // edupi has no auto-retry

    // Each finished message becomes a "message" entry, child of the last entry.
    if (event.type === "message_end") {
      const role = event.message.role;
      if (role === "system" || role === "user" || role === "assistant" || role === "toolResult") {
        this._entryIdsByMessage.set(event.message, this.sessionManager.appendMessage(event.message));
      }
      if (event.message.role === "assistant") {
        this._lastAssistantMessage = event.message;
        if (event.message.stopReason !== "error" && event.message.stopReason !== "length") this._overflowRecoveryAttempted = false;
      }
    }
    if (event.type === "turn_end") this._lastAssistantToolResults = event.toolResults;
  };

  /** Whether the context, as the session file gives it, is above the model's compaction threshold. */
  private _exceedsCompactionThreshold(model: Model, projection: SessionProjection): boolean {
    if (model.contextWindow <= 0) return false;
    return shouldCompact(estimateProjectedContextTokens(projection, this.sessionManager.getBranch()).tokens,
      model.contextWindow, this.settingsManager.getCompactionSettings());
  }

  /**
   * Before each later model call of a run (after tool results): compact if the context is above
   * the threshold. The next turn then starts from the context rebuilt from the session file.
   */
  private async _compactBeforeNextAssistantResponse(context: AgentContext): Promise<{ context: AgentContext }> {
    const projection = this.sessionManager.buildSessionProjection();
    if (!this._exceedsCompactionThreshold(this.model, projection)) return { context: { ...context, messages: projection.messages } };
    await this._runAutoCompaction("threshold", false);
    return { context: { ...context, messages: this.sessionManager.buildSessionProjection().messages } };
  }

  /** After compaction or an omission, the Agent's messages are rebuilt from the session file. */
  private _refreshFinalizedContext(): void {
    const projection = this.sessionManager.buildSessionProjection();
    for (const entry of projection.entries) {
      for (const message of entry.messages) this._entryIdsByMessage.set(message, entry.sourceEntry.id);
    }
    this.agent.state.messages = projection.messages;
  }

  get model(): Model {
    return this.agent.state.model;
  }

  get thinkingLevel(): ThinkingLevel {
    return this.agent.state.thinkingLevel;
  }

  get isStreaming(): boolean {
    return this._isAgentRunActive;
  }

  get isCompacting(): boolean {
    return this._compactionAbortController !== undefined || this._autoCompactionAbortController !== undefined;
  }

  get steeringMode(): "all" | "one-at-a-time" {
    return "one-at-a-time"; // pi's default (settings-defaults.ts)
  }

  get followUpMode(): "all" | "one-at-a-time" {
    return "one-at-a-time";
  }

  /** The session file, or undefined with --no-session. It exists once the first message is saved. */
  get sessionFile(): string | undefined {
    return this.sessionManager.getSessionFile();
  }

  get sessionId(): string {
    return this.sessionManager.getSessionId();
  }

  get messages(): AgentMessage[] {
    return this.agent.state.messages;
  }

  get pendingMessageCount(): number {
    return 0; // no steering or follow-up queues yet
  }

  get autoCompactionEnabled(): boolean {
    return this.settingsManager.getCompactionEnabled();
  }

  /**
   * Sends a prompt. While a run is active it needs a streamingBehavior. Before the run starts it
   * checks the model's API key; after preflightResult("started"), failures arrive as events.
   */
  async prompt(text: string, options?: PromptOptions): Promise<void> {
    text = this._expandSkillCommand(text); // pi expands /skill:name and prompt templates first
    if (this.isCompacting) {
      throw new Error("Cannot submit a prompt while compaction is in progress. Wait for compaction to finish and retry.");
    }
    if (this.isStreaming) {
      throw new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
    }
    if (!this._getApiKey(this.model.provider)) {
      throw new Error(`No API key found for ${this.model.provider}.\n\nSet OPENROUTER_API_KEY in the environment or in the repo-root .env file.`);
    }
    await this._startRun(text, options?.images ?? [], () => options?.preflightResult?.("started"));
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
    try {
      const body = stripFrontmatter(readFileSync(skill.filePath, "utf-8")).trim();
      const skillBlock = `<skill name="${skill.name}" location="${skill.filePath}">\nReferences are relative to ${skill.baseDir}.\n\n${body}\n</skill>`;
      return args ? `${skillBlock}\n\n${args}` : skillBlock;
    } catch {
      return text; // pi reports the read error to extensions and sends the text as typed
    }
  }

  /** Diffs the sections the model has (replayed from the transcript) with the wanted ones. */
  private _preparePromptAndToolLoadout(options: BuildSystemPromptOptions): SystemMessage | undefined {
    const sections = buildSystemPromptSections(options);
    const previous = getCurrentSystemMessage(this.agent.state.messages)?.sections;
    const patch = diffSystemPromptSections(previous ?? {}, sections);
    this._reportPrompt(sections, patch, previous === undefined);
    return patch ? { role: "system", content: "", sections: patch, timestamp: Date.now() } : undefined;
  }

  /** edupi: tells the probe what went into the prompt. pi loads skills at startup; the trace reports them with the first run. */
  private _reportPrompt(sections: Record<string, string>, patch: Record<string, string | null> | undefined, firstTurn: boolean): void {
    if (!this._probe) return;
    const loader = this.resourceLoader;
    if (!this._skillsReported) {
      this._skillsReported = true;
      const { skills, diagnostics } = loader.getSkills();
      this._probe.skillsLoaded?.({ roots: loader.getSkillRoots(), skills, diagnostics, projectTrusted: loader.projectTrusted });
    }
    this._probe.promptAssembled?.({
      sections, patch, firstTurn,
      contextFiles: loader.getAgentsFiles().agentsFiles.map((file) => file.path),
      customPromptFiles: loader.getPromptFiles(),
    });
  }

  /**
   * One run: compact first if needed, the system prompt update and the user message, the Agent's
   * loop, then the post-run check (compact; after an overflow, compact and continue), then agent_settled.
   */
  private async _startRun(text: string, images: ImageContent[], onStarted?: () => void): Promise<void> {
    this._isAgentRunActive = true;
    let messages: AgentMessage[];
    try {
      messages = await this._prepareRun(text, images);
    } catch (error) {
      this._isAgentRunActive = false;
      throw error;
    }
    onStarted?.();
    try {
      await this.agent.prompt(messages);
      while (await this._handlePostAgentRun()) await this.agent.continue();
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
    const messages: AgentMessage[] = [{ role: "user", content: [{ type: "text", text }, ...images], timestamp: Date.now() }];
    const update = this._preparePromptAndToolLoadout(this._baseSystemPromptOptions);
    if (update) messages.unshift(update);
    return messages;
  }

  /** After the loop: should it continue? Only after an overflow recovery (pi also: queued messages, retries). */
  private async _handlePostAgentRun(): Promise<boolean> {
    const message = this._lastAssistantMessage;
    const toolResults = this._lastAssistantToolResults;
    this._lastAssistantMessage = undefined;
    this._lastAssistantToolResults = [];
    if (!message) return false;
    return this._checkCompaction(message, true, toolResults);
  }

  private _findLastAssistantMessage(): AssistantMessage | undefined {
    const messages = this.agent.state.messages;
    for (let i = messages.length - 1; i >= 0; i--) {
      const msg = messages[i];
      if (msg.role === "assistant") return msg;
    }
    return undefined;
  }

  private _emitAgentSettled(): void {
    this._isAgentRunActive = false;
    this._emit({ type: "agent_settled", aborted: false });
  }

  // =========================================================================
  // Compaction
  // =========================================================================

  /** pi's built-in summary, for every reason. edupi's probe sees each summary request body. */
  private async _runDefaultCompaction(preparation: CompactionPreparation, model: Model,
    customInstructions: string | undefined, signal: AbortSignal, reason: CompactionReason): Promise<CompactionResult> {
    const onPayload = (body: unknown) => {
      void this._probe?.compactionRequest?.({ reason, tokensBefore: preparation.tokensBefore, body });
      return undefined;
    };
    return compact(preparation, model, this._getApiKey(model.provider), this.agent.streamFunction, customInstructions, signal,
      this.agent.state.thinkingLevel, onPayload);
  }

  /** Saves the summary as a compaction entry and rebuilds the Agent's messages from it. */
  private _saveCompaction(compacted: CompactionResult, reason: CompactionReason): CompactionResult {
    const { summary, firstKeptEntryId, tokensBefore, usage, details } = compacted;
    this.sessionManager.appendCompaction(summary, firstKeptEntryId, tokensBefore, details, undefined, usage);
    this._refreshFinalizedContext();
    const estimatedTokensAfter = estimateMessagesTokens(this.sessionManager.buildSessionProjection().messages);
    const result = { summary, firstKeptEntryId, tokensBefore, estimatedTokensAfter, usage, details };
    void this._probe?.compacted?.({ reason, ...result, messages: this.agent.state.messages });
    return result;
  }

  /**
   * Manual compaction (RPC `compact`, pi's /compact). Never retries. pi aborts a running turn
   * first; edupi has no abort yet, so it refuses while a run is active.
   */
  async compact(customInstructions?: string): Promise<CompactionResult> {
    if (this.isStreaming) throw new Error("Cannot compact while the agent is running. edupi has no abort yet; wait for the run to end.");
    this._compactionAbortController = new AbortController();
    this._emit({ type: "compaction_start", reason: "manual" });
    try {
      const model = this.model;
      const pathEntries = this.sessionManager.getBranch();
      const preparation = prepareCompaction(pathEntries, this.settingsManager.getCompactionSettings());
      if (!preparation) {
        const lastEntry = pathEntries[pathEntries.length - 1];
        if (lastEntry?.type === "compaction") throw new Error("Already compacted");
        throw new Error("Nothing to compact (session too small)");
      }
      const result = await this._runDefaultCompaction(preparation, model, customInstructions, this._compactionAbortController.signal, "manual");
      if (this._compactionAbortController.signal.aborted) throw new Error("Compaction cancelled");
      const compactionResult = this._saveCompaction(result, "manual");
      this._compactionAbortController = undefined;
      this._emit({ type: "compaction_end", reason: "manual", result: compactionResult, aborted: false, willRetry: false });
      return compactionResult;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const aborted = this._compactionAbortController?.signal.aborted ?? false;
      this._compactionAbortController = undefined;
      this._emit({ type: "compaction_end", reason: "manual", result: undefined, aborted, willRetry: false,
        errorMessage: aborted ? undefined : `Compaction failed: ${message}` });
      throw error;
    } finally {
      this._compactionAbortController = undefined;
    }
  }

  /**
   * The automatic cases, checked before a prompt and after each run:
   * 1. Overflow with retry: the provider refused the context (or a length stop came early).
   *    Drop the failed reply from the context, compact, and continue the run once.
   * 2. Overflow without retry: the reply succeeded but its input exceeded the window. Compact.
   * 3. Threshold: the context is above contextWindow - reserveTokens. Compact, no retry.
   * Returns whether the run should continue.
   */
  private async _checkCompaction(assistantMessage: AssistantMessage, skipAbortedCheck = true,
    toolResults: AgentMessage[] = []): Promise<boolean> {
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
    const contextOverflow = sameModel && isContextOverflow(assistantMessage, contextWindow);
    const recoverableLength = sameModel && isRecoverableLength(assistantMessage, model.maxTokens);
    if (contextOverflow || recoverableLength) {
      const willRetry = assistantMessage.stopReason !== "stop";
      if (!willRetry) return this._runAutoCompaction("overflow", false);

      if (this._overflowRecoveryAttempted) {
        const errorMessage = contextOverflow
          ? "Context overflow recovery failed after one compact-and-retry attempt. Try reducing context or switching to a larger-context model."
          : "Truncated response recovery failed after one compact-and-retry attempt.";
        this._emit({ type: "compaction_end", reason: "overflow", result: undefined, aborted: false, willRetry: false, errorMessage });
        return false;
      }
      this._overflowRecoveryAttempted = true;
      this._omitRecoveryAttempt(assistantMessage, toolResults);
      return this._runAutoCompaction("overflow", willRetry);
    }

    // Case 3: threshold. Without a usable usage (an error, or zero), estimate the context instead.
    let contextTokens: number;
    const projection = this.sessionManager.buildSessionProjection();
    const directContextTokens = calculateContextTokens(assistantMessage.usage);
    if (projection.entries.some((entry) => entry.sourceEntry.type === "context_edit")) {
      contextTokens = estimateProjectedContextTokens(projection, this.sessionManager.getBranch()).tokens;
    } else if (assistantMessage.stopReason === "error" || directContextTokens === 0) {
      const messages = this.agent.state.messages;
      const estimate = estimateContextTokens(messages);
      if (estimate.lastUsageIndex !== null && this._isBeforeCompaction(messages[estimate.lastUsageIndex], compactionEntry)) return false;
      contextTokens = estimate.tokens;
    } else {
      contextTokens = directContextTokens;
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
    const entryId = this._entryIdsByMessage.get(message);
    const messageIndex = entryId ? branch.findIndex((entry) => entry.id === entryId) : -1;
    if (messageIndex < 0) return message.timestamp <= new Date(compactionEntry.timestamp).getTime();
    return messageIndex < branch.indexOf(compactionEntry);
  }

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

  /** Threshold or overflow compaction. Returns whether the run should continue (the overflow retry). */
  private async _runAutoCompaction(reason: "overflow" | "threshold", willRetry: boolean): Promise<boolean> {
    let abortController: AbortController | undefined;
    try {
      const preparation = prepareCompaction(this.sessionManager.getBranch(), this.settingsManager.getCompactionSettings());
      if (!preparation) return false; // nothing to summarise: no events at all

      abortController = new AbortController();
      this._autoCompactionAbortController = abortController;
      this._emit({ type: "compaction_start", reason });
      const compactResult = await this._runDefaultCompaction(preparation, this.model, undefined, abortController.signal, reason);
      abortController.signal.throwIfAborted();
      const result = this._saveCompaction(compactResult, reason);
      this._emit({ type: "compaction_end", reason, result, aborted: false, willRetry });
      return willRetry;
    } catch (error) {
      if (abortController) {
        const message = error instanceof Error ? error.message : "compaction failed";
        const aborted = abortController.signal.aborted;
        const errorMessage = aborted ? undefined
          : reason === "overflow" ? `Context overflow recovery failed: ${message}` : `Auto-compaction failed: ${message}`;
        this._emit({ type: "compaction_end", reason, result: undefined, aborted, willRetry: false, errorMessage });
      }
      return false;
    } finally {
      if (this._autoCompactionAbortController === abortController) this._autoCompactionAbortController = undefined;
    }
  }
}
