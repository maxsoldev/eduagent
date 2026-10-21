// Mirrors pi packages/coding-agent/src/core/tools/edit.ts (pinned 16f5f0af4): the edit tool. The
// model sends exact text replacements for one file; pi applies them all to the original text and
// returns a diff in details for the user interface. The model reads only "Successfully replaced N
// block(s) in <path>.".
// edupi leaves out pi's argument repair (prepareEditArguments) and its byte-order mark and CRLF handling.
import { readFile, writeFile } from "node:fs/promises";
import { type Static, Type } from "typebox";
import type { AgentTool } from "../../../agent/types.ts";
import { applyEditsToNormalizedContent, generateDiffString, generateUnifiedPatch } from "./edit-diff.ts";
import { withFileMutationQueue } from "./file-mutation-queue.ts";
import { resolveToCwd } from "./path-utils.ts";

const replaceEditSchema = Type.Object({
	oldText: Type.String({
		description:
			"Exact text for one targeted replacement. It must be unique in the original file and must not overlap with any other edits[].oldText in the same call.",
	}),
	newText: Type.String({ description: "Replacement text for this targeted edit." }),
});

const editSchema = Type.Object({
	path: Type.String({ description: "Path to the file to edit (relative or absolute)" }),
	edits: Type.Array(replaceEditSchema, {
		description:
			"One or more targeted replacements. Each edit is matched against the original file, not incrementally. Do not include overlapping or nested edits. If two changes touch the same block or nearby lines, merge them into one edit instead.",
	}),
});

export const editToolSystemPromptContribution = {
	snippet: "Make precise file edits with exact text replacement, including multiple disjoint edits in one call",
	guidelines: [
		"Use edit for precise changes (edits[].oldText must match exactly)",
		"When changing multiple separate locations in one file, use one edit call with multiple entries in edits[] instead of multiple edit calls",
		"Each edits[].oldText is matched against the original file, not after earlier edits are applied. Do not emit overlapping or nested edits. Merge nearby changes into one edit.",
		"Keep edits[].oldText as small as possible while still being unique in the file. Do not pad with large unchanged regions.",
	],
} as const;

type EditToolInput = Static<typeof editSchema>;

interface EditToolDetails {
	/** The diff for display: "+NN line", "-NN line", " NN line". */
	diff: string;
	/** A standard unified patch of the same change. */
	patch: string;
	/** First changed line in the new file. */
	firstChangedLine?: number;
}

export function createEditTool(cwd: string): AgentTool<EditToolInput, EditToolDetails | undefined> {
	return {
		name: "edit",
		label: "edit",
		description:
			"Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
		parameters: editSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(_toolCallId, { path, edits }, signal) {
			const absolutePath = resolveToCwd(path, cwd);
			return withFileMutationQueue(absolutePath, async () => {
				// Check the signal after each await, not in an abort listener: a listener would release the
				// queue while a file operation may still finish.
				const throwIfAborted = () => {
					if (signal?.aborted) throw new Error("Operation aborted");
				};
				throwIfAborted();
				const content = await readFile(absolutePath, "utf-8"); // a missing file fails with the system's message (ENOENT ...)
				throwIfAborted();
				const { baseContent, newContent } = applyEditsToNormalizedContent(content, edits, path);
				await writeFile(absolutePath, newContent, "utf-8");
				throwIfAborted();

				const diffResult = generateDiffString(baseContent, newContent);
				const patch = generateUnifiedPatch(path, baseContent, newContent);
				return {
					content: [{ type: "text", text: `Successfully replaced ${edits.length} block(s) in ${path}.` }],
					details: { diff: diffResult.diff, patch, firstChangedLine: diffResult.firstChangedLine },
				};
			});
		},
	};
}
