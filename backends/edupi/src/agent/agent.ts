// Mirrors pi packages/agent/src/agent.ts (pinned 16f5f0af4): the stateful Agent around the loop.
// It owns the transcript, runs one prompt at a time, keeps its state up to date from the loop's
// events, then passes each event to its listeners and awaits them in order.
import type { ImageContent, Message, Model, TextContent } from "../ai/types.ts";
import { runAgentLoop, runAgentLoopContinue } from "./agent-loop.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, AgentState, StreamFn, ThinkingLevel } from "./types.ts";

function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
  return messages.filter((m) => m.role === "system" || m.role === "user" || m.role === "assistant" || m.role === "toolResult");
}

const EMPTY_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

export interface AgentOptions {
  initialState: { model: Model; thinkingLevel?: ThinkingLevel; messages?: AgentMessage[] };
  convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  streamFn: StreamFn;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  sessionId?: string;
}

type ActiveRun = { promise: Promise<void>; resolve: () => void; abortController: AbortController };

type MutableAgentState = { -readonly [K in keyof AgentState]: AgentState[K] };

export class Agent {
  private _state: MutableAgentState;
  private readonly listeners = new Set<(event: AgentEvent, signal: AbortSignal) => Promise<void> | void>();
  private activeRun?: ActiveRun;

  public convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  public streamFunction: StreamFn;
  public getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  /** Session id, forwarded to the provider (OpenRouter session affinity). */
  public sessionId?: string;

  constructor(options: AgentOptions) {
    this._state = {
      model: options.initialState.model,
      thinkingLevel: options.initialState.thinkingLevel ?? "off",
      messages: options.initialState.messages?.slice() ?? [],
      isStreaming: false,
      streamingMessage: undefined,
      errorMessage: undefined,
    };
    this.convertToLlm = options.convertToLlm ?? defaultConvertToLlm;
    this.streamFunction = options.streamFn;
    this.getApiKey = options.getApiKey;
    this.sessionId = options.sessionId;
  }

  /** Listeners are awaited in order; the run is idle only after the agent_end listeners finish. */
  subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get state(): AgentState {
    return this._state;
  }

  /** Resolves when the current run and its listeners have finished. */
  waitForIdle(): Promise<void> {
    return this.activeRun?.promise ?? Promise.resolve();
  }

  /** Starts a run from text or ready-made messages. Only one run at a time. */
  async prompt(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): Promise<void> {
    if (this.activeRun) {
      throw new Error("Agent is already processing a prompt. Use steer() or followUp() to queue messages, or wait for completion.");
    }
    await this.runPromptMessages(this.normalizePromptInput(input, images));
  }

  /**
   * Runs the loop again from the current messages, without a new prompt (after an overflow, the
   * session compacts and continues). pi also drains the steering and follow-up queues here.
   */
  async continue(): Promise<void> {
    if (this.activeRun) throw new Error("Agent is already processing. Wait for completion before continuing.");
    const lastMessage = this._state.messages[this._state.messages.length - 1];
    if (!lastMessage || this._state.messages.every((message) => message.role === "system")) {
      throw new Error("No messages to continue from");
    }
    if (lastMessage.role === "assistant") throw new Error("Cannot continue from message role: assistant");
    await this.runWithLifecycle(async (signal) => {
      await runAgentLoopContinue(this.createContextSnapshot(), this.createLoopConfig(),
        (event) => this.processEvents(event), signal, this.streamFunction);
    });
  }

  private normalizePromptInput(input: string | AgentMessage | AgentMessage[], images?: ImageContent[]): AgentMessage[] {
    if (Array.isArray(input)) return input;
    if (typeof input !== "string") return [input];
    const content: (TextContent | ImageContent)[] = [{ type: "text", text: input }, ...(images ?? [])];
    return [{ role: "user", content, timestamp: Date.now() }];
  }

  private async runPromptMessages(messages: AgentMessage[]): Promise<void> {
    await this.runWithLifecycle(async (signal) => {
      await runAgentLoop(messages, this.createContextSnapshot(), this.createLoopConfig(),
        (event) => this.processEvents(event), signal, this.streamFunction);
    });
  }

  private createContextSnapshot(): AgentContext {
    return { messages: this._state.messages.slice() };
  }

  private createLoopConfig(): AgentLoopConfig {
    return {
      model: this._state.model,
      reasoning: this._state.thinkingLevel === "off" ? undefined : this._state.thinkingLevel,
      sessionId: this.sessionId,
      convertToLlm: this.convertToLlm,
      getApiKey: this.getApiKey,
    };
  }

  private async runWithLifecycle(executor: (signal: AbortSignal) => Promise<void>): Promise<void> {
    if (this.activeRun) throw new Error("Agent is already processing.");
    const abortController = new AbortController();
    let resolvePromise = () => {};
    const promise = new Promise<void>((resolve) => {
      resolvePromise = resolve;
    });
    this.activeRun = { promise, resolve: resolvePromise, abortController };
    this._state.isStreaming = true;
    this._state.streamingMessage = undefined;
    this._state.errorMessage = undefined;

    try {
      await executor(abortController.signal);
    } catch (error) {
      await this.handleRunFailure(error, abortController.signal.aborted);
    } finally {
      this.finishRun();
    }
  }

  /** A run that throws still ends with pi's events: a failed assistant message, turn_end, agent_end. */
  private async handleRunFailure(error: unknown, aborted: boolean): Promise<void> {
    const failureMessage: AgentMessage = {
      role: "assistant",
      content: [{ type: "text", text: "" }],
      api: this._state.model.api,
      provider: this._state.model.provider,
      model: this._state.model.id,
      usage: EMPTY_USAGE,
      stopReason: aborted ? "aborted" : "error",
      errorMessage: error instanceof Error ? error.message : String(error),
      timestamp: Date.now(),
    };
    await this.processEvents({ type: "message_start", message: failureMessage });
    await this.processEvents({ type: "message_end", message: failureMessage });
    await this.processEvents({ type: "turn_end", message: failureMessage, toolResults: [] });
    await this.processEvents({ type: "agent_end", messages: [failureMessage] });
  }

  private finishRun(): void {
    this._state.isStreaming = false;
    this._state.streamingMessage = undefined;
    this.activeRun?.resolve();
    this.activeRun = undefined;
  }

  /** Updates the state for one loop event, then awaits the listeners. */
  private async processEvents(event: AgentEvent): Promise<void> {
    switch (event.type) {
      case "message_start":
      case "message_update":
        this._state.streamingMessage = event.message;
        break;
      case "message_end":
        this._state.streamingMessage = undefined;
        this._state.messages.push(event.message);
        break;
      case "turn_end":
        if (event.message.role === "assistant" && event.message.errorMessage) this._state.errorMessage = event.message.errorMessage;
        break;
      case "agent_end":
        this._state.streamingMessage = undefined;
        break;
    }

    const signal = this.activeRun?.abortController.signal;
    if (!signal) throw new Error("Agent listener invoked outside active run");
    for (const listener of this.listeners) await listener(event, signal);
  }
}
