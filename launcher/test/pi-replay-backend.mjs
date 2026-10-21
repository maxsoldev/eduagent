// Test backend: replays a real pi transcript (visualiser/test/fixtures/pi/*.out.jsonl) as `pi --mode rpc`.
// Each command gets the recorded lines up to pi's reply to the next command of its type (with the
// command's id); an accepted prompt also gets the run's events, up to agent_settled. With no recorded
// reply left, get_state repeats the last one and other commands get an error reply.
// Usage: node pi-replay-backend.mjs <transcript.out.jsonl> [delay ms between lines, default 15]
import { readFileSync } from "node:fs";

const [file, delay = "15"] = process.argv.slice(2);
const lines = readFileSync(file, "utf8")
	.split("\n")
	.filter(Boolean)
	.map((l) => JSON.parse(l));
let cursor = 0;
let lastState = lines.find((m) => m.type === "response" && m.command === "get_state");
let queue = Promise.resolve();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const write = (m) => process.stdout.write(JSON.stringify(m) + "\n");

async function handle(command) {
	const at = lines.findIndex((m, i) => i >= cursor && m.type === "response" && m.command === command.type);
	if (at < 0) {
		if (command.type === "get_state" && lastState) return write({ ...lastState, id: command.id });
		return write({
			id: command.id,
			type: "response",
			command: command.type,
			success: false,
			error: `pi-replay: no recorded reply to ${command.type}`,
		});
	}
	let end = at;
	if (command.type === "prompt" && lines[at].data?.disposition === "started") {
		end = lines.findIndex((m, i) => i > at && m.type === "agent_settled");
		if (end < 0) end = lines.length - 1;
	}
	for (; cursor <= end; cursor++) {
		const m = lines[cursor];
		if (m.type === "response" && m.command === "get_state") lastState = m;
		write(cursor === at ? { ...m, id: command.id } : m);
		await sleep(Number(delay));
	}
}

let buffer = "";
process.stdin.setEncoding("utf8");
process.stdin.on("data", (data) => {
	buffer += data;
	for (let k; (k = buffer.indexOf("\n")) >= 0; buffer = buffer.slice(k + 1)) {
		const command = JSON.parse(buffer.slice(0, k));
		queue = queue.then(() => handle(command));
	}
});
process.stdin.on("end", () => queue.then(() => process.exit(0)));
