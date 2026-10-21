// Mirrors pi packages/coding-agent/src/core/tools/truncate.ts (pinned 16f5f0af4): tool output is
// cut to 2000 lines or 50KB, whichever comes first. read keeps the head of a file, bash the tail
// of its output (errors and results are at the end). Only whole lines are kept.
// edupi leaves out pi's partial last line in truncateTail (a single line over 50KB is dropped).

export const DEFAULT_MAX_LINES = 2000;
export const DEFAULT_MAX_BYTES = 50 * 1024;

export interface TruncationResult {
	content: string;
	truncated: boolean;
	truncatedBy: "lines" | "bytes" | null;
	totalLines: number;
	totalBytes: number;
	outputLines: number;
	outputBytes: number;
	firstLineExceedsLimit: boolean; // head only: not even the first line fits
}

const bytes = (text: string) => Buffer.byteLength(text, "utf-8");

function splitLinesForCounting(content: string): string[] {
	if (content.length === 0) return [];
	const lines = content.split("\n");
	if (content.endsWith("\n")) lines.pop();
	return lines;
}

export function formatSize(size: number): string {
	if (size < 1024) return `${size}B`;
	if (size < 1024 * 1024) return `${(size / 1024).toFixed(1)}KB`;
	return `${(size / (1024 * 1024)).toFixed(1)}MB`;
}

/**
 * Keeps the lines that fit, walking from the start (head) or the end (tail). The result says
 * which limit cut the output; read and bash turn it into the note the model reads.
 */
function truncate(content: string, fromEnd: boolean): TruncationResult {
	const totalBytes = bytes(content);
	const lines = splitLinesForCounting(content);
	const totalLines = lines.length;
	const result = { totalLines, totalBytes, firstLineExceedsLimit: false };
	if (totalLines <= DEFAULT_MAX_LINES && totalBytes <= DEFAULT_MAX_BYTES) {
		return {
			...result,
			content,
			truncated: false,
			truncatedBy: null,
			outputLines: totalLines,
			outputBytes: totalBytes,
		};
	}

	const ordered = fromEnd ? [...lines].reverse() : lines;
	const kept: string[] = [];
	let keptBytes = 0;
	let truncatedBy: "lines" | "bytes" = "lines";
	for (const line of ordered.slice(0, DEFAULT_MAX_LINES)) {
		const lineBytes = bytes(line) + (kept.length > 0 ? 1 : 0); // +1 for the newline
		if (keptBytes + lineBytes > DEFAULT_MAX_BYTES) {
			truncatedBy = "bytes";
			break;
		}
		kept.push(line);
		keptBytes += lineBytes;
	}
	if (fromEnd) kept.reverse();
	const output = kept.join("\n");
	return {
		...result,
		content: output,
		truncated: true,
		truncatedBy,
		outputLines: kept.length,
		outputBytes: bytes(output),
		firstLineExceedsLimit: !fromEnd && kept.length === 0,
	};
}

/** Keeps the first lines that fit (read). If the first line alone is too big, the content is empty. */
export function truncateHead(content: string): TruncationResult {
	return truncate(content, false);
}

/** Keeps the last lines that fit (bash). */
export function truncateTail(content: string): TruncationResult {
	return truncate(content, true);
}
