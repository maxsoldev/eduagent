// Mirrors pi packages/coding-agent/src/core/system-prompt.ts (pinned 16f5f0af4): the system prompt as
// named sections, in pi's order and text: preamble, tools, rules, addendum (APPEND_SYSTEM.md),
// project_context (AGENTS.md), skills, cwd; all but the preamble wrapped in a tag of their name.
// A later change is a system message with only the changed sections. edupi leaves out the <docs>
// section, forced prompts, hidden tools, extension sections and the PowerShell rules.
import { formatSkillsForPrompt, type Skill } from "./skills.ts";

export interface BuildSystemPromptOptions {
	/** Custom system prompt (SYSTEM.md): replaces the preamble, tools and rules. */
	customPrompt?: string;
	/** Tools to include in the prompt. Default: [read, bash, edit, write]. */
	selectedTools?: string[];
	/** One-line tool snippets keyed by tool name. */
	toolSnippets?: Record<string, string>;
	/** Guideline bullets contributed by each tool, keyed by tool name. */
	toolGuidelines?: Record<string, string[]>;
	/** Text appended from user configuration (APPEND_SYSTEM.md) before project context, skills and cwd. */
	appendSystemPrompt?: string;
	/** Working directory. */
	cwd: string;
	/** Pre-loaded context files (AGENTS.md). */
	contextFiles?: Array<{ path: string; content: string }>;
	/** Pre-loaded skills. */
	skills?: Skill[];
}

/** Ordered system prompt sections, keyed by name. They become SystemMessage.sections. */
export type SystemPromptSections = Record<string, string>;

function renderProjectContext(contextFiles: Array<{ path: string; content: string }>): string {
	return [
		"Project-specific instructions and guidelines:",
		...contextFiles.map(
			({ path, content }) => `<project_instructions path="${path}">\n${content}\n</project_instructions>`,
		),
	].join("\n\n");
}

/** The rules: a bash hint, each tool's guidelines in tool order, then pi's two closing rules, de-duplicated. */
function buildRules(selectedTools: string[], toolGuidelines: Record<string, string[]>): string {
	const rules: string[] = [];
	const seen = new Set<string>();
	const addRule = (rule: string): void => {
		const normalized = rule.trim();
		if (!normalized || seen.has(normalized)) return;
		seen.add(normalized);
		rules.push(normalized);
	};

	const hasBash = selectedTools.includes("bash");
	const hasGrep = selectedTools.includes("grep");
	const hasFind = selectedTools.includes("find");
	const hasLs = selectedTools.includes("ls");
	if (hasBash && !hasGrep && !hasFind && !hasLs) addRule("Use bash for file operations like ls, rg, find");

	for (const name of selectedTools) {
		for (const rule of toolGuidelines[name] ?? []) addRule(rule);
	}
	addRule("Be concise in your responses");
	addRule("Show file paths clearly when working with files");
	return rules.map((rule) => `- ${rule}`).join("\n");
}

/** Build the ordered, independently replaceable sections of the structured system prompt. */
export function buildSystemPromptSections(options: BuildSystemPromptOptions): SystemPromptSections {
	const selectedTools = options.selectedTools ?? ["read", "bash", "edit", "write"];
	const toolSnippets = options.toolSnippets ?? {};
	const contextFiles = options.contextFiles ?? [];
	const skills = options.skills ?? [];

	const promptSections: Record<string, string> = {};
	if (options.customPrompt) {
		promptSections.preamble = options.customPrompt;
	} else {
		promptSections.preamble =
			"You are an expert coding assistant operating inside pi, a coding agent harness. You help users by reading files, executing commands, editing code, and writing new files.";
		const visibleTools = selectedTools.filter((name) => !!toolSnippets[name]);
		const tools =
			visibleTools.length > 0 ? visibleTools.map((name) => `- ${name}: ${toolSnippets[name]}`).join("\n") : "(none)";
		promptSections.tools = `${tools}\n\nIn addition to the tools above, you may have access to other custom tools depending on the project.`;
		promptSections.rules = buildRules(selectedTools, options.toolGuidelines ?? {});
		// pi adds its <docs> section here; edupi leaves it out.
	}

	if (options.appendSystemPrompt) promptSections.addendum = options.appendSystemPrompt;
	if (contextFiles.length > 0) promptSections.project_context = renderProjectContext(contextFiles);
	// The model loads a skill with a tool, so skills are listed only if it has read or bash.
	const skillFileReadTool = (["read", "bash"] as const).find((tool) => selectedTools.includes(tool));
	if (skillFileReadTool && skills.length > 0) {
		const skillsPrompt = formatSkillsForPrompt(skills, skillFileReadTool).trim();
		if (skillsPrompt) promptSections.skills = skillsPrompt;
	}
	promptSections.cwd = options.cwd.replace(/\\/g, "/");

	const sections: SystemPromptSections = { preamble: promptSections.preamble };
	for (const [name, content] of Object.entries(promptSections)) {
		if (name !== "preamble") sections[name] = `<${name}>\n${content}\n</${name}>`;
	}
	return sections;
}

/**
 * Diff the sections the model currently has (replayed from the transcript) against the desired
 * ones. Returns a SystemMessage.sections patch (changed -> new text, removed -> null), or
 * undefined when nothing changed.
 */
export function diffSystemPromptSections(
	previous: Record<string, string | null>,
	current: SystemPromptSections,
): Record<string, string | null> | undefined {
	const patch: Record<string, string | null> = {};
	for (const [name, text] of Object.entries(current)) {
		if (previous[name] !== text) patch[name] = text;
	}
	for (const name of Object.keys(previous)) {
		if (current[name] === undefined) patch[name] = null;
	}
	return Object.keys(patch).length > 0 ? patch : undefined;
}
