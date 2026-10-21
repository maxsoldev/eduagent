// Mirrors pi packages/coding-agent/src/core/agent-session.ts (pinned 16f5f0af4): the coding
// agent's session around the Agent. Every mode (pi's TUI, print, JSON, RPC) drives an
// AgentSession. It turns a prompt into a run, forwards the Agent's events with the session's
// own events added (agent_settled, queue_update), saves each finished message to the session
// file, and answers the state questions of get_state. While a run is active, new user text goes
// into the Agent's steering or follow-up queue; the session keeps the texts for queue_update.
import type { Agent } from "../../agent/agent.ts";
import type { AgentEvent, AgentMessage, QueueMode } from "../../agent/types.ts";
import type { ImageContent, Model, TextContent, ThinkingLevel } from "../../ai/types.ts";
import type { SessionManager } from "./session-manager.ts";

/** The Agent's events, with willRetry on agent_end, plus the session's own events. */
export type AgentSessionEvent =
  | Exclude<AgentEvent, { type: "agent_end" }>
  | { type: "agent_end"; messages: AgentMessage[]; willRetry: boolean }
  | { type: "agent_settled"; aborted: boolean }
  | { type: "queue_update"; steering: readonly string[]; followUp: readonly string[] };

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
}

export class AgentSession {
  readonly agent: Agent;
  readonly sessionManager: SessionManager;
  private readonly _getApiKey: (provider: string) => string | undefined;
  private _eventListeners: AgentSessionEventListener[] = [];
  private _isAgentRunActive = false; // from _startRun until agent_settled
  // The texts of the queued messages, for queue_update. The messages themselves are in the Agent.
  private _steeringMessages: string[] = [];
  private _followUpMessages: string[] = [];
  private _unsubscribeAgent: () => void;

  constructor(config: AgentSessionConfig) {
    this.agent = config.agent;
    this.sessionManager = config.sessionManager;
    this._getApiKey = config.getApiKey;
    this._unsubscribeAgent = this.agent.subscribe(this._handleAgentEvent);
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

  private _emitQueueUpdate(): void {
    this._emit({ type: "queue_update", steering: [...this._steeringMessages], followUp: [...this._followUpMessages] });
  }

  private _handleAgentEvent = async (event: AgentEvent): Promise<void> => {
    // A queued message that starts leaves its queue first, so a client sees the queue change before the message.
    if (event.type === "message_start" && event.message.role === "user") {
      const content = event.message.content;
      const messageText = typeof content === "string" ? content : content.filter((c): c is TextContent => c.type === "text").map((c) => c.text).join("");
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

  get steeringMode(): QueueMode {
    return this.agent.steeringMode; // pi's default "one-at-a-time" (settings-defaults.ts)
  }

  get followUpMode(): QueueMode {
    return this.agent.followUpMode;
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

  /** Steering plus follow-up messages that wait for the loop. */
  get pendingMessageCount(): number {
    return this._steeringMessages.length + this._followUpMessages.length;
  }

  get autoCompactionEnabled(): boolean {
    return false; // edupi does not compact yet; pi's default is true
  }

  /**
   * Sends a prompt. While a run is active it needs a streamingBehavior and is queued. Before a run
   * starts it checks the model's API key; after preflightResult("started"), failures are events.
   */
  async prompt(text: string, options?: PromptOptions): Promise<void> {
    if (this.isStreaming) {
      if (!options?.streamingBehavior) {
        throw new Error("Agent is already processing. Specify streamingBehavior ('steer' or 'followUp') to queue the message.");
      }
      if (options.streamingBehavior === "followUp") this._queueFollowUp(text, options.images);
      else this._queueSteer(text, options.images);
      options.preflightResult?.("queued");
      return;
    }
    if (!this._getApiKey(this.model.provider)) {
      throw new Error(`No API key found for ${this.model.provider}.\n\nSet OPENROUTER_API_KEY in the environment or in the repo-root .env file.`);
    }
    await this._startRun(text, options?.images ?? [], () => options?.preflightResult?.("started"));
  }

  /** Queues a steering message: it goes in after the current turn's tools, before the next model call. */
  async steer(text: string, images?: ImageContent[]): Promise<PromptDisposition> {
    this._queueSteer(text, images);
    return "queued";
  }

  /** Queues a follow-up message: it runs when the agent has no more tool calls or steering messages. */
  async followUp(text: string, images?: ImageContent[]): Promise<PromptDisposition> {
    this._queueFollowUp(text, images);
    return "queued";
  }

  private _queueSteer(text: string, images?: ImageContent[]): void {
    this._steeringMessages.push(text);
    this._emitQueueUpdate();
    this.agent.steer({ role: "user", content: [{ type: "text", text }, ...(images ?? [])], timestamp: Date.now() });
  }

  private _queueFollowUp(text: string, images?: ImageContent[]): void {
    this._followUpMessages.push(text);
    this._emitQueueUpdate();
    this.agent.followUp({ role: "user", content: [{ type: "text", text }, ...(images ?? [])], timestamp: Date.now() });
  }

  /** One run: the user message, then the Agent's loop, then agent_settled. */
  private async _startRun(text: string, images: ImageContent[], onStarted?: () => void): Promise<void> {
    this._isAgentRunActive = true;
    const messages: AgentMessage[] = [{ role: "user", content: [{ type: "text", text }, ...images], timestamp: Date.now() }];
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
