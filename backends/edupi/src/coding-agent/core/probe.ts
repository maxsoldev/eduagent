// edupi only (pi has no probe): the hook points the core calls so the teaching extras can watch
// it, as educodex's core/probe.py. The core never imports the observe layer; src/observe/
// implements this interface, and main.ts passes the implementation in. Every hook is optional.
import type { AgentProbe } from "../../agent/types.ts";
import type { ResourceDiagnostic, Skill } from "./skills.ts";

/** What the session built for a run: all sections, and the patch that goes into the transcript. */
export interface PromptAssembledInfo {
  sections: Record<string, string>;
  /** True when the transcript had no prompt yet (a new session). */
  firstTurn: boolean;
  /** The changed sections (removed ones are null), or undefined when the model already has this prompt. */
  patch: Record<string, string | null> | undefined;
  /** The AGENTS.md files in the project_context section, in prompt order. */
  contextFiles: string[];
  /** The SYSTEM.md / APPEND_SYSTEM.md files used, if any. */
  customPromptFiles: { systemPrompt?: string; appendSystemPrompt?: string };
}

/** The resource loader's skill scan. */
export interface SkillsLoadedInfo {
  /** The scanned folders, in priority order. */
  roots: { path: string; scope: "user" | "project" }[];
  skills: Skill[];
  diagnostics: ResourceDiagnostic[];
  projectTrusted: boolean;
}

/**
 * All hook points. The lower layers cannot import this file, so their hooks are defined there:
 * the provider hooks (model request, stream event, model response) in ai/types.ts, the agent
 * loop hooks (tool dispatch, tool output) in agent/types.ts. Coding-agent hooks are added here.
 */
export interface Probe extends AgentProbe {
  /** Before a run: the system prompt for its requests (agent-session.ts _prepareRun). */
  promptAssembled?(info: PromptAssembledInfo): void;
  /** The skills found when the session's resources were loaded. */
  skillsLoaded?(info: SkillsLoadedInfo): void;
}
