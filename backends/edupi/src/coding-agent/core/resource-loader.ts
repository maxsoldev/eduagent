// Mirrors pi packages/coding-agent/src/core/resource-loader.ts (pinned 16f5f0af4), the parts for the
// system prompt: AGENTS.md files and skills, loaded once per session. Skill folders, in priority
// order (pi package-manager.ts addAutoDiscoveredResources): <cwd>/.pi/skills, then <agentDir>/skills.
// edupi leaves out project trust (pi reads <cwd>/.pi only in a trusted project), SYSTEM.md and
// APPEND_SYSTEM.md, extensions, prompt templates, themes, packages and the .agents/skills folders.
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { PROJECT_CONFIG_DIR_NAME } from "../config.ts";
import { type LoadSkillsResult, loadSkills, type SkillRoot } from "./skills.ts";

export interface ContextFile {
	path: string;
	content: string;
}

/** The first existing file of AGENTS.override.md, AGENTS.md, AGENTS.MD, CLAUDE.md, CLAUDE.MD in dir. */
function loadContextFileFromDir(dir: string): ContextFile | null {
	const candidates = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
	for (const filename of candidates) {
		const filePath = join(dir, filename);
		if (existsSync(filePath)) return { path: filePath, content: readFileSync(filePath, "utf-8") };
	}
	return null;
}

/**
 * The context files in prompt order: the global one in the agent dir first, then one per folder
 * from the filesystem root down to cwd. pi walks all the way up; it does not stop at the git root.
 */
export function loadProjectContextFiles(options: { cwd: string; agentDir: string }): ContextFile[] {
	const contextFiles: ContextFile[] = [];
	const seenPaths = new Set<string>();

	const globalContext = loadContextFileFromDir(resolve(options.agentDir));
	if (globalContext) {
		contextFiles.push(globalContext);
		seenPaths.add(globalContext.path);
	}

	const ancestorContextFiles: ContextFile[] = [];
	let currentDir = resolve(options.cwd);
	while (true) {
		const contextFile = loadContextFileFromDir(currentDir);
		if (contextFile && !seenPaths.has(contextFile.path)) {
			ancestorContextFiles.unshift(contextFile); // parents go first
			seenPaths.add(contextFile.path);
		}
		const parentDir = dirname(currentDir);
		if (parentDir === currentDir) break;
		currentDir = parentDir;
	}

	contextFiles.push(...ancestorContextFiles);
	return contextFiles;
}

export class DefaultResourceLoader {
	private skills: LoadSkillsResult = { skills: [], diagnostics: [] };
	private skillRoots: SkillRoot[] = [];
	private agentsFiles: ContextFile[] = [];
	readonly cwd: string;
	readonly agentDir: string;

	constructor(options: { cwd: string; agentDir: string }) {
		this.cwd = options.cwd;
		this.agentDir = options.agentDir;
	}

	/** Reads every resource from disk. */
	reload(): void {
		this.skillRoots = [
			{ path: join(this.cwd, PROJECT_CONFIG_DIR_NAME, "skills"), scope: "project" },
			{ path: join(this.agentDir, "skills"), scope: "user" },
		];
		this.skills = loadSkills(this.skillRoots);
		this.agentsFiles = loadProjectContextFiles({ cwd: this.cwd, agentDir: this.agentDir });
	}

	getSkills(): LoadSkillsResult {
		return this.skills;
	}

	/** edupi: the skill folders that were scanned, in priority order. */
	getSkillRoots(): SkillRoot[] {
		return this.skillRoots;
	}

	getAgentsFiles(): { agentsFiles: ContextFile[] } {
		return { agentsFiles: this.agentsFiles };
	}
}
