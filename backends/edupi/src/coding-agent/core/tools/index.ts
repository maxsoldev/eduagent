// Mirrors pi packages/coding-agent/src/core/tools/index.ts (pinned 16f5f0af4), createCodingTools:
// pi's default tool set. pi also has grep, find and ls (read-only tools, off by default); edupi
// leaves them out.
import type { AgentTool } from "../../../agent/types.ts";
import { createBashTool } from "./bash.ts";
import { createEditTool } from "./edit.ts";
import { createReadTool } from "./read.ts";
import { createWriteTool } from "./write.ts";

export { bashToolSystemPromptContribution } from "./bash.ts";
export { editToolSystemPromptContribution } from "./edit.ts";
export { readToolSystemPromptContribution } from "./read.ts";
export { writeToolSystemPromptContribution } from "./write.ts";

/** read, bash, edit, write: in this order the model sees them. Paths are relative to cwd. */
export function createCodingTools(cwd: string): AgentTool<any>[] {
  return [createReadTool(cwd), createBashTool(cwd), createEditTool(cwd), createWriteTool(cwd)];
}
