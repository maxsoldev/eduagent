// The backend list: launcher/backends.json, plus an optional git-ignored backends.local.json next to it.
// Each entry says what to run (command, env) and what the visualiser may show (harness, protocol, capabilities).
import { existsSync, readFileSync } from "node:fs";
import { type BackendInfo, CAPABILITIES } from "./api.ts";

export type Backend = BackendInfo & {
	command: string[]; // argv, run without a shell
	env?: Record<string, string>;
};

/** Reads `file` and `<file>.local.json`. A local entry replaces the shared entry with the same name. */
export function loadBackends(file: string, vars: Record<string, string | undefined>): Backend[] {
	const backends = read(file);
	const local = file.replace(/\.json$/, ".local.json");
	for (const entry of existsSync(local) ? read(local) : []) {
		const i = backends.findIndex((b) => b.name === entry.name);
		if (i >= 0) backends[i] = entry;
		else backends.push(entry);
	}
	return backends.map((b) => expand(b, vars));
}

function read(file: string): Backend[] {
	const { backends } = JSON.parse(readFileSync(file, "utf8"));
	for (const b of backends) {
		for (const key of ["name", "harness", "protocol"]) {
			if (typeof b[key] !== "string") throw new Error(`${file}: every backend needs a "${key}" string`);
		}
		if (!/^[a-z0-9-]+$/.test(b.name))
			throw new Error(`${file}: backend name "${b.name}" must be lowercase letters, digits or "-"`);
		if (!Array.isArray(b.command) || !b.command.length)
			throw new Error(`${file}: backend "${b.name}" needs a "command" list`);
		b.capabilities ??= [];
		const unknown = b.capabilities.filter((c: string) => !(CAPABILITIES as readonly string[]).includes(c));
		if (unknown.length)
			throw new Error(`${file}: backend "${b.name}" has unknown capabilities: ${unknown.join(", ")}`);
	}
	return backends;
}

/** Replaces ${VAR} in the command and env with a launcher variable (REPO) or an environment variable. */
function expand(b: Backend, vars: Record<string, string | undefined>): Backend {
	const sub = (s: string) =>
		s.replace(/\$\{(\w+)\}/g, (_, name) => {
			const value = vars[name];
			if (value === undefined) throw new Error(`backend "${b.name}": \${${name}} is not set`);
			return value;
		});
	const env = Object.fromEntries(Object.entries(b.env ?? {}).map(([k, v]) => [k, sub(v)]));
	return { ...b, command: b.command.map(sub), env };
}
