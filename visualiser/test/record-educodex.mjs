// Records the educodex fixture for the Codex adapter tests (seam C): runs educodex over stdio
// with the scripted fake model, sends what a viewer sends for one turn, declines the approval
// and writes every stdout line to fixtures/educodex-demo.out.jsonl. No network, no API key.
// Run from the repo root: node visualiser/test/record-educodex.mjs. Ids and timings change on each
// run, so update the ids and durations the tests expect after re-recording.
import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const repo = new URL("../..", import.meta.url).pathname;
const tmp = mkdtempSync(join(tmpdir(), "educodex-record-"));
const p = spawn(
	"uv",
	[
		"run",
		"-q",
		"--project",
		`${repo}/backends/educodex`,
		"educodex",
		"app-server",
		"--listen",
		"stdio://",
		"--fake-model",
		`${repo}/backends/educodex/examples/fake/demo.json`,
	],
	{
		cwd: tmp,
		env: { ...process.env, EDUCODEX_HOME: join(tmp, ".home"), OPENROUTER_API_KEY: "test" },
		stdio: ["pipe", "pipe", "inherit"],
	},
);

const lines = [];
const waiting = new Map();
let nextId = 0,
	buffer = "",
	turnDone;
const finished = new Promise((resolve) => (turnDone = resolve));
const send = (m) => p.stdin.write(`${JSON.stringify(m)}\n`);
const request = (method, params = {}) =>
	new Promise((resolve) => {
		waiting.set(++nextId, resolve);
		send({ id: nextId, method, params });
	});

p.stdout.on("data", (chunk) => {
	buffer += chunk;
	while (true) {
		const k = buffer.indexOf("\n");
		if (k < 0) break;
		const line = buffer.slice(0, k);
		buffer = buffer.slice(k + 1);
		lines.push(line);
		const m = JSON.parse(line);
		if (m.method && m.id !== undefined)
			send({ id: m.id, result: { decision: "decline" } }); // the rm -rf approval
		else if (!m.method && waiting.has(m.id)) {
			waiting.get(m.id)(m.result);
			waiting.delete(m.id);
		}
		if (m.method === "turn/completed") turnDone();
	}
});

await request("initialize", { clientInfo: { name: "record", title: "record", version: "0" }, capabilities: {} });
send({ method: "initialized" });
const { thread } = await request("thread/start", { approvalPolicy: "on-request", sandbox: "workspace-write" });
await request("turn/start", {
	threadId: thread.id,
	input: [{ type: "text", text: "Create hello.py that prints a greeting, then run it." }],
});
await finished;
p.stdin.end();
await new Promise((resolve) => p.on("close", resolve));
writeFileSync(new URL("fixtures/educodex-demo.out.jsonl", import.meta.url), `${lines.join("\n")}\n`);
console.log(`${lines.length} lines`);
