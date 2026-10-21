// Mirrors pi packages/coding-agent/src/core/tools/index.ts (pinned 16f5f0af4), createCodingTools:
// pi's default tool set. pi also has grep, find and ls (read-only tools, off by default); edupi
// leaves them out.
import type { AgentTool } from "../../../agent/types.ts";
import { type BashToolOptions, bashToolSystemPromptContribution, createBashTool } from "./bash.ts";
import { createEditTool, editToolSystemPromptContribution } from "./edit.ts";
import { createReadTool, readToolSystemPromptContribution } from "./read.ts";
import { createWriteTool, writeToolSystemPromptContribution } from "./write.ts";

/** Each tool's line in the prompt's <tools> section and its bullets in <rules> (pi: ToolDefinition promptSnippet, promptGuidelines). */
export const toolSystemPromptContributions: Record<string, { snippet: string; guidelines: readonly string[] }> = {
	read: readToolSystemPromptContribution,
	bash: bashToolSystemPromptContribution,
	edit: editToolSystemPromptContribution,
	write: writeToolSystemPromptContribution,
};

/** Per-tool options (pi has one entry per tool; edupi's bash is the only one with options). */
export interface ToolsOptions {
	bash?: BashToolOptions;
}

/** read, bash, edit, write: in this order the model sees them. Paths are relative to cwd. */
export function createCodingTools(cwd: string, options: ToolsOptions = {}): AgentTool<any>[] {
	return [createReadTool(cwd), createBashTool(cwd, options.bash), createEditTool(cwd), createWriteTool(cwd)];
}
