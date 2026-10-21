// Mirrors pi packages/coding-agent/src/core/tools/edit.ts (pinned 16f5f0af4): the edit tool. The
// model sends exact text replacements for one file; pi applies them all to the original text,
// keeps the file's BOM and line endings, and returns a diff in details for the user interface.
// The model reads only "Successfully replaced N block(s) in <path>.".
import { constants } from "node:fs";
import { access, readFile, writeFile } from "node:fs/promises";
import { type Static, Type } from "typebox";
import type { AgentTool } from "../../../agent/types.ts";
import {
	applyEditsToNormalizedContent,
	detectLineEnding,
	type Edit,
	generateDiffString,
	generateUnifiedPatch,
	normalizeToLF,
	restoreLineEndings,
} from "./edit-diff.ts";
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

export type EditToolInput = Static<typeof editSchema>;

export interface EditToolDetails {
	/** The diff for display: "+NN line", "-NN line", " NN line". */
	diff: string;
	/** A standard unified patch of the same change. */
	patch: string;
	/** First changed line in the new file. */
	firstChangedLine?: number;
}

const isSingleEdit = (value: unknown): value is Edit =>
	!!value &&
	typeof value === "object" &&
	!Array.isArray(value) &&
	typeof (value as Edit).oldText === "string" &&
	typeof (value as Edit).newText === "string";

/**
 * Models get the shape wrong in a few common ways: edits as a JSON string, one edit object
 * instead of an array, or oldText/newText at the top level (an older pi schema). pi accepts all three.
 */
function prepareEditArguments(input: unknown): unknown {
	if (!input || typeof input !== "object") return input;
	const args = input as Record<string, unknown>;
	if (typeof args.edits === "string") {
		try {
			const parsed = JSON.parse(args.edits);
			if (Array.isArray(parsed)) args.edits = parsed;
			else if (isSingleEdit(parsed)) args.edits = [parsed];
		} catch {}
	} else if (isSingleEdit(args.edits)) {
		args.edits = [args.edits];
	}
	if (typeof args.oldText !== "string" || typeof args.newText !== "string") return args;
	const edits = Array.isArray(args.edits) ? [...args.edits] : [];
	edits.push({ oldText: args.oldText, newText: args.newText });
	const { oldText: _oldText, newText: _newText, ...rest } = args;
	return { ...rest, edits };
}

export function createEditTool(cwd: string): AgentTool<EditToolInput, EditToolDetails | undefined> {
	return {
		name: "edit",
		label: "edit",
		description:
			"Edit a single file using exact text replacement. Every edits[].oldText must match a unique, non-overlapping region of the original file. If two changes affect the same block or nearby lines, merge them into one edit instead of emitting overlapping edits. Do not include large unchanged regions just to connect distant changes.",
		parameters: editSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		prepareArguments: prepareEditArguments,
		async execute(_toolCallId, input, signal) {
			if (!Array.isArray(input.edits) || input.edits.length === 0) {
				throw new Error("Edit tool input is invalid. edits must contain at least one replacement.");
			}
			const { path, edits } = input;
			const absolutePath = resolveToCwd(path, cwd);
			return withFileMutationQueue(absolutePath, async () => {
				// Check the signal after each await, not in an abort listener: a listener would release the
				// queue while a file operation may still finish.
				const throwIfAborted = () => {
					if (signal?.aborted) throw new Error("Operation aborted");
				};
				throwIfAborted();
				try {
					await access(absolutePath, constants.R_OK | constants.W_OK);
				} catch (error) {
					throwIfAborted();
					const errorMessage =
						error instanceof Error && "code" in error ? `Error code: ${error.code}` : String(error);
					throw new Error(`Could not edit file: ${path}. ${errorMessage}.`);
				}
				throwIfAborted();
				const rawContent = await readFile(absolutePath, "utf-8");
				throwIfAborted();

				// The model never sends the invisible BOM, so strip it before matching and put it back after.
				const bom = rawContent.startsWith("\uFEFF") ? "\uFEFF" : "";
				const content = rawContent.slice(bom.length);
				const originalEnding = detectLineEnding(content);
				const { baseContent, newContent } = applyEditsToNormalizedContent(normalizeToLF(content), edits, path);
				throwIfAborted();

				await writeFile(absolutePath, bom + restoreLineEndings(newContent, originalEnding), "utf-8");
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
