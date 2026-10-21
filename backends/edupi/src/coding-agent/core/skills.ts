// Mirrors pi packages/coding-agent/src/core/skills.ts (pinned 16f5f0af4): finds skills, reads their
// SKILL.md frontmatter and formats the prompt's skills block: name, description and file path only;
// the model reads the file with the read tool when a task matches. Skills with
// `disable-model-invocation: true` stay out of the prompt (only /skill:name calls them).
// edupi leaves out the .gitignore/.ignore/.fdignore rules of pi's directory scan.
import { existsSync, readdirSync, readFileSync, realpathSync, statSync } from "node:fs";
import { basename, dirname, join, resolve, sep } from "node:path";
import { PROJECT_CONFIG_DIR_NAME } from "../config.ts";
import { parseFrontmatter } from "../utils/frontmatter.ts";

/** Max name length per spec */
const MAX_NAME_LENGTH = 64;

/** Max description length per spec */
const MAX_DESCRIPTION_LENGTH = 1024;

export interface SkillFrontmatter {
	name?: string;
	description?: string;
	"disable-model-invocation"?: boolean;
	[key: string]: unknown;
}

/** Where a resource came from (pi core/source-info.ts). scope: "user" (home) or "project" (cwd/.pi). */
export interface SourceInfo {
	path: string;
	source: string;
	scope: "user" | "project" | "temporary";
	origin: "top-level";
	baseDir?: string;
}

export interface Skill {
	name: string;
	description: string;
	filePath: string;
	baseDir: string;
	sourceInfo: SourceInfo;
	disableModelInvocation: boolean;
}

/** A warning about a skill file, or a name collision (pi core/diagnostics.ts). */
export interface ResourceDiagnostic {
	type: "warning" | "collision";
	message: string;
	path: string;
}

export interface LoadSkillsResult {
	skills: Skill[];
	diagnostics: ResourceDiagnostic[];
}

/** Validate skill name per Agent Skills spec. Returns the error messages (empty if valid). */
function validateName(name: string): string[] {
	const errors: string[] = [];
	if (name.length > MAX_NAME_LENGTH) errors.push(`name exceeds ${MAX_NAME_LENGTH} characters (${name.length})`);
	if (!/^[a-z0-9-]+$/.test(name))
		errors.push(`name contains invalid characters (must be lowercase a-z, 0-9, hyphens only)`);
	if (name.startsWith("-") || name.endsWith("-")) errors.push(`name must not start or end with a hyphen`);
	if (name.includes("--")) errors.push(`name must not contain consecutive hyphens`);
	return errors;
}

/** Validate description per Agent Skills spec. */
function validateDescription(description: unknown): string[] {
	const errors: string[] = [];
	if (typeof description !== "string" || description.trim() === "") errors.push("description is required");
	else if (description.length > MAX_DESCRIPTION_LENGTH)
		errors.push(`description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`);
	return errors;
}

function createSkillSourceInfo(filePath: string, baseDir: string, source: string): SourceInfo {
	const scope = source === "user" || source === "project" ? source : "temporary";
	return { path: filePath, source: "local", scope, origin: "top-level", baseDir };
}

// Load skills from a directory:
// - if a directory contains SKILL.md, it is a skill root: take it and do not recurse further
// - otherwise, load direct .md children in the root
// - recurse into subdirectories (not dot folders or node_modules) to find SKILL.md
export function loadSkillsFromDir(dir: string, source: string): LoadSkillsResult {
	return loadSkillsFromDirInternal(dir, source, true);
}

