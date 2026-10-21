// Seam A: starts edupi in RPC mode as a child process, as the launcher does, and talks pi's RPC
// protocol to it over stdin/stdout: one JSON object per line. The model is the faux provider,
// scripted by a JSON file; it records every request body it receives.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { mkdtempSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const BIN = new URL("../bin/edupi.mjs", import.meta.url).pathname;

export type Message = Record<string, any>;

export class RpcClient {
  readonly seen: Message[] = [];
  private waiters: { match: (m: Message) => boolean; resolve: (m: Message) => void }[] = [];
  private stderr = "";
  private nextId = 1;

  constructor(private proc: ChildProcessWithoutNullStreams, readonly dir: string) {
    let buffer = "";
    proc.stdout.setEncoding("utf8");
    proc.stdout.on("data", (chunk: string) => {
      buffer += chunk;
      let i: number;
      while ((i = buffer.indexOf("\n")) >= 0) {
        this.receive(JSON.parse(buffer.slice(0, i)));
        buffer = buffer.slice(i + 1);
      }
    });
    proc.stderr.on("data", (chunk) => (this.stderr += chunk));
  }

  private receive(message: Message) {
    this.seen.push(message);
    for (const w of [...this.waiters]) {
      if (w.match(message)) {
        this.waiters.splice(this.waiters.indexOf(w), 1);
        w.resolve(message);
      }
    }
  }

  /** Writes one raw line to edupi's stdin. */
  sendLine(line: string) {
    this.proc.stdin.write(`${line}\n`);
  }

  /** Sends a command with a fresh id and resolves with its response. */
  command(type: string, fields: Message = {}): Promise<Message> {
    const id = String(this.nextId++);
    const reply = this.until((m) => m.type === "response" && m.id === id);
    this.sendLine(JSON.stringify({ id, type, ...fields }));
    return reply;
  }

  /** Resolves with the first message (already seen or later) that matches. */
  until(match: string | ((m: Message) => boolean), timeoutMs = 10_000): Promise<Message> {
    const test = typeof match === "string" ? (m: Message) => m.type === match : match;
    const found = this.seen.find(test);
    if (found) return Promise.resolve(found);
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`timed out waiting; stderr:\n${this.stderr}`)), timeoutMs);
      this.waiters.push({ match: test, resolve: (m) => { clearTimeout(timer); resolve(m); } });
    });
  }

  /** The request bodies the faux provider received, in order. */
  requests(): { url: string; body: Message }[] {
    const log = join(this.dir, "faux-requests.jsonl");
    if (!existsSync(log)) return [];
    return readFileSync(log, "utf8").trim().split("\n").map((l) => JSON.parse(l));
  }

  close(): Promise<number | null> {
    if (this.proc.exitCode !== null) return Promise.resolve(this.proc.exitCode);
    this.proc.stdin.end();
    return new Promise((resolve) => this.proc.once("close", resolve));
  }
}

/** Starts edupi with a faux script, in a fresh temporary directory (also its cwd). */
export function startEdupi(script: unknown, ...args: string[]): RpcClient {
  const dir = mkdtempSync(join(tmpdir(), "edupi-test-"));
  writeFileSync(join(dir, "faux.json"), JSON.stringify(script));
  const proc = spawn(process.execPath, [BIN, "--mode", "rpc", "--faux", join(dir, "faux.json"),
    "--faux-log", join(dir, "faux-requests.jsonl"), ...args], { cwd: dir, env: { ...process.env, OPENROUTER_API_KEY: "" } });
  return new RpcClient(proc, dir);
}
