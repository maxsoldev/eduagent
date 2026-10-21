// Mirrors pi packages/coding-agent/src/core/skills.ts (pinned 16f5f0af4): finds skills, reads their
// SKILL.md frontmatter and formats the prompt's skills block: name, description and file path only;
// the model reads the file with the read tool when a task matches. Skills with
// `disable-model-invocation: true` stay out of the prompt (only /skill:name calls them).
// edupi leaves out pi's ignore-file rules, symlinked skill folders and unreadable-file warnings.
import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";
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
	scope: "user" | "project";
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

/** A skill folder and its scope. */
export interface SkillRoot {
	path: string;
	scope: "user" | "project";
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
	if (typeof description !== "string" || description.trim() === "") return ["description is required"];
	if (description.length > MAX_DESCRIPTION_LENGTH)
		return [`description exceeds ${MAX_DESCRIPTION_LENGTH} characters (${description.length})`];
	return [];
}

/**
 * Load skills from a directory:
 * - if a directory contains SKILL.md, it is a skill root: take it and do not recurse further
 * - otherwise, load direct .md children in the root
 * - recurse into subdirectories (not dot folders or node_modules) to find SKILL.md
 */
function loadSkillsFromDirInternal(dir: string, root: SkillRoot, includeRootFiles: boolean): LoadSkillsResult {
	const result: LoadSkillsResult = { skills: [], diagnostics: [] };
	const add = (file: { skill: Skill | null; diagnostics: ResourceDiagnostic[] }) => {
		if (file.skill) result.skills.push(file.skill);
		result.diagnostics.push(...file.diagnostics);
	};

	const entries = readdirSync(dir, { withFileTypes: true });
	if (entries.some((entry) => entry.name === "SKILL.md" && entry.isFile())) {
		add(loadSkillFromFile(join(dir, "SKILL.md"), root));
		return result;
	}
	for (const entry of entries) {
		if (entry.name.startsWith(".") || entry.name === "node_modules") continue;
		const fullPath = join(dir, entry.name);
		if (entry.isDirectory()) {
			const sub = loadSkillsFromDirInternal(fullPath, root, false);
			result.skills.push(...sub.skills);
			result.diagnostics.push(...sub.diagnostics);
		} else if (entry.isFile() && includeRootFiles && entry.name.endsWith(".md")) {
			add(loadSkillFromFile(fullPath, root));
		}
	}
	return result;
}

/** One skill file. A SKILL.md without a description is not loaded; a bad name only warns. */
function loadSkillFromFile(filePath: string, root: SkillRoot): { skill: Skill | null; diagnostics: ResourceDiagnostic[] } {
	const diagnostics: ResourceDiagnostic[] = [];
	const { frontmatter } = parseFrontmatter<SkillFrontmatter>(readFileSync(filePath, "utf-8"));
	const description = frontmatter.description;
	const hasDescription = typeof description === "string" && description.trim() !== "";
	// A plain .md file without a description is just a file, not a skill.
	if (basename(filePath) !== "SKILL.md" && !hasDescription) return { skill: null, diagnostics };

	const skillDir = dirname(filePath);
	for (const error of validateDescription(description))
		diagnostics.push({ type: "warning", message: error, path: filePath });

	// Use name from frontmatter, or fall back to parent directory name
	const name = (typeof frontmatter.name === "string" && frontmatter.name) || basename(skillDir);
	for (const error of validateName(name)) diagnostics.push({ type: "warning", message: error, path: filePath });

	// Still load the skill even with warnings, unless description is missing or empty.
	if (!hasDescription) return { skill: null, diagnostics };

	return {
		skill: {
			name,
			description,
			filePath,
			baseDir: skillDir,
			// pi package-manager.ts addAutoDiscoveredResources: source "auto", baseDir = the agent dir or <cwd>/.pi.
			sourceInfo: { path: filePath, source: "auto", scope: root.scope, origin: "top-level", baseDir: dirname(root.path) },
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

/**
 * Load skills from the given folders, in priority order: a second skill with the same name loses
 * and gets a collision diagnostic. pi's resource loader passes the auto-discovered folders.
 */
export function loadSkills(roots: SkillRoot[]): LoadSkillsResult {
	const skillMap = new Map<string, Skill>();
	const allDiagnostics: ResourceDiagnostic[] = [];
	const collisionDiagnostics: ResourceDiagnostic[] = [];

	for (const root of roots) {
		if (!existsSync(root.path)) continue;
		const result = loadSkillsFromDirInternal(root.path, root, true);
		allDiagnostics.push(...result.diagnostics);
		for (const skill of result.skills) {
			if (skillMap.has(skill.name)) {
				collisionDiagnostics.push({ type: "collision", message: `name "${skill.name}" collision`, path: skill.filePath });
			} else {
				skillMap.set(skill.name, skill);
			}
		}
	}

	return { skills: Array.from(skillMap.values()), diagnostics: [...allDiagnostics, ...collisionDiagnostics] };
}
