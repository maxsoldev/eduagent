// Mirrors pi packages/coding-agent/src/core/tools/write.ts (pinned 16f5f0af4): the write tool.
// It creates or overwrites a whole file and makes the parent folders.
import { mkdir, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type Static, Type } from "typebox";
import type { AgentTool } from "../../../agent/types.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToCwd } from "./path-utils.ts";

const writeSchema = Type.Object({
	path: Type.String({ description: "Path to the file to write (relative or absolute)" }),
	content: Type.String({ description: "Content to write to the file" }),
});

export const writeToolSystemPromptContribution = {
	snippet: "Create or overwrite files",
	guidelines: ["Use write only for new files or complete rewrites."],
} as const;

export type WriteToolInput = Static<typeof writeSchema>;

export function createWriteTool(cwd: string): AgentTool<WriteToolInput, undefined> {
	return {
		name: "write",
		label: "write",
		description:
			"Write content to a file. Creates the file if it doesn't exist, overwrites if it does. Automatically creates parent directories.",
		parameters: writeSchema,
		async execute(_toolCallId, { path, content }, signal) {
			const absolutePath = resolveToCwd(path, cwd);
			return withFileMutationQueue(absolutePath, async () => {
				// As in edit: check the signal after each await, so the queue stays locked until the write settles.
				const throwIfAborted = () => {
					if (signal?.aborted) throw new Error("Operation aborted");
				};
				throwIfAborted();
				await mkdir(dirname(absolutePath), { recursive: true });
				throwIfAborted();
				await writeFile(absolutePath, content, "utf-8");
				throwIfAborted();
				return { content: [{ type: "text", text: `Successfully wrote to ${path}` }], details: undefined };
			});
		},
	};
}
