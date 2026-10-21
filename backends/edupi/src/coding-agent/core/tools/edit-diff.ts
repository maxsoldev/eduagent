// Mirrors pi packages/coding-agent/src/core/tools/edit-diff.ts (pinned 16f5f0af4): applies the
// edit tool's replacements and makes the diff the user sees. Every oldText is matched against the
// original file, so edits cannot depend on each other; they must be unique and must not overlap.
// edupi leaves out pi's fuzzy match (trailing spaces, smart quotes, Unicode dashes) and its CRLF
// normalisation: only exact text matches.
import * as Diff from "diff";

interface Edit {
	oldText: string;
	newText: string;
}

interface MatchedEdit {
	editIndex: number;
	matchIndex: number;
	matchLength: number;
	newText: string;
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

/**
 * Finds every oldText in the content, checks pi's rules, then applies all replacements. pi's name:
 * pi first normalises the line endings to LF. The error texts are pi's (one wording for a single edit).
 */
export function applyEditsToNormalizedContent(
	content: string,
	edits: Edit[],
	path: string,
): { baseContent: string; newContent: string } {
	const single = edits.length === 1;
	const matchedEdits: MatchedEdit[] = edits.map((edit, i) => {
		const matchIndex = content.indexOf(edit.oldText);
		if (matchIndex === -1) {
			throw new Error(
				single
					? `Could not find the exact text in ${path}. The old text must match exactly including all whitespace and newlines.`
					: `Could not find edits[${i}] in ${path}. The oldText must match exactly including all whitespace and newlines.`,
			);
		}
		const occurrences = content.split(edit.oldText).length - 1;
		if (occurrences > 1) {
			throw new Error(
				single
					? `Found ${occurrences} occurrences of the text in ${path}. The text must be unique. Please provide more context to make it unique.`
					: `Found ${occurrences} occurrences of edits[${i}] in ${path}. Each oldText must be unique. Please provide more context to make it unique.`,
			);
		}
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

	const newContent = applyReplacements(content, matchedEdits);
	if (newContent === content) {
		throw new Error(
			single
				? `No changes made to ${path}. The replacement produced identical content. This might indicate an issue with special characters or the text not existing as expected.`
				: `No changes made to ${path}. The replacements produced identical content.`,
		);
	}
	return { baseContent: content, newContent };
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
