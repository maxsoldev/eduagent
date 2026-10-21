// Mirrors pi packages/agent/src/agent.ts (pinned 16f5f0af4): the stateful Agent around the loop.
// It owns the transcript, runs one prompt at a time, keeps its state up to date from the loop's
// events, then passes each event to its listeners and awaits them in order. It also holds the
// steering and follow-up queues that the loop drains while a run is active.
import type { Message, Model } from "../ai/types.ts";
import { runAgentLoop, runAgentLoopContinue } from "./agent-loop.ts";
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
} from "./types.ts";

const EMPTY_USAGE = {
	input: 0,
	output: 0,
	cacheRead: 0,
	cacheWrite: 0,
	totalTokens: 0,
	cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
};

export interface AgentOptions {
	initialState: { model: Model; thinkingLevel?: ThinkingLevel; tools?: AgentTool<any>[]; messages?: AgentMessage[] };
	convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	streamFn: StreamFn;
	getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	sessionId?: string;
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

	drain(): AgentMessage[] {
		const drained = this.mode === "all" ? this.messages.slice() : this.messages.slice(0, 1);
		this.messages = this.messages.slice(drained.length);
		return drained;
	}
}

export class Agent {
	private _state: AgentState;
	private readonly listeners = new Set<(event: AgentEvent) => Promise<void> | void>();
	/** The active run's controller: abort() stops the stream and the running tools. */
	private abortController?: AbortController;
	private readonly steeringQueue: PendingMessageQueue;
	private readonly followUpQueue: PendingMessageQueue;

	public convertToLlm: (messages: AgentMessage[]) => Message[] | Promise<Message[]>;
	public streamFunction: StreamFn;
	public getApiKey?: (provider: string) => Promise<string | undefined> | string | undefined;
	/** Session id, forwarded to the provider (OpenRouter session affinity). */
	public sessionId?: string;
	public probe?: AgentProbe;
	/** Before each later turn of a run; the session sets it (pi: prepareNextTurnWithContext). */
	public prepareNextTurn?: AgentLoopConfig["prepareNextTurn"];

	constructor(options: AgentOptions) {
		this._state = {
			model: options.initialState.model,
			thinkingLevel: options.initialState.thinkingLevel ?? "off",
			tools: options.initialState.tools?.slice() ?? [],
			messages: options.initialState.messages?.slice() ?? [],
		};
		this.convertToLlm = options.convertToLlm;
		this.streamFunction = options.streamFn;
		this.getApiKey = options.getApiKey;
		this.sessionId = options.sessionId;
		// pi's default mode; edupi has no commands to change it.
		this.steeringQueue = new PendingMessageQueue("one-at-a-time");
		this.followUpQueue = new PendingMessageQueue("one-at-a-time");
		this.probe = options.probe;
	}

	/** Listeners are awaited in order; the run is idle only after the agent_end listeners finish. */
	subscribe(listener: (event: AgentEvent) => Promise<void> | void): () => void {
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

	hasQueuedMessages(): boolean {
		return this.steeringQueue.hasItems() || this.followUpQueue.hasItems();
	}

	/** Aborts the current run: the stream and the running tools get the signal. */
	abort(): void {
		this.abortController?.abort();
	}

	/** Starts a run from the prompt messages. Only one run at a time (the session checks it). */
	async prompt(messages: AgentMessage[]): Promise<void> {
		await this.runPromptMessages(messages);
	}

	/**
	 * Runs the loop again from the current messages, without a new prompt (after an overflow, the
	 * session compacts and continues). After an assistant reply it starts from the queued messages instead.
	 */
	async continue(): Promise<void> {
		const lastMessage = this._state.messages[this._state.messages.length - 1];
		if (!lastMessage || this._state.messages.every((message) => message.role === "system")) {
			throw new Error("No messages to continue from");
		}
		if (lastMessage.role === "assistant") {
			// The drained steering message is this run's prompt, so the loop must not poll steering again at once.
			const queuedSteering = this.steeringQueue.drain();
			if (queuedSteering.length > 0) {
				await this.runPromptMessages(queuedSteering, { skipInitialSteeringPoll: true });
				return;
			}
			const queuedFollowUps = this.followUpQueue.drain();
			if (queuedFollowUps.length > 0) {
				await this.runPromptMessages(queuedFollowUps);
				return;
			}
			throw new Error("Cannot continue from message role: assistant");
		}
		await this.runContinuation();
	}

	private async runPromptMessages(
		messages: AgentMessage[],
		options: { skipInitialSteeringPoll?: boolean } = {},
	): Promise<void> {
		await this.runWithLifecycle(async (signal) => {
			await runAgentLoop(
				messages,
				this.createContextSnapshot(),
				this.createLoopConfig(options),
				(event) => this.processEvents(event),
				signal,
				this.streamFunction,
			);
		});
	}

	private async runContinuation(): Promise<void> {
		await this.runWithLifecycle(async (signal) => {
			await runAgentLoopContinue(
				this.createContextSnapshot(),
				this.createLoopConfig(),
				(event) => this.processEvents(event),
				signal,
				this.streamFunction,
			);
		});
	}

	/** Copies, so the loop's pushes do not touch the state; the state grows from message_end events. */
	private createContextSnapshot(): AgentContext {
		return { messages: this._state.messages.slice(), tools: this._state.tools.slice() };
	}

	private createLoopConfig(options: { skipInitialSteeringPoll?: boolean } = {}): AgentLoopConfig {
		let skipInitialSteeringPoll = options.skipInitialSteeringPoll === true;
		return {
			model: this._state.model,
			reasoning: this._state.thinkingLevel === "off" ? undefined : this._state.thinkingLevel,
			sessionId: this.sessionId,
			convertToLlm: this.convertToLlm,
			getApiKey: this.getApiKey,
			getSteeringMessages: async () => {
				if (skipInitialSteeringPoll) {
					skipInitialSteeringPoll = false;
					return [];
				}
				return this.steeringQueue.drain();
			},
			getFollowUpMessages: async () => this.followUpQueue.drain(),
			probe: this.probe,
			prepareNextTurn: this.prepareNextTurn,
		};
	}

	/** One run: a new abort signal, the loop, and a failed reply if the loop throws. */
	private async runWithLifecycle(executor: (signal: AbortSignal) => Promise<void>): Promise<void> {
		const abortController = new AbortController();
		this.abortController = abortController;
		try {
			await executor(abortController.signal);
		} catch (error) {
			await this.handleRunFailure(error, abortController.signal.aborted);
		} finally {
			this.abortController = undefined;
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

	/** Adds each finished message to the state, then awaits the listeners. */
	private async processEvents(event: AgentEvent): Promise<void> {
		if (event.type === "message_end") this._state.messages.push(event.message);
		for (const listener of this.listeners) await listener(event);
	}
}
