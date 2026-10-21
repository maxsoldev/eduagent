// Mirrors pi packages/coding-agent/src/core/project-trust.ts and trust-manager.ts (pinned 16f5f0af4):
// is this project trusted? Files under <cwd>/.pi (skills, SYSTEM.md, ...) could come from anyone, so pi
// loads them only from a trusted project (AGENTS.md needs no trust). RPC mode cannot ask, so without
// --approve or a saved decision in <agentDir>/trust.json the project is not trusted.
// edupi leaves out the .agents/skills folders, extensions and the defaultProjectTrust setting.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PROJECT_CONFIG_DIR_NAME } from "../config.ts";
import { stripBom } from "../utils/frontmatter.ts";

/** The entries of <cwd>/.pi that make pi ask for trust. */
const TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES = [
	"settings.json",
	"mcp.json",
	"extensions",
	"skills",
	"prompts",
	"themes",
	"SYSTEM.md",
	"APPEND_SYSTEM.md",
] as const;

function normalizeCwd(cwd: string): string {
	try {
		return realpathSync(resolve(cwd));
	} catch {
		return resolve(cwd);
	}
}

/** True when cwd has project resources that need trust (entries under cwd/.pi). */
export function hasTrustRequiringProjectResources(cwd: string): boolean {
	const configDir = join(normalizeCwd(cwd), PROJECT_CONFIG_DIR_NAME);
	return TRUST_REQUIRING_PROJECT_CONFIG_RESOURCES.some((entry) => existsSync(join(configDir, entry)));
}

type TrustFile = Record<string, boolean | null | undefined>;

/** pi trust-manager.ts readTrustFile: a broken or invalid file is an error, not "no decision". */
function readTrustFile(path: string): TrustFile {
	if (!existsSync(path)) return {};
	let parsed: unknown;
	try {
		parsed = JSON.parse(stripBom(readFileSync(path, "utf-8")));
	} catch (error) {
		const message = error instanceof Error ? error.message : String(error);
		throw new Error(`Failed to read trust store ${path}: ${message}`);
	}
	if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
		throw new Error(`Invalid trust store ${path}: expected an object`);
	}
	const data: TrustFile = {};
	for (const [key, value] of Object.entries(parsed)) {
		if (value !== true && value !== false && value !== null) {
			throw new Error(`Invalid trust store ${path}: value for ${JSON.stringify(key)} must be true, false, or null`);
		}
		data[key] = value;
	}
	return data;
}

/** The saved decision for cwd or its nearest ancestor in <agentDir>/trust.json, else null. */
export function getSavedProjectTrust(agentDir: string, cwd: string): boolean | null {
	const data = readTrustFile(join(agentDir, "trust.json"));
	let currentDir = normalizeCwd(cwd);
	while (true) {
		const value = data[currentDir];
		if (value === true || value === false) return value;
		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) return null;
		currentDir = parentDir;
	}
}

/** pi's resolveProjectTrusted in a mode without UI (RPC): flag, then nothing to trust, then trust.json, else no. */
export function resolveProjectTrusted(options: { cwd: string; agentDir: string; trustOverride?: boolean }): boolean {
	if (options.trustOverride !== undefined) return options.trustOverride;
	if (!hasTrustRequiringProjectResources(options.cwd)) return true;
	// pi's default setting is "ask", and RPC mode cannot ask, so an unknown project is not trusted.
	return getSavedProjectTrust(options.agentDir, options.cwd) ?? false;
}
