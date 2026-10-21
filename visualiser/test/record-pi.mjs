// Records the real pi fixtures for the pi adapter tests (seam C). For each scenario it starts the
// fake Chat Completions server, runs the pinned pi checkout in RPC mode from source, sends the
// scenario's commands and saves what pi wrote to stdout. No network model call, no API key.
//
//   node visualiser/test/record-pi.mjs              (from the repo root; pi at <repo>/../pi)
//   PI_DIR=/path/to/pi node visualiser/test/record-pi.mjs
//
// Output in test/fixtures/pi/: <scenario>.in.jsonl (commands), <scenario>.out.jsonl (stdout),
// <scenario>.requests.jsonl (model request bodies) and meta.json (pi commit, date, Node version).
// Ids, timestamps and durations change on each run; update what the tests pin after re-recording.
import { execFileSync, spawn } from "node:child_process";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { startFakeChatCompletions } from "./fake-chat-completions.mjs";

const PINNED = "16f5f0af4d85ca583d045ceb5ed6d646fcaf7761";
const MODEL = "openai/gpt-6-luna";
const repo = new URL("../..", import.meta.url).pathname;
const PI = resolve(process.env.PI_DIR ?? join(repo, "..", "pi"));
const OUT = new URL("fixtures/pi/", import.meta.url).pathname;
const WORK = "/tmp/eduagent-pi-record"; // a fixed path, so the cwd in the transcripts stays the same

