// Test backend: a stand-in for `pi --mode rpc` that replays a transcript recorded from the real pi
// (visualiser/test/fixtures/pi/*.out.jsonl, see visualiser/test/record-pi.mjs).
// For each command it writes the recorded lines up to pi's reply to the next recorded command of
// the same type, with the reply's id set to the command's id. After an accepted prompt it also
// writes the run's events, up to agent_settled. A get_state with no recorded reply left gets the
// last one again; any other command with no recorded reply gets an error reply.
// Usage: node pi-replay-backend.mjs <transcript.out.jsonl> [delay ms between lines, default 15]
import { readFileSync } from "node:fs";

const [file, delay = "15"] = process.argv.slice(2);
const lines = readFileSync(file, "utf8").split("\n").filter(Boolean).map((l) => JSON.parse(l));
let cursor = 0;
let lastState = lines.find((m) => m.type === "response" && m.command === "get_state");
let queue = Promise.resolve();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const write = (m) => process.stdout.write(JSON.stringify(m) + "\n");

async function handle(command) {
  const at = lines.findIndex((m, i) => i >= cursor && m.type === "response" && m.command === command.type);
  if (at < 0) {
    if (command.type === "get_state" && lastState) return write({ ...lastState, id: command.id });
    return write({ id: command.id, type: "response", command: command.type, success: false, error: `pi-replay: no recorded reply to ${command.type}` });
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
