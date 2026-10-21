// Mirrors pi packages/coding-agent/src/core/tools/output-accumulator.ts (pinned 16f5f0af4): collects
// a command's output as it streams in. A snapshot is the tail the model may see (truncateTail); once
// the output is too long, all of it goes to a temp file whose path the model gets.
// edupi keeps the whole output in memory and rewrites the temp file at each snapshot; pi keeps
// only a rolling tail and streams the raw bytes to the file.
import { randomBytes } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { type TruncationResult, truncateTail } from "./truncate.ts";

export interface OutputSnapshot {
	content: string;
	truncation: TruncationResult;
	fullOutputPath?: string;
}

export class OutputAccumulator {
	private readonly decoder = new TextDecoder();
	private text = "";
	private tempFilePath: string | undefined;

	/** A chunk may end inside a UTF-8 character: the streaming decoder keeps those bytes for the next chunk. */
	append(data: Buffer): void {
		this.text += this.decoder.decode(data, { stream: true });
	}

	finish(): void {
		this.text += this.decoder.decode();
	}

	async snapshot(): Promise<OutputSnapshot> {
		const truncation = truncateTail(this.text);
		if (truncation.truncated && !this.tempFilePath) {
			this.tempFilePath = join(tmpdir(), `pi-bash-${randomBytes(8).toString("hex")}.log`);
		}
		if (this.tempFilePath) await writeFile(this.tempFilePath, this.text, { mode: 0o600 });
		return { content: truncation.content, truncation, fullOutputPath: this.tempFilePath };
	}

	readFullOutput(): string {
		return this.text;
	}

	/** The bytes after the last newline (0 if the output ends with one). */
	getLastLineBytes(): number {
		return Buffer.byteLength(this.text.slice(this.text.lastIndexOf("\n") + 1), "utf-8");
	}
}
