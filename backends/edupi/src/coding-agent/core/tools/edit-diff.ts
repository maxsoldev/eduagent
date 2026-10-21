// Mirrors pi packages/coding-agent/src/core/tools/edit-diff.ts (pinned 16f5f0af4): applies the
// edit tool's replacements and makes the diff the user sees. Every oldText is matched against the
// original file, so edits cannot depend on each other; they must be unique and must not overlap.
// edupi leaves out pi's fuzzy match (trailing spaces, smart quotes, Unicode dashes): only exact text matches.
import * as Diff from "diff";

export function detectLineEnding(content: string): "\r\n" | "\n" {
	const crlfIdx = content.indexOf("\r\n");
	const lfIdx = content.indexOf("\n");
	if (lfIdx === -1 || crlfIdx === -1) return "\n";
	return crlfIdx < lfIdx ? "\r\n" : "\n";
}

export function normalizeToLF(text: string): string {
	return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n");
}

export function restoreLineEndings(text: string, ending: "\r\n" | "\n"): string {
	return ending === "\r\n" ? text.replace(/\n/g, "\r\n") : text;
}

export interface Edit {
	oldText: string;
	newText: string;
}

interface MatchedEdit {
	editIndex: number;
	matchIndex: number;
	matchLength: number;
	newText: string;
}

function countOccurrences(content: string, oldText: string): number {
	return content.split(oldText).length - 1;
}

/** Replaces from the end, so the offsets of the earlier matches stay valid. */
function applyReplacements(content: string, replacements: MatchedEdit[]): string {
	let result = content;
	for (let i = replacements.length - 1; i >= 0; i--) {
		const { matchIndex, matchLength, newText } = replacements[i];
		result = result.substring(0, matchIndex) + newText + result.substring(matchIndex + matchLength);
	}
	return result;
}

function getNotFoundError(path: string, editIndex: number, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`,
		);
	}
	return new Error(
		`Could not find edits[${editIndex}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
	);
}

function getDuplicateError(path: string, editIndex: number, totalEdits: number, occurrences: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`,
		);
	}
	return new Error(
		`Found ${occurrences} occurrences of edits[${editIndex}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
	);
}

function getEmptyOldTextError(path: string, editIndex: number, totalEdits: number): Error {
	return new Error(
		totalEdits === 1
			? `oldText must not be empty in ${path}.`
			: `edits[${editIndex}].oldText must not be empty in ${path}.`,
	);
}

function getNoChangeError(path: string, totalEdits: number): Error {
	if (totalEdits === 1) {
		return new Error(
			`No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`,
		);
	}
	return new Error(`No changes made to ${path}. The replacements produced identical content.`);
}

/** Finds every oldText in the LF-normalized content, checks the rules, then applies all replacements. */
export function applyEditsToNormalizedContent(
	normalizedContent: string,
	edits: Edit[],
	path: string,
): { baseContent: string; newContent: string } {
	const normalizedEdits = edits.map((edit) => ({
		oldText: normalizeToLF(edit.oldText),
		newText: normalizeToLF(edit.newText),
	}));
	normalizedEdits.forEach((edit, i) => {
		if (edit.oldText.length === 0) throw getEmptyOldTextError(path, i, normalizedEdits.length);
	});

	const matchedEdits: MatchedEdit[] = normalizedEdits.map((edit, i) => {
		const matchIndex = normalizedContent.indexOf(edit.oldText);
		if (matchIndex === -1) throw getNotFoundError(path, i, normalizedEdits.length);
		const occurrences = countOccurrences(normalizedContent, edit.oldText);
		if (occurrences > 1) throw getDuplicateError(path, i, normalizedEdits.length, occurrences);
		return { editIndex: i, matchIndex, matchLength: edit.oldText.length, newText: edit.newText };
	});

	matchedEdits.sort((a, b) => a.matchIndex - b.matchIndex);
	for (let i = 1; i < matchedEdits.length; i++) {
		const previous = matchedEdits[i - 1];
		const current = matchedEdits[i];
		if (previous.matchIndex + previous.matchLength > current.matchIndex) {
			throw new Error(
				`edits[${previous.editIndex}] and edits[${current.editIndex}] overlap in ${path}. Merge them into one edit or target disjoint regions.`,
			);
		}
	}

	const newContent = applyReplacements(normalizedContent, matchedEdits);
	if (newContent === normalizedContent) throw getNoChangeError(path, normalizedEdits.length);
	return { baseContent: normalizedContent, newContent };
}

/** A standard unified patch (for tools and humans who read patches). */
export function generateUnifiedPatch(path: string, oldContent: string, newContent: string, contextLines = 4): string {
	return Diff.createTwoFilesPatch(path, path, oldContent, newContent, undefined, undefined, {
		context: contextLines,
		headerOptions: Diff.FILE_HEADERS_ONLY,
	});
}

/**
 * The diff pi's user interface shows: each line is "+NN text" (added, new line number), "-NN text"
 * (removed, old line number) or " NN text" (context), and " ..." where unchanged lines are skipped.
 */
export function generateDiffString(
	oldContent: string,
	newContent: string,
	contextLines = 4,
): { diff: string; firstChangedLine: number | undefined } {
	const parts = Diff.diffLines(oldContent, newContent);
	const output: string[] = [];
	const lineNumWidth = String(Math.max(oldContent.split("\n").length, newContent.split("\n").length)).length;
	const num = (n: number) => String(n).padStart(lineNumWidth, " ");
	const skipped = ` ${"".padStart(lineNumWidth, " ")} ...`;

	let oldLineNum = 1;
	let newLineNum = 1;
	let lastWasChange = false;
	let firstChangedLine: number | undefined;
	const context = (line: string) => {
		output.push(` ${num(oldLineNum)} ${line}`);
		oldLineNum++;
		newLineNum++;
	};

	for (let i = 0; i < parts.length; i++) {
		const part = parts[i];
		const raw = part.value.split("\n");
		if (raw[raw.length - 1] === "") raw.pop();

		if (part.added || part.removed) {
			firstChangedLine ??= newLineNum;
			for (const line of raw) {
				if (part.added) output.push(`+${num(newLineNum++)} ${line}`);
				else output.push(`-${num(oldLineNum++)} ${line}`);
			}
			lastWasChange = true;
			continue;
		}

		// Unchanged lines: show a few next to a change, skip the rest.
		const nextPartIsChange = i < parts.length - 1 && (parts[i + 1].added || parts[i + 1].removed);
		if (lastWasChange && nextPartIsChange && raw.length > contextLines * 2) {
			raw.slice(0, contextLines).forEach(context);
			output.push(skipped);
			oldLineNum += raw.length - contextLines * 2;
			newLineNum += raw.length - contextLines * 2;
			raw.slice(raw.length - contextLines).forEach(context);
		} else if (lastWasChange && nextPartIsChange) {
			raw.forEach(context);
		} else if (lastWasChange) {
			raw.slice(0, contextLines).forEach(context);
			if (raw.length > contextLines) {
				output.push(skipped);
				oldLineNum += raw.length - contextLines;
				newLineNum += raw.length - contextLines;
			}
		} else if (nextPartIsChange) {
			const skip = Math.max(0, raw.length - contextLines);
			if (skip > 0) {
				output.push(skipped);
				oldLineNum += skip;
				newLineNum += skip;
			}
			raw.slice(skip).forEach(context);
		} else {
			oldLineNum += raw.length;
			newLineNum += raw.length;
		}
		lastWasChange = false;
	}
	return { diff: output.join("\n"), firstChangedLine };
}