function loadSkillsFromDirInternal(dir: string, source: string, includeRootFiles: boolean): LoadSkillsResult {
	const skills: Skill[] = [];
	const diagnostics: ResourceDiagnostic[] = [];
	if (!existsSync(dir)) return { skills, diagnostics };

	try {
		const entries = readdirSync(dir, { withFileTypes: true });

		const skillFile = entries.find((entry) => entry.name === "SKILL.md");
		if (skillFile) {
			const fullPath = join(dir, skillFile.name);
			let isFile = skillFile.isFile();
			if (skillFile.isSymbolicLink()) {
				try {
					isFile = statSync(fullPath).isFile();
				} catch {
					isFile = false;
				}
			}
			if (isFile) {
				const result = loadSkillFromFile(fullPath, source);
				if (result.skill) skills.push(result.skill);
				diagnostics.push(...result.diagnostics);
				return { skills, diagnostics };
			}
		}

		for (const entry of entries) {
			if (entry.name.startsWith(".")) continue;
			if (entry.name === "node_modules") continue; // skip dependencies

			const fullPath = join(dir, entry.name);
			// For symlinks, check if they point to a directory and follow them
			let isDirectory = entry.isDirectory();
			let isFile = entry.isFile();
			if (entry.isSymbolicLink()) {
				try {
					const stats = statSync(fullPath);
					isDirectory = stats.isDirectory();
					isFile = stats.isFile();
				} catch {
					continue; // broken symlink
				}
			}

			if (isDirectory) {
				const subResult = loadSkillsFromDirInternal(fullPath, source, false);
				skills.push(...subResult.skills);
				diagnostics.push(...subResult.diagnostics);
				continue;
			}
			if (!isFile || !includeRootFiles || !entry.name.endsWith(".md")) continue;

			const result = loadSkillFromFile(fullPath, source);
			if (result.skill) skills.push(result.skill);
			diagnostics.push(...result.diagnostics);
		}
	} catch {}

	return { skills, diagnostics };
}

/** One skill file. A SKILL.md without a description is not loaded; a bad name only warns. */
function loadSkillFromFile(
	filePath: string,
	source: string,
): { skill: Skill | null; diagnostics: ResourceDiagnostic[] } {
	const diagnostics: ResourceDiagnostic[] = [];
	const isDeclaredSkill = basename(filePath) === "SKILL.md";

	let rawContent: string;
	try {
		rawContent = readFileSync(filePath, "utf-8");
	} catch (error) {
		const message = error instanceof Error ? error.message : "failed to read skill file";
		diagnostics.push({ type: "warning", message, path: filePath });
		return { skill: null, diagnostics };
	}

	let frontmatter: SkillFrontmatter;
	try {
		({ frontmatter } = parseFrontmatter<SkillFrontmatter>(rawContent));
	} catch (error) {
		if (isDeclaredSkill) {
			const message = error instanceof Error ? error.message : "failed to parse skill file";
			diagnostics.push({ type: "warning", message, path: filePath });
		}
		return { skill: null, diagnostics };
	}

	const description = frontmatter.description;
	const hasDescription = typeof description === "string" && description.trim() !== "";
	// A plain .md file without a description is just a file, not a skill.
	if (!isDeclaredSkill && !hasDescription) return { skill: null, diagnostics };

	const skillDir = dirname(filePath);
	for (const error of validateDescription(description))
		diagnostics.push({ type: "warning", message: error, path: filePath });

	// Use name from frontmatter, or fall back to parent directory name
	const frontmatterName = typeof frontmatter.name === "string" ? frontmatter.name : undefined;
	const name = frontmatterName || basename(skillDir);
	for (const error of validateName(name)) diagnostics.push({ type: "warning", message: error, path: filePath });

	// Still load the skill even with warnings, unless description is missing or empty.
	if (!hasDescription) return { skill: null, diagnostics };

	return {
		skill: {
			name,
			description,
			filePath,
			baseDir: skillDir,
			sourceInfo: createSkillSourceInfo(filePath, skillDir, source),
			disableModelInvocation: frontmatter["disable-model-invocation"] === true,
		},
		diagnostics,
	};
}

/**
 * Format skills for inclusion in a system prompt, in the XML format of the Agent Skills standard
 * (https://agentskills.io/integrate-skills). Skills with disableModelInvocation are left out.
 * `fileReadTool` names the tool that loads skill files.
 */
