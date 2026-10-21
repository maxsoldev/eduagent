// Mirrors pi packages/agent/src/agent.ts (pinned 16f5f0af4): the stateful Agent around the loop.
// It owns the transcript, runs one prompt at a time, keeps its state up to date from the loop's
// events, then passes each event to its listeners and awaits them in order. It also holds the
// steering and follow-up queues that the loop drains while a run is active.
import type { ImageContent, Message, Model, TextContent } from "../ai/types.ts";
import { runAgentLoop } from "./agent-loop.ts";
import type {
  AgentContext,
  AgentEvent,
  AgentLoopConfig,
  AgentMessage,
  AgentProbe,
  AgentState,
  AgentTool,
  QueueMode,
  StreamFn,
  ThinkingLevel,
  ToolExecutionMode,
} from "./types.ts";

function defaultConvertToLlm(messages: AgentMessage[]): Message[] {
  return messages.filter((m) => m.role === "system" || m.role === "user" || m.role === "assistant" || m.role === "toolResult");
}

const EMPTY_USAGE = { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };

export interface AgentOptions {
  initialState: { model: Model; thinkingLevel?: ThinkingLevel; tools?: AgentTool<any>[]; messages?: AgentMessage[] };
  convertToLlm?: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  streamFn: StreamFn;
  getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  sessionId?: string;
  /** Default "parallel", as in pi. */
  toolExecution?: ToolExecutionMode;
  steeringMode?: QueueMode;
  followUpMode?: QueueMode;
  probe?: AgentProbe; // edupi: the teaching extras' hooks
}

/** Messages waiting for the loop. drain() takes one ("one-at-a-time") or all of them. */
class PendingMessageQueue {
  private messages: AgentMessage[] = [];
  constructor(public mode: QueueMode) {}

  enqueue(message: AgentMessage): void {
    this.messages.push(message);
  }

  hasItems(): boolean {
    return this.messages.length > 0;
  }

  peek(): AgentMessage[] {
    if (this.mode === "all") return this.messages.slice();
    const first = this.messages[0];
    return first ? [first] : [];
  }

  drain(): AgentMessage[] {
    const drained = this.peek();
    this.messages = this.messages.slice(drained.length);
    return drained;
  }

  clear(): void {
    this.messages = [];
  }
}

type ActiveRun = { promise: Promise<void>; resolve: () => void; abortController: AbortController };

type MutableAgentState = { -readonly [K in keyof AgentState]: AgentState[K] } & { pendingToolCalls: Set<string> };

export class Agent {
  private _state: MutableAgentState;
  private readonly listeners = new Set<(event: AgentEvent, signal: AbortSignal) => Promise<void> | void>();
  private activeRun?: ActiveRun;
  private readonly steeringQueue: PendingMessageQueue;
  private readonly followUpQueue: PendingMessageQueue;

  public convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
  public streamFunction: StreamFn;
  public getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
  /** Session id, forwarded to the provider (OpenRouter session affinity). */
  public sessionId?: string;
  public toolExecution: ToolExecutionMode;
  public probe?: AgentProbe;

  constructor(options: AgentOptions) {
    this._state = {
      model: options.initialState.model,
      thinkingLevel: options.initialState.thinkingLevel ?? "off",
      tools: options.initialState.tools?.slice() ?? [],
      messages: options.initialState.messages?.slice() ?? [],
      isStreaming: false,
      streamingMessage: undefined,
      pendingToolCalls: new Set<string>(),
      errorMessage: undefined,
    };
    this.convertToLlm = options.convertToLlm ?? defaultConvertToLlm;
    this.streamFunction = options.streamFn;
    this.getApiKey = options.getApiKey;
    this.sessionId = options.sessionId;
    this.toolExecution = options.toolExecution ?? "parallel";
    this.steeringQueue = new PendingMessageQueue(options.steeringMode ?? "one-at-a-time");
    this.followUpQueue = new PendingMessageQueue(options.followUpMode ?? "one-at-a-time");
    this.probe = options.probe;
  }

  /** Listeners are awaited in order; the run is idle only after the agent_end listeners finish. */
  subscribe(listener: (event: AgentEvent, signal: AbortSignal) => Promise<void> | void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  get state(): AgentState {
    return this._state;
  }

  get steeringMode(): QueueMode {
    return this.steeringQueue.mode;
  }

  get followUpMode(): QueueMode {
    return this.followUpQueue.mode;
  }

  /** Queues a message to go in after the current turn's tools, before the next model call. */
  steer(message: AgentMessage): void {
    this.steeringQueue.enqueue(message);
  }

  /** Queues a message to run only when the agent would otherwise stop. */
  followUp(message: AgentMessage): void {
    this.followUpQueue.enqueue(message);
  }

  clearAllQueues(): void {
    this.steeringQueue.clear();
    this.followUpQueue.clear();
  }

  hasQueuedMessages(): boolean {
    return this.steeringQueue.hasItems() || this.followUpQueue.hasItems();
  }

  /** The current run's abort signal, if a run is active. */
  get signal(): AbortSignal | undefined {
    return this.activeRun?.abortController.signal;
  }

  /** Aborts the current run: the stream and the running tools get the signal. */
  abort(): void {
    this.activeRun?.abortController.abort();
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
    return { messages: this._state.messages.slice(), tools: this._state.tools.slice() };
  }

  private createLoopConfig(): AgentLoopConfig {
    return {
      model: this._state.model,
      reasoning: this._state.thinkingLevel === "off" ? undefined : this._state.thinkingLevel,
      sessionId: this.sessionId,
      convertToLlm: this.convertToLlm,
      getApiKey: this.getApiKey,
      toolExecution: this.toolExecution,
      getSteeringMessages: async () => this.steeringQueue.drain(),
      getFollowUpMessages: async () => this.followUpQueue.drain(),
      probe: this.probe,
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
    this._state.pendingToolCalls = new Set<string>();
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
      case "tool_execution_start":
        this._state.pendingToolCalls.add(event.toolCallId);
        break;
      case "tool_execution_end":
        this._state.pendingToolCalls.delete(event.toolCallId);
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
