// Mirrors pi packages/coding-agent/src/core/tools/read.ts (pinned 16f5f0af4): the read tool. It
// returns a text file's lines, cut to 2000 lines or 50KB, and tells the model how to read on
// ("Use offset=N to continue."). pi's skills rely on it: the model reads a SKILL.md with read.
// edupi leaves out images (pi sends them as attachments) and pluggable file operations.
import { readFile } from "node:fs/promises";
import { type Static, Type } from "typebox";
import type { AgentTool } from "../../../agent/types.ts";
import { resolveToCwd } from "./path-utils.ts";
import { DEFAULT_MAX_BYTES, DEFAULT_MAX_LINES, formatSize, type TruncationResult, truncateHead } from "./truncate.ts";

const readSchema = Type.Object({
	path: Type.String({ description: "Path to the file to read (relative or absolute)" }),
	offset: Type.Optional(Type.Number({ description: "Line number to start reading from (1-indexed)" })),
	limit: Type.Optional(Type.Number({ description: "Maximum number of lines to read" })),
});

/** The tool's line in the system prompt's tool list, and its rules. */
export const readToolSystemPromptContribution = {
	snippet: "Read file contents",
	guidelines: ["Use read to examine files instead of cat or sed."],
} as const;

type ReadToolInput = Static<typeof readSchema>;

interface ReadToolDetails {
	truncation?: TruncationResult;
}

export function createReadTool(cwd: string): AgentTool<ReadToolInput, ReadToolDetails | undefined> {
	return {
		name: "read",
		label: "read",
		// pi's text, so the tool spec equals pi's (edupi reads every file as text).
		description: `Read the contents of a file. Supports text files and images (jpg, png, gif, webp, bmp). Images are sent as attachments. For text files, output is truncated to ${DEFAULT_MAX_LINES} lines or ${DEFAULT_MAX_BYTES / 1024}KB (whichever is hit first). Use offset/limit for large files. When you need the full file, continue with offset until complete.`,
		parameters: readSchema,
		constrainedSampling: { type: "json_schema", strict: "prefer" },
		async execute(_toolCallId, { path, offset, limit }, signal) {
			const absolutePath = resolveToCwd(path, cwd);
			// A missing file fails with the system's message (ENOENT ...).
			const allLines = (await readFile(absolutePath, "utf-8")).split("\n");
			if (signal?.aborted) throw new Error("Operation aborted");

			// offset is 1-indexed for the model.
			const startLine = offset ? Math.max(0, offset - 1) : 0;
			const startLineDisplay = startLine + 1;
			if (startLine >= allLines.length) {
				throw new Error(`Offset ${offset} is beyond end of file (${allLines.length} lines total)`);
			}
			// A limit from the model comes first; then truncateHead applies the line and byte limits.
			const endLine = limit !== undefined ? Math.min(startLine + limit, allLines.length) : allLines.length;
			const selectedContent = allLines.slice(startLine, endLine).join("\n");

			const truncation = truncateHead(selectedContent);
			let outputText: string;
			let details: ReadToolDetails | undefined;
			if (truncation.firstLineExceedsLimit) {
				// Not even one line fits: point the model at bash.
				const firstLineSize = formatSize(Buffer.byteLength(allLines[startLine], "utf-8"));
				outputText = `[Line ${startLineDisplay} is ${firstLineSize}, exceeds ${formatSize(DEFAULT_MAX_BYTES)} limit. Use bash: sed -n '${startLineDisplay}p' ${path} | head -c ${DEFAULT_MAX_BYTES}]`;
				details = { truncation };
			} else if (truncation.truncated) {
				const endLineDisplay = startLineDisplay + truncation.outputLines - 1;
				const nextOffset = endLineDisplay + 1;
				outputText = truncation.content;
				outputText +=
					truncation.truncatedBy === "lines"
						? `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${allLines.length}. Use offset=${nextOffset} to continue.]`
						: `\n\n[Showing lines ${startLineDisplay}-${endLineDisplay} of ${allLines.length} (${formatSize(DEFAULT_MAX_BYTES)} limit). Use offset=${nextOffset} to continue.]`;
				details = { truncation };
			} else if (endLine < allLines.length) {
				const remaining = allLines.length - endLine;
				outputText = `${truncation.content}\n\n[${remaining} more lines in file. Use offset=${endLine + 1} to continue.]`;
			} else {
				outputText = truncation.content;
			}
			return { content: [{ type: "text", text: outputText }], details, structuredContent: outputText };
		},
	};
}
