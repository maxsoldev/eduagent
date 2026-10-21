// Mirrors pi packages/coding-agent/src/core/resource-loader.ts (pinned 16f5f0af4), the parts for the
// system prompt: AGENTS.md files, skills, SYSTEM.md and APPEND_SYSTEM.md, loaded once per session.
// Skill folders, in priority order (pi package-manager.ts addAutoDiscoveredResources):
// <cwd>/.pi/skills (only in a trusted project), then <agentDir>/skills. edupi leaves out extensions,
// prompt templates, themes, packages, the .agents/skills folders and nested git worktrees.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { PROJECT_CONFIG_DIR_NAME } from "../config.ts";
import { stripBom } from "../utils/frontmatter.ts";
import { type LoadSkillsResult, loadSkills } from "./skills.ts";

export interface ContextFile {
	path: string;
	content: string;
}

/** pi: the file's text; if it exists but cannot be read, a warning, and the input itself is the text. */
function resolvePromptInput(input: string | undefined, description: string): string | undefined {
	if (!input) return undefined;
	if (existsSync(input)) {
		try {
			return stripBom(readFileSync(input, "utf-8"));
		} catch (error) {
			console.error(`Warning: Could not read ${description} file ${input}: ${error}`);
			return input;
		}
	}
	return input;
}

/** The first existing file of AGENTS.override.md, AGENTS.md, AGENTS.MD, CLAUDE.md, CLAUDE.MD in dir. */
function loadContextFileFromDir(dir: string): ContextFile | null {
	const candidates = ["AGENTS.override.md", "AGENTS.md", "AGENTS.MD", "CLAUDE.md", "CLAUDE.MD"];
	for (const filename of candidates) {
		const filePath = join(dir, filename);
		if (existsSync(filePath)) {
			try {
				if (!statSync(filePath).isFile()) continue;
				return { path: filePath, content: stripBom(readFileSync(filePath, "utf-8")) };
			} catch (error) {
				console.error(`Warning: Could not read ${filePath}: ${error}`);
			}
		}
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

export interface DefaultResourceLoaderOptions {
	cwd: string;
	agentDir: string;
	/** Whether files from <cwd>/.pi may be loaded (see project-trust.ts). */
	projectTrusted: boolean;
}

export class DefaultResourceLoader {
	readonly cwd: string;
	readonly agentDir: string;
	readonly projectTrusted: boolean;
	private skills: LoadSkillsResult = { skills: [], diagnostics: [] };
	private skillRoots: { path: string; scope: "user" | "project" }[] = [];
	private agentsFiles: ContextFile[] = [];
	private systemPrompt: string | undefined;
	private appendSystemPrompt: string[] = [];
	private promptFiles: { systemPrompt?: string; appendSystemPrompt?: string } = {};

	constructor(options: DefaultResourceLoaderOptions) {
		this.cwd = options.cwd;
		this.agentDir = options.agentDir;
		this.projectTrusted = options.projectTrusted;
	}

	/** Reads every resource from disk. */
	reload(): void {
		const projectSkillsDir = join(this.cwd, PROJECT_CONFIG_DIR_NAME, "skills");
		this.skillRoots = [
			...(this.projectTrusted ? [{ path: projectSkillsDir, scope: "project" as const }] : []),
			{ path: join(this.agentDir, "skills"), scope: "user" as const },
		];
		this.updateSkillsFromPaths(this.skillRoots.map((root) => root.path));

		this.agentsFiles = loadProjectContextFiles({ cwd: this.cwd, agentDir: this.agentDir });

		const systemPromptFile = this.discoverSystemPromptFile();
		this.systemPrompt = resolvePromptInput(systemPromptFile, "system prompt");

		const appendFile = this.discoverAppendSystemPromptFile();
		const appendSystemPrompt = resolvePromptInput(appendFile, "append system prompt");
		this.appendSystemPrompt = appendSystemPrompt !== undefined ? [appendSystemPrompt] : [];

		this.promptFiles = { systemPrompt: systemPromptFile, appendSystemPrompt: appendFile };
	}

	getSkills(): LoadSkillsResult {
		return this.skills;
	}

	/** edupi: the skill folders that were scanned, in priority order. */
	getSkillRoots(): { path: string; scope: "user" | "project" }[] {
		return this.skillRoots;
	}

	/** edupi: the SYSTEM.md and APPEND_SYSTEM.md files in use, if any. */
	getPromptFiles(): { systemPrompt?: string; appendSystemPrompt?: string } {
		return this.promptFiles;
	}

	getAgentsFiles(): { agentsFiles: ContextFile[] } {
		return { agentsFiles: this.agentsFiles };
	}

	getSystemPrompt(): string | undefined {
		return this.systemPrompt;
	}

	getAppendSystemPrompt(): string[] {
		return this.appendSystemPrompt;
	}

	/**
	 * Each skill gets its folder's source info (pi package-manager.ts addAutoDiscoveredResources):
	 * source "auto", the folder's scope, baseDir = the agent dir or <cwd>/.pi.
	 */
	private updateSkillsFromPaths(skillPaths: string[]): void {
		const skillsResult = loadSkills({ cwd: this.cwd, agentDir: this.agentDir, skillPaths });
		this.skills = {
			...skillsResult,
			skills: skillsResult.skills.map((skill) => {
				const root = this.skillRoots.find((r) => skill.filePath.startsWith(`${r.path}${sep}`));
				if (!root) return skill;
				const sourceInfo = { ...skill.sourceInfo, source: "auto", scope: root.scope, baseDir: dirname(root.path) };
				return { ...skill, sourceInfo };
			}),
		};
	}

	/** <cwd>/.pi/SYSTEM.md if the project is trusted, else <agentDir>/SYSTEM.md. */
	private discoverSystemPromptFile(): string | undefined {
		const projectPath = join(this.cwd, PROJECT_CONFIG_DIR_NAME, "SYSTEM.md");
		if (this.projectTrusted && existsSync(projectPath)) return projectPath;
		const globalPath = join(this.agentDir, "SYSTEM.md");
		return existsSync(globalPath) ? globalPath : undefined;
	}

	/** <cwd>/.pi/APPEND_SYSTEM.md if the project is trusted, else <agentDir>/APPEND_SYSTEM.md. */
	private discoverAppendSystemPromptFile(): string | undefined {
		const projectPath = join(this.cwd, PROJECT_CONFIG_DIR_NAME, "APPEND_SYSTEM.md");
		if (this.projectTrusted && existsSync(projectPath)) return projectPath;
		const globalPath = join(this.agentDir, "APPEND_SYSTEM.md");
		return existsSync(globalPath) ? globalPath : undefined;
	}
}
