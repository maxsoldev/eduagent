// `pnpm eduagent`: start the launcher. Mirrors no harness file; see docs/adr/0002-launcher-with-stdio-backends.md.
//   --config FILE   backend list, relative to launcher/ (default backends.json)
//   --port N        default 8765
//   --cwd DIR       default directory for new viewers (default: where you ran pnpm)
import { existsSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseArgs } from "node:util";
import { loadBackends } from "./config.ts";
import { stopAll } from "./pipe.ts";
import { createLauncher } from "./server.ts";

const LAUNCHER = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const REPO = resolve(LAUNCHER, "..");

const { values } = parseArgs({
	options: {
		config: { type: "string", default: "backends.json" },
		port: { type: "string", default: "8765" },
		cwd: { type: "string" },
	},
});

// A repo-root .env (OPENROUTER_API_KEY) reaches every backend, whatever directory a viewer picks.
if (existsSync(resolve(REPO, ".env"))) process.loadEnvFile(resolve(REPO, ".env"));

// pnpm runs scripts in the package folder; INIT_CWD is the folder where you typed the command.
const cwd = resolve(values.cwd ?? process.env.INIT_CWD ?? process.cwd());
const backends = loadBackends(resolve(LAUNCHER, values.config!), { ...process.env, REPO });
const server = createLauncher({
	backends,
	cwd,
	visualiserDir: resolve(REPO, "visualiser/dist"),
	guideDir: resolve(REPO, "docs/guide"),
});

server.listen(Number(values.port), "127.0.0.1", () => {
	console.error(`eduagent launcher on http://127.0.0.1:${values.port}/`);
	console.error(`backends: ${backends.map((b) => b.name).join(", ")} · default directory: ${cwd}`);
});

for (const signal of ["SIGINT", "SIGTERM"] as const) {
	process.on(signal, () => {
		stopAll();
		process.exit(0);
	});
}
