// Mirrors pi packages/coding-agent/src/core/agent-session.ts (pinned 16f5f0af4): the coding
// agent's session around the Agent. Every mode (pi's TUI, print, JSON, RPC) drives an
// AgentSession. It turns a prompt into a run, forwards the Agent's events with the session's
// own events added (agent_settled), saves each finished message to the session file, and
// answers the state questions of get_state. Before each run it builds the system prompt from the
// resource loader's files and puts the changed sections into the transcript.
import { readFileSync } from "node:fs";
import type { Agent } from "../../agent/agent.ts";
import type { AgentEvent, AgentMessage } from "../../agent/types.ts";
import type { ImageContent, Model, SystemMessage, ThinkingLevel } from "../../ai/types.ts";
import { getCurrentSystemMessage } from "../../ai/utils/transcript.ts";
import { stripFrontmatter } from "../utils/frontmatter.ts";
import type { Probe } from "./probe.ts";
import type { DefaultResourceLoader } from "./resource-loader.ts";
import type { SessionManager } from "./session-manager.ts";
import { type BuildSystemPromptOptions, buildSystemPromptSections, diffSystemPromptSections } from "./system-prompt.ts";
import { toolSystemPromptContributions } from "./tools/index.ts";

/** The Agent's events, with willRetry on agent_end, plus the session's own events. */
export type AgentSessionEvent =
  | Exclude<AgentEvent, { type: "agent_end" }>
  | { type: "agent_end"; messages: AgentMessage[]; willRetry: boolean }
  | { type: "agent_settled"; aborted: boolean };

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
  /** The key for a provider, or undefined if none is configured. */
  getApiKey: (provider: string) => string | undefined;
  /** The loaded AGENTS.md files, skills and SYSTEM.md files. */
  resourceLoader: DefaultResourceLoader;
  /** edupi: the teaching extras' hooks. */
  probe?: Probe;
}

export class AgentSession {
  readonly agent: Agent;
  readonly sessionManager: SessionManager;
  private readonly _getApiKey: (provider: string) => string | undefined;
  private _eventListeners: AgentSessionEventListener[] = [];
  private _isAgentRunActive = false; // from _startRun until agent_settled
  private _unsubscribeAgent: () => void;
  readonly resourceLoader: DefaultResourceLoader;
  private readonly _probe: Probe | undefined;
  private _baseSystemPromptOptions!: BuildSystemPromptOptions;
  private _skillsReported = false;

  constructor(config: AgentSessionConfig) {
    this.agent = config.agent;
    this.sessionManager = config.sessionManager;
    this._getApiKey = config.getApiKey;
    this.resourceLoader = config.resourceLoader;
    this._probe = config.probe;
    this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
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
    this._emit(event.type === "agent_end" ? { ...event, willRetry: false } : event); // edupi has no auto-retry

    // Each finished message becomes a "message" entry, child of the last entry.
    if (event.type === "message_end") {
      const role = event.message.role;
      if (role === "system" || role === "user" || role === "assistant" || role === "toolResult") {
        this.sessionManager.appendMessage(event.message);
      }
    }
  };

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
    return false; // edupi does not compact yet
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
    return false; // edupi does not compact yet; pi's default is true
  }

  /**
   * Sends a prompt. While a run is active it needs a streamingBehavior. Before the run starts it
   * checks the model's API key; after preflightResult("started"), failures arrive as events.
   */
  async prompt(text: string, options?: PromptOptions): Promise<void> {
    text = this._expandSkillCommand(text); // pi expands /skill:name and prompt templates first
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

  /**
   * The run's starting messages: a system message with the changed prompt sections (on the first
   * run: all of them), then the user message. The agent loop adds the tool declarations to it.
   */
  private _prepareRun(text: string, images: ImageContent[]): AgentMessage[] {
    const messages: AgentMessage[] = [{ role: "user", content: [{ type: "text", text }, ...images], timestamp: Date.now() }];
    const update = this._preparePromptAndToolLoadout(this._baseSystemPromptOptions);
    if (update) messages.unshift(update);
    return messages;
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

  /** One run: the system prompt update and the user message, then the Agent's loop, then agent_settled. */
  private async _startRun(text: string, images: ImageContent[], onStarted?: () => void): Promise<void> {
    this._isAgentRunActive = true;
    const messages = this._prepareRun(text, images);
    onStarted?.();
    try {
      await this.agent.prompt(messages);
    } finally {
      this._emitAgentSettled();
    }
  }

  private _emitAgentSettled(): void {
    this._isAgentRunActive = false;
    this._emit({ type: "agent_settled", aborted: false });
  }
}