const commit = execFileSync("git", ["-C", PI, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
if (commit !== PINNED) throw new Error(`${PI} is at ${commit}, not the pinned ${PINNED}`);

// Each scenario: files for the cwd, pi settings, the fake model's replies and the commands.
const SCENARIOS = [
  {
    name: "chat",
    files: { "a.txt": "alpha\nbeta\n" },
    script: [
      { text: ["Hello", " from", " the fake model."] },
      { toolCalls: [
        { id: "call_1", name: "bash", arguments: { command: "echo hi" } },
        { id: "call_2", name: "read", arguments: { path: "a.txt" } },
        { id: "call_3", name: "read", arguments: { path: "missing.txt" } },
      ] },
      { text: ["a.txt has two lines; missing.txt does not exist."] },
    ],
    async run(pi) {
      await pi.send({ type: "get_state" });
      await pi.prompt("Say hello.");
      await pi.prompt("Run echo hi, then read a.txt and missing.txt.");
    },
  },
  {
    name: "abort",
    script: [
      { toolCalls: [{ id: "call_slow", name: "bash", arguments: { command: "echo started; sleep 5; echo finished" } }] },
      { text: ["Still here."] },
    ],
    async run(pi) {
      await pi.send({ type: "get_state" });
      await pi.send({ type: "compact" }); // fails: nothing to compact yet
      const settled = pi.until((m) => m.type === "agent_settled");
      await pi.send({ type: "prompt", message: "Run a slow command." });
      await pi.until((m) => m.type === "tool_execution_update" && m.partialResult?.content?.length);
      await pi.send({ type: "abort" });
      await settled;
      await pi.prompt("Are you still there?");
    },
  },
  {
    name: "compact",
    // Keep only the last few tokens, so a manual compaction has history to summarise (one summary request).
    settings: { compaction: { keepRecentTokens: 10 } },
    script: [
      { text: ["First answer: the project has one file, a.txt."] },
      { text: ["Second answer: a.txt holds two words."] },
      { text: ["Third answer: nothing else to add."] },
      { text: ["## Goal\nSUMMARY OF THE EARLIER TURNS"] },
      { text: ["After the compaction."] },
    ],
    async run(pi) {
      await pi.send({ type: "get_state" });
      await pi.prompt("What is in this project?");
      await pi.prompt("What does a.txt hold?");
      await pi.prompt("Anything else?");
      await pi.send({ type: "compact", customInstructions: "Keep the file names." });
      await pi.prompt("Go on.");
    },
  },
];

const RESOLVER = pathToFileURL(join(PI, "packages/coding-agent/src/experimental/source-resolver.ts")).href;
const CLI = join(PI, "packages/coding-agent/src/cli.ts");

async function record(scenario) {
  const dir = join(WORK, scenario.name);
  rmSync(dir, { recursive: true, force: true });
  for (const sub of ["home", "agent", "cwd"]) mkdirSync(join(dir, sub), { recursive: true });
  for (const [path, text] of Object.entries(scenario.files ?? {})) writeFileSync(join(dir, "cwd", path), text);

  const requests = [];
  const server = await startFakeChatCompletions(scenario.script, { onRequest: (r) => requests.push({ url: r.url, body: r.body }) });
  // A custom provider (not "openrouter"), so no value comes from pi's date-dependent model catalog.
  writeFileSync(join(dir, "agent/models.json"), JSON.stringify({ providers: { fake: {
    baseUrl: `http://127.0.0.1:${server.port}/v1`, api: "openai-completions", apiKey: "fake-key",
    compat: { thinkingFormat: "openrouter" },
    models: [{ id: MODEL, name: "Fake luna", reasoning: true, contextWindow: 400000, maxTokens: 128000,
      cost: { input: 1.25, output: 10, cacheRead: 0.125, cacheWrite: 0 } }],
  } } }, null, 2));
  if (scenario.settings) writeFileSync(join(dir, "agent/settings.json"), JSON.stringify(scenario.settings));

  const env = { ...process.env, HOME: join(dir, "home"), PI_CODING_AGENT_DIR: join(dir, "agent"),
    PI_OFFLINE: "1", PI_SKIP_VERSION_CHECK: "1", PI_TELEMETRY: "0" };
  delete env.OPENROUTER_API_KEY;
  delete env.OPENAI_API_KEY;
  const p = spawn("node", ["--import", RESOLVER, CLI, "--mode", "rpc", "--provider", "fake", "--model", MODEL],
    { cwd: join(dir, "cwd"), env, stdio: ["pipe", "pipe", "inherit"] });

  const sent = [], lines = [], waiters = [];
  let buffer = "", nextId = 0;
  p.stdout.on("data", (data) => {
    buffer += data;
    for (let k; (k = buffer.indexOf("\n")) >= 0; buffer = buffer.slice(k + 1)) {
      const m = JSON.parse(buffer.slice(0, k));
      lines.push(m);
      for (const w of [...waiters]) if (w.match(m)) { waiters.splice(waiters.indexOf(w), 1); w.resolve(m); }
    }
  });
  const pi = {
    /** Resolves with the next stdout message that matches. */
    until: (match) => new Promise((resolve) => waiters.push({ match, resolve })),
    /** Sends a command and resolves with its response. */
    send(command) {
      const id = String(++nextId);
      const reply = pi.until((m) => m.type === "response" && m.id === id);
      sent.push({ id, ...command });
      p.stdin.write(JSON.stringify({ id, ...command }) + "\n");
      return reply;
    },
    /** Sends a prompt and waits until the run settles. */
    async prompt(message) {
      const settled = pi.until((m) => m.type === "agent_settled");
      const reply = await pi.send({ type: "prompt", message });
      if (!reply.success) throw new Error(reply.error);
      return settled;
    },
  };
  await scenario.run(pi);
  p.stdin.end();
  await new Promise((r) => p.on("close", r));
  await server.close();

  const jsonl = (items) => items.map((x) => JSON.stringify(x)).join("\n") + "\n";
  writeFileSync(join(OUT, `${scenario.name}.in.jsonl`), jsonl(sent));
  writeFileSync(join(OUT, `${scenario.name}.out.jsonl`), jsonl(lines));
  writeFileSync(join(OUT, `${scenario.name}.requests.jsonl`), jsonl(requests));
  console.log(`${scenario.name}: ${sent.length} commands, ${lines.length} lines, ${requests.length} model requests`);
}

mkdirSync(OUT, { recursive: true });
const only = process.argv.slice(2);
for (const s of SCENARIOS) if (!only.length || only.includes(s.name)) await record(s);
writeFileSync(join(OUT, "meta.json"), JSON.stringify({
  pi: { repo: "https://github.com/earendil-works/pi", commit }, recordedAt: new Date().toISOString().slice(0, 10),
  node: process.version, recorder: "visualiser/test/record-pi.mjs", provider: "custom provider \"fake\" (api openai-completions) on the fake Chat Completions server",
}, null, 2) + "\n");
