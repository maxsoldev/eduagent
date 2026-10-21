// edupi only: step mode, as educodex's observe/stepper.py. pi has no step mode. The core calls
// its probe's checkpoint hook at named points; while step mode is on, the Tracer pauses there
// until the client sends debug_continue. Clients turn it on with debug_set_step_mode.
import type { Checkpoint } from "../agent/types.ts";

export const BREAKPOINTS: Checkpoint[] = ["beforeModelRequest", "beforeToolCall", "afterToolCall"];

export class Stepper {
	enabled = false;
	breakpoints = new Set<Checkpoint>(BREAKPOINTS);
	private resume: (() => void) | undefined; // ends the current pause
	private queue: Promise<void> = Promise.resolve(); // pauses wait their turn

	configure(enabled: boolean, breakpoints?: string[]): void {
		this.enabled = enabled;
		if (breakpoints) this.breakpoints = new Set(BREAKPOINTS.filter((b) => breakpoints.includes(b)));
		if (!enabled) this.release();
	}

	shouldPause(name: Checkpoint): boolean {
		return this.enabled && this.breakpoints.has(name);
	}

	/**
	 * Pauses one checkpoint: onPause when it starts, until release() or the abort signal. Parallel
	 * tool calls can reach a checkpoint at the same time; they pause one after the other, so each
	 * debug_continue releases one. Resolves false if it did not pause (aborted, or step mode off).
	 */
	pause(onPause: () => void, signal?: AbortSignal): Promise<boolean> {
		const turn = this.queue.then(
			() =>
				new Promise<boolean>((resolve) => {
					if (signal?.aborted || !this.enabled) return resolve(false);
					const done = () => {
						signal?.removeEventListener("abort", done);
						this.resume = undefined;
						resolve(true);
					};
					this.resume = done;
					signal?.addEventListener("abort", done);
					onPause();
				}),
		);
		this.queue = turn.then(() => {});
		return turn;
	}

	/** Ends the current pause, if any. */
	release(): void {
		this.resume?.();
	}
}
