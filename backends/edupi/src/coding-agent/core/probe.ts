// edupi only (pi has no probe): the hook points the core calls so the teaching extras can watch
// it, as educodex's core/probe.py. The core never imports the observe layer; src/observe/
// implements this interface, and main.ts passes the implementation in. Every hook is optional.
import type { AgentMessage, AgentProbe } from "../../agent/types.ts";
import type { CompactionResult } from "./compaction/compaction.ts";
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
}

/** The resource loader's skill scan. */
export interface SkillsLoadedInfo {
	/** The scanned folders, in priority order. */
	roots: { path: string; scope: "user" | "project" }[];
	skills: Skill[];
	diagnostics: ResourceDiagnostic[];
}

/**
 * All hook points. The lower layers cannot import this file, so their hooks are defined there:
 * the provider hooks (model request, stream event, model response) in ai/types.ts, the agent
 * loop hooks (tool dispatch, tool output) in agent/types.ts. Coding-agent hooks are added here.
 */
export interface Probe extends AgentProbe {
	/** An AgentSession was made (at start and on new_session), as educodex's thread_started. */
	sessionStarted?(session: { sessionId: string }): void;
	/** Before a run: the system prompt for its requests (agent-session.ts _prepareRun). */
	promptAssembled?(info: PromptAssembledInfo): void;
	/** The skills found when the session's resources were loaded. */
	skillsLoaded?(info: SkillsLoadedInfo): void;
	/** A compaction summary request is about to be sent: its exact body (pi's onPayload sees it). */
	compactionRequest?(request: { reason: string; tokensBefore: number; body: unknown }): void | Promise<void>;
	/** The compaction entry was saved; `messages` is the context rebuilt from it. */
	compacted?(compaction: CompactionResult & { reason: string; messages: AgentMessage[] }): void | Promise<void>;
}
