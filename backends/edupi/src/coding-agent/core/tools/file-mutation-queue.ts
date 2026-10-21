// Mirrors pi packages/coding-agent/src/core/tools/file-mutation-queue.ts (pinned 16f5f0af4). pi runs
// a reply's tool calls in parallel, so two edits of one file could both read the old text, and the
// later write would drop the first change. edit and write wait here: one mutation per file at a time.
// edupi keys the queue by the absolute path; pi uses the real path (a symlink shares its target's queue).
import { resolve } from "node:path";

const fileMutationQueues = new Map<string, Promise<void>>();

/** Serialize file mutation operations targeting the same file. Operations for different files still run in parallel. */
export async function withFileMutationQueue<T>(filePath: string, fn: () => Promise<T>): Promise<T> {
	const key = resolve(filePath);
	const currentQueue = fileMutationQueues.get(key) ?? Promise.resolve();
	let releaseNext!: () => void;
	const nextQueue = new Promise<void>((resolveQueue) => {
		releaseNext = resolveQueue;
	});
	const chainedQueue = currentQueue.then(() => nextQueue);
	fileMutationQueues.set(key, chainedQueue);

	await currentQueue;
	try {
		return await fn();
	} finally {
		releaseNext();
		if (fileMutationQueues.get(key) === chainedQueue) fileMutationQueues.delete(key);
	}
}