export function formatSkillsForPrompt(skills: Skill[], fileReadTool: "read" | "bash" = "read"): string {
	const visibleSkills = skills.filter((s) => !s.disableModelInvocation);
	if (visibleSkills.length === 0) return "";

	const lines = [
		"\n\nThe following skills provide specialized instructions for specific tasks.",
		fileReadTool === "read"
			? "Use the read tool to load a skill's file when the task matches its description."
			: "Use bash to load a skill's file when the task matches its description.",
		"When a skill file references a relative path, resolve it against the skill directory (parent of SKILL.md / dirname of the path) and use that absolute path in tool commands.",
		"",
		"<available_skills>",
	];
	for (const skill of visibleSkills) {
		lines.push("  <skill>");
		lines.push(`    <name>${escapeXml(skill.name)}</name>`);
		lines.push(`    <description>${escapeXml(skill.description)}</description>`);
		lines.push(`    <location>${escapeXml(skill.filePath)}</location>`);
		lines.push("  </skill>");
	}
	lines.push("</available_skills>");
	return lines.join("\n");
}

function escapeXml(str: string): string {
	return str
		.replace(/&/g, "&amp;")
		.replace(/</g, "&lt;")
		.replace(/>/g, "&gt;")
		.replace(/"/g, "&quot;")
		.replace(/'/g, "&apos;");
}

/** pi utils/paths.ts: the real path, or the path itself if it does not exist. */
function canonicalizePath(path: string): string {
	try {
		return realpathSync(path);
	} catch {
		return path;
	}
}

export interface LoadSkillsOptions {
	/** Working directory for project-local skills. */
	cwd: string;
	/** Agent config directory for global skills. */
	agentDir: string;
	/** Skill directories or files, in priority order: on a name collision the first one wins. */
	skillPaths: string[];
}

/**
 * Load skills from the given paths. A file seen twice (through a symlink) is skipped; a second
 * skill with the same name loses and gets a collision diagnostic.
 * pi's resource loader passes the auto-discovered folders as skillPaths (includeDefaults: false).
 */
export function loadSkills(options: LoadSkillsOptions): LoadSkillsResult {
	const userSkillsDir = join(resolve(options.agentDir), "skills");
	const projectSkillsDir = resolve(options.cwd, PROJECT_CONFIG_DIR_NAME, "skills");
	const skillMap = new Map<string, Skill>();
	const realPathSet = new Set<string>();
	const allDiagnostics: ResourceDiagnostic[] = [];
	const collisionDiagnostics: ResourceDiagnostic[] = [];

	function addSkills(result: LoadSkillsResult) {
		allDiagnostics.push(...result.diagnostics);
		for (const skill of result.skills) {
			const realPath = canonicalizePath(skill.filePath);
			if (realPathSet.has(realPath)) continue; // the same file again, via a symlink
			const existing = skillMap.get(skill.name);
			if (existing) {
				collisionDiagnostics.push({
					type: "collision",
					message: `name "${skill.name}" collision`,
					path: skill.filePath,
				});
			} else {
				skillMap.set(skill.name, skill);
				realPathSet.add(realPath);
			}
		}
	}

	const isUnderPath = (target: string, root: string): boolean =>
		target === root || target.startsWith(root.endsWith(sep) ? root : `${root}${sep}`);

	for (const rawPath of options.skillPaths) {
		const resolvedPath = resolve(options.cwd, rawPath);
		if (!existsSync(resolvedPath)) continue; // pi warns "skill path does not exist" for explicit paths only
		const source = isUnderPath(resolvedPath, userSkillsDir)
			? "user"
			: isUnderPath(resolvedPath, projectSkillsDir)
				? "project"
				: "path";
		const stats = statSync(resolvedPath);
		if (stats.isDirectory()) addSkills(loadSkillsFromDirInternal(resolvedPath, source, true));
		else if (stats.isFile() && resolvedPath.endsWith(".md")) {
			const result = loadSkillFromFile(resolvedPath, source);
			addSkills({ skills: result.skill ? [result.skill] : [], diagnostics: result.diagnostics });
		}
	}

	return { skills: Array.from(skillMap.values()), diagnostics: [...allDiagnostics, ...collisionDiagnostics] };
}
