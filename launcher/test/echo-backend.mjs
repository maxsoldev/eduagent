// A stdio backend for the launcher tests: each stdin line comes back as {pid, cwd, line}.
// The line "exit" makes it exit with code 7, to test crash handling.
import { createInterface } from "node:readline";

console.error("echo backend ready");
for await (const line of createInterface({ input: process.stdin })) {
	if (line === "exit") process.exit(7);
	process.stdout.write(JSON.stringify({ pid: process.pid, cwd: process.cwd(), line }) + "\n");
}
