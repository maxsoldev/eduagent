// Mirrors pi packages/coding-agent/src/core/tools/truncate.ts (pinned 16f5f0af4): tool output is
// cut to 2000 lines or 50KB, whichever comes first. read keeps the head of a file, bash the tail
// of its output (errors and results are at the end). Only whole lines are kept, with one exception:
// a last line longer than the byte limit keeps its end.

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
	lastLinePartial: boolean; // tail only: the one kept line was cut
	firstLineExceedsLimit: boolean; // head only: not even the first line fits
	maxLines: number;
	maxBytes: number;
}

export interface TruncationOptions {
	maxLines?: number;
	maxBytes?: number;
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

function untruncated(
	content: string,
	totalLines: number,
	totalBytes: number,
	maxLines: number,
	maxBytes: number,
): TruncationResult {
	return {
		content,
		truncated: false,
		truncatedBy: null,
		totalLines,
		totalBytes,
		outputLines: totalLines,
		outputBytes: totalBytes,
		lastLinePartial: false,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}

/** Keeps the first lines that fit. If the first line alone is too big, the content is empty. */
export function truncateHead(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const totalBytes = bytes(content);
	const lines = splitLinesForCounting(content);
	const totalLines = lines.length;
	if (totalLines <= maxLines && totalBytes <= maxBytes)
		return untruncated(content, totalLines, totalBytes, maxLines, maxBytes);

	if (bytes(lines[0]) > maxBytes) {
		return {
			content: "",
			truncated: true,
			truncatedBy: "bytes",
			totalLines,
			totalBytes,
			outputLines: 0,
			outputBytes: 0,
			lastLinePartial: false,
			firstLineExceedsLimit: true,
			maxLines,
			maxBytes,
		};
	}
	const kept: string[] = [];
	let keptBytes = 0;
	let truncatedBy: "lines" | "bytes" = "lines";
	for (let i = 0; i < lines.length && i < maxLines; i++) {
		const lineBytes = bytes(lines[i]) + (i > 0 ? 1 : 0); // +1 for the newline
		if (keptBytes + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			break;
		}
		kept.push(lines[i]);
		keptBytes += lineBytes;
	}
	if (kept.length >= maxLines && keptBytes <= maxBytes) truncatedBy = "lines";
	const output = kept.join("\n");
	return {
		content: output,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: kept.length,
		outputBytes: bytes(output),
		lastLinePartial: false,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}

/** Keeps the last lines that fit. A last line longer than maxBytes keeps its end. */
export function truncateTail(content: string, options: TruncationOptions = {}): TruncationResult {
	const maxLines = options.maxLines ?? DEFAULT_MAX_LINES;
	const maxBytes = options.maxBytes ?? DEFAULT_MAX_BYTES;
	const totalBytes = bytes(content);
	const lines = splitLinesForCounting(content);
	const totalLines = lines.length;
	if (totalLines <= maxLines && totalBytes <= maxBytes)
		return untruncated(content, totalLines, totalBytes, maxLines, maxBytes);

	const kept: string[] = [];
	let keptBytes = 0;
	let truncatedBy: "lines" | "bytes" = "lines";
	let lastLinePartial = false;
	for (let i = lines.length - 1; i >= 0 && kept.length < maxLines; i--) {
		const lineBytes = bytes(lines[i]) + (kept.length > 0 ? 1 : 0);
		if (keptBytes + lineBytes > maxBytes) {
			truncatedBy = "bytes";
			if (kept.length === 0) {
				const end = truncateStringToBytesFromEnd(lines[i], maxBytes);
				kept.unshift(end);
				keptBytes = bytes(end);
				lastLinePartial = true;
			}
			break;
		}
		kept.unshift(lines[i]);
		keptBytes += lineBytes;
	}
	if (kept.length >= maxLines && keptBytes <= maxBytes) truncatedBy = "lines";
	const output = kept.join("\n");
	return {
		content: output,
		truncated: true,
		truncatedBy,
		totalLines,
		totalBytes,
		outputLines: kept.length,
		outputBytes: bytes(output),
		lastLinePartial,
		firstLineExceedsLimit: false,
		maxLines,
		maxBytes,
	};
}

/** The last maxBytes of a string, starting at a whole UTF-8 character. */
function truncateStringToBytesFromEnd(text: string, maxBytes: number): string {
	const buf = Buffer.from(text, "utf-8");
	if (buf.length <= maxBytes) return text;
	let start = buf.length - maxBytes;
	while (start < buf.length && (buf[start] & 0xc0) === 0x80) start++; // skip UTF-8 continuation bytes
	return buf.subarray(start).toString("utf-8");
}
