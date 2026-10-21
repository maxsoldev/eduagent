// One viewer, one backend process (ADR 0002). Each WebSocket frame becomes one stdin line, and each
// stdout line becomes one frame. Nothing is parsed, so the Protocol tab shows exactly what the backend sent.
import { type ChildProcess, spawn } from "node:child_process";
import { createInterface } from "node:readline";
import type { WebSocket } from "ws";
import type { Backend } from "./config.ts";

const running = new Set<ChildProcess>();

export function pipe(ws: WebSocket, backend: Backend, cwd: string): void {
	// No shell: the command is an argv list, so the viewer's directory can never inject a command.
	const child = spawn(backend.command[0], backend.command.slice(1), {
		cwd,
		env: { ...process.env, ...backend.env },
		stdio: ["pipe", "pipe", "pipe"],
	});
	const tag = `[${backend.name} ${child.pid ?? "?"}]`;
	running.add(child);
	console.error(`${tag} started in ${cwd}`);

	createInterface({ input: child.stdout! }).on("line", (line) => ws.send(line));
	createInterface({ input: child.stderr! }).on("line", (line) => console.error(`${tag} ${line}`));
	child.stdin!.on("error", () => {}); // the process died; its exit is reported below
	ws.on("message", (data) => child.stdin!.write(`${data}\n`));
	ws.on("close", () => stop(child));

	child.on("error", (err) => closeWithError(ws, `${backend.name} failed to start: ${err.message}`));
	child.on("close", (code, signal) => {
		running.delete(child);
		const how = code !== null ? `code ${code}` : `signal ${signal}`;
		console.error(`${tag} exited with ${how}`);
		closeWithError(ws, `${backend.name} exited with ${how}`);
	});
}

/** Closes stdin (a stdio server stops at end of input), then sends SIGTERM and SIGKILL if it does not. */
export function stop(child: ChildProcess): void {
	if (child.exitCode !== null || child.signalCode !== null) return;
	child.stdin?.end();
	const term = setTimeout(() => child.kill("SIGTERM"), 3000);
	const kill = setTimeout(() => child.kill("SIGKILL"), 6000);
	child.once("exit", () => {
		clearTimeout(term);
		clearTimeout(kill);
	});
}

export function stopAll(): void {
	for (const child of running) child.kill("SIGTERM");
}

/** 1011 = "internal error". A close reason must fit in 123 bytes. */
function closeWithError(ws: WebSocket, reason: string) {
	if (ws.readyState === ws.OPEN) ws.close(1011, reason.slice(0, 120));
}
