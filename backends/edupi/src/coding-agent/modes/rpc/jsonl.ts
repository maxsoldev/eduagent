// Mirrors pi packages/coding-agent/src/modes/rpc/jsonl.ts (pinned 16f5f0af4): strict JSONL framing.
// One JSON value per line, split on "\n" only. Node's readline is not used: it also splits on
// U+2028 and U+2029, which are valid inside JSON strings.
import type { Readable } from "node:stream";
import { StringDecoder } from "node:string_decoder";

export function serializeJsonLine(value: unknown): string {
	return `${JSON.stringify(value)}\n`;
}

/** Calls onLine for each line of the stream (a trailing "\r" is dropped). Returns a detach function. */
export function attachJsonlLineReader(stream: Readable, onLine: (line: string) => void): () => void {
	const decoder = new StringDecoder("utf8");
	let buffer = "";

	const emitLine = (line: string) => onLine(line.endsWith("\r") ? line.slice(0, -1) : line);

	const onData = (chunk: string | Buffer) => {
		buffer += typeof chunk === "string" ? chunk : decoder.write(chunk);
		while (true) {
			const newlineIndex = buffer.indexOf("\n");
			if (newlineIndex === -1) return;
			emitLine(buffer.slice(0, newlineIndex));
			buffer = buffer.slice(newlineIndex + 1);
		}
	};

	const onEnd = () => {
		buffer += decoder.end();
		if (buffer.length > 0) {
			emitLine(buffer);
			buffer = "";
		}
	};

	stream.on("data", onData);
	stream.on("end", onEnd);
	return () => {
		stream.off("data", onData);
		stream.off("end", onEnd);
	};
}
