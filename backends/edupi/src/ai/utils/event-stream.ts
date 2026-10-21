// Mirrors pi packages/ai/src/utils/event-stream.ts (pinned 16f5f0af4).
// A push queue that a consumer reads with `for await`, plus a promise for the final result.
// The provider pushes AssistantMessageEvents into it; the agent loop reads them.
import type { AssistantMessage, AssistantMessageEvent } from "../types.ts";

export class EventStream<T, R = T> implements AsyncIterable<T> {
	private queue: T[] = [];
	private waiting: ((value: IteratorResult<T>) => void)[] = [];
	protected done = false;
	private finalResultPromise: Promise<R>;
	private resolveFinalResult!: (result: R) => void;

	constructor(
		private isComplete: (event: T) => boolean,
		private extractResult: (event: T) => R,
	) {
		this.finalResultPromise = new Promise((resolve) => {
			this.resolveFinalResult = resolve;
		});
	}

	push(event: T): void {
		if (this.done) return;
		if (this.isComplete(event)) {
			this.done = true;
			this.resolveFinalResult(this.extractResult(event));
		}
		const waiter = this.waiting.shift(); // deliver to a waiting consumer, or queue it
		if (waiter) waiter({ value: event, done: false });
		else this.queue.push(event);
	}

	end(result?: R): void {
		this.done = true;
		if (result !== undefined) this.resolveFinalResult(result);
		for (const waiter of this.waiting.splice(0)) waiter({ value: undefined as never, done: true });
	}

	async *[Symbol.asyncIterator](): AsyncIterator<T> {
		while (true) {
			if (this.queue.length > 0) {
				yield this.queue.shift()!;
			} else if (this.done) {
				return;
			} else {
				const result = await new Promise<IteratorResult<T>>((resolve) => this.waiting.push(resolve));
				if (result.done) return;
				yield result.value;
			}
		}
	}

	result(): Promise<R> {
		return this.finalResultPromise;
	}
}

/** The stream of one assistant response. It ends on `done` or `error` and times the response. */
export class AssistantMessageEventStream extends EventStream<AssistantMessageEvent, AssistantMessage> {
	private readonly startedAt = Date.now();
	private readonly startedAtMonotonic = performance.now();

	constructor() {
		super(
			(event) => event.type === "done" || event.type === "error",
			(event) => {
				if (event.type === "done") return event.message;
				if (event.type === "error") return event.error;
				throw new Error("Unexpected event type for final result");
			},
		);
	}

	override push(event: AssistantMessageEvent): void {
		if (event.type === "done") this.time(event.message);
		else if (event.type === "error") this.time(event.error);
		super.push(event);
	}

	/** Sets `durationMs` on the final message, unless it started before this stream. */
	private time(message: AssistantMessage): void {
		if (this.done || message.durationMs !== undefined || message.timestamp < this.startedAt) return;
		message.durationMs = Math.max(0, Math.round(performance.now() - this.startedAtMonotonic));
	}
}
