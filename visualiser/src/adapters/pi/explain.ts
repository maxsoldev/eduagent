// The pi adapter's timeline texts: one short explanation per pi event and the pi source file
// that emits it (paths at the pinned commit, see view/harness.ts). Trace events come only from
// edupi (pi has none); their source is the pi code at the same step.

import { pct, usd } from "../../cost";
import type { Explainer, Info } from "../../view/explain";
import type { Json, TimelineEvent } from "../../view/model";

const LOOP = "packages/agent/src/agent-loop.ts";
const SESSION = "packages/coding-agent/src/core/agent-session.ts";

const EXPLAIN: Record<string, Info> = {
	agent_start: {
		title: "agent_start",
		category: "loop",
		chapter: "02",
		source: LOOP,
		text: "The agent loop starts for your prompt. One prompt is one run; steering and follow-up messages stay inside it.",
	},
	agent_end: {
		title: "agent_end",
		category: "loop",
		chapter: "02",
		source: LOOP,
		text: "The agent loop stopped: the model answered without tool calls and no message was queued.",
	},
	agent_settled: {
		title: "agent_settled",
		category: "loop",
		chapter: "02",
		source: SESSION,
		text: "The session is idle again, after retries, compaction and queued work. aborted=true if you stopped the run.",
	},
	turn_start: {
		title: "turn_start",
		category: "loop",
		chapter: "02",
		source: LOOP,
		text: "One turn: queued messages, one model call, then the tools it asked for.",
	},
	turn_end: {
		title: "turn_end",
		category: "loop",
		chapter: "02",
		source: LOOP,
		text: "The turn ended. If the model asked for tools, pi calls the model again with their results.",
	},
	message_start: {
		title: "message_start",
		category: "model",
		source: LOOP,
		text: "A message enters the context: the system prompt (first prompt only), your message, the model's reply or a tool result.",
	},
	message_update: {
		title: "message_update",
		category: "model",
		source: LOOP,
		text: "One streamed piece of the model's reply (text, thinking or tool-call arguments).",
	},
	message_end: {
		title: "message_end",
		category: "model",
		source: LOOP,
		text: "The message is complete. This is its final form, as pi stores it in the session file.",
	},
	tool_execution_start: {
		title: "Tool call",
		category: "tools",
		chapter: "04",
		source: LOOP,
		text: "pi runs the tool. By default all tool calls of one reply run in parallel.",
	},
	tool_execution_update: {
		title: "Tool output so far",
		category: "tools",
		chapter: "04",
		source: LOOP,
		text: "Partial output of a running tool.",
	},
	tool_execution_end: {
		title: "Tool result",
		category: "tools",
		chapter: "04",
		source: LOOP,
		text: "The tool finished. Ends come in completion order; the tool-result messages then follow in call order.",
	},
	queue_update: {
		title: "Queue update",
		category: "loop",
		chapter: "02",
		source: SESSION,
		text: "The steering and follow-up queues changed. Steering is delivered after the current tools; follow-ups when the agent would stop.",
	},
	compaction_start: {
		title: "Compaction starts",
		category: "memory",
		chapter: "07",
		source: "packages/coding-agent/src/core/compaction/compaction.ts",
		text: "pi asks the model to summarise the older messages. reason: manual (/compact), threshold (context nearly full) or overflow (the provider refused).",
	},
	compaction_end: {
		title: "Compaction ends",
		category: "memory",
		chapter: "07",
		source: "packages/coding-agent/src/core/compaction/compaction.ts",
		text: "The summary is stored as a compaction entry. The next request starts with it, then the kept recent messages.",
	},
	thinking_level_changed: {
		title: "Thinking level",
		category: "model",
		chapter: "02",
		source: SESSION,
		text: "The thinking level changed (clamped to what the model supports). The next request sends it as OpenRouter's reasoning effort.",
	},
	auto_retry_start: {
		title: "Retry",
		category: "model",
		source: SESSION,
		text: "The provider failed with a retryable error; pi waits and tries again.",
	},
	auto_retry_end: {
		title: "Retry ended",
		category: "model",
		source: SESSION,
		text: "The retry succeeded or pi gave up.",
	},
};

const PROVIDER = "packages/ai/src/api/openai-completions.ts";
const COMPACTION = "packages/coding-agent/src/core/compaction/compaction.ts";
const TOOLS = "packages/coding-agent/src/core/tools/index.ts";

// edupi's trace events (protocol/README.md section 6). Chapter 01 of the edupi guide is the provider API.
const TRACE: Record<string, Info> = {
	modelRequest: {
		title: "Model request",
		category: "model",
		chapter: "01",
		source: PROVIDER,
		text: "POST /chat/completions with the whole conversation as messages. The body is exactly what the OpenAI SDK sent to OpenRouter.",
	},
	streamEvent: {
		title: "Stream event (chunk)",
		category: "model",
		chapter: "01",
		source: PROVIDER,
		text: "One raw Chat Completions chunk. pi turns each delta into a message_update event.",
	},
	modelResponse: {
		title: "Model response",
		category: "model",
		chapter: "01",
		source: PROVIDER,
		text: "The stream ended. usage is pi's Usage, parsed from the last chunk; stopReason comes from finish_reason.",
	},
	loopIteration: {
		title: "Loop decision",
		category: "loop",
		chapter: "02",
		source: LOOP,
		text: "After the turn: continue if the reply called tools (needsFollowUp) or steering messages wait, else stop. tokens is the reply's usage.totalTokens. edupi only: pi has no such event.",
	},
	compactionRequest: {
		title: "Compaction request",
		category: "memory",
		chapter: "07",
		source: COMPACTION,
		text: "The summary request: pi's summarizer system prompt and one user message, the older conversation as text plus the checkpoint prompt (or the update prompt with the previous summary). A split turn makes a second request for the turn's first part.",
	},
	compacted: {
		title: "Context compacted",
		category: "memory",
		chapter: "07",
		source: COMPACTION,
		text: "The summary is saved as a compaction entry. messages is the context rebuilt from it: the summary, then the kept messages from firstKeptEntryId on.",
	},
	toolsRegistered: {
		title: "Tools registered",
		category: "tools",
		chapter: "04",
		source: TOOLS,
		text: "The tool specs in this request: pi's read, bash, edit and write as Chat Completions functions. pi declares them in the transcript (a system message's toolsAdded).",
	},
	toolDispatch: {
		title: "Tool call",
		category: "tools",
		chapter: "04",
		source: LOOP,
		text: "pi starts a tool call. All calls of one reply start first, then run at the same time (parallel is pi's default).",
	},
	toolOutput: {
		title: "Tool output",
		category: "tools",
		chapter: "04",
		source: LOOP,
		text: 'The text the model reads back as a role "tool" message. Details such as the edit\'s diff stay in the user interface.',
	},
	promptAssembled: {
		title: "Prompt assembled",
		category: "prompt",
		chapter: "03",
		source: "packages/coding-agent/src/core/system-prompt.ts",
		text: "pi's system prompt as named sections: preamble, tools, rules, AGENTS.md files (project_context), the skills list and the cwd. Only changed sections go into the transcript, as a system message; the first prompt of a session gets all of them.",
	},
	skillsLoaded: {
		title: "Skills loaded",
		category: "prompt",
		chapter: "05",
		source: "packages/coding-agent/src/core/skills.ts",
		text: "pi scanned <cwd>/.pi/skills (only in a trusted project) and its home's skills folder, once for the session. The prompt lists each skill's name, description and file; the model reads the file itself when it needs it.",
	},
	pricing: {
		title: "Pricing",
		category: "model",
		chapter: "09",
		source: "packages/ai/src/providers/openrouter.ts",
		text: "The model's prices, from OpenRouter's model list (pi's Model.cost, in USD per million tokens). pi prices every response with them (calculateCost).",
	},
	cost: {
		title: "Request cost",
		category: "model",
		chapter: "09",
		source: "packages/ai/src/models.ts",
		text: "What the last request cost: pi's usage.cost regrouped into uncached input, cache reads, cache writes and output, plus the session's total. edupi only: pi keeps the numbers in each assistant message.",
	},
	paused: {
		title: "Paused (step mode)",
		category: "debug",
		chapter: "09",
		source: LOOP,
		text: "edupi only: step mode stopped the pi loop at this checkpoint. The Context tab shows the exact next request. Press Continue (debug_continue).",
	},
	resumed: {
		title: "Resumed",
		category: "debug",
		chapter: "09",
		source: LOOP,
		text: "edupi only: the loop goes on after debug_continue (or an abort).",
	},
};

function info(e: Pick<TimelineEvent, "name" | "trace">): Info {
	return (
		(e.trace ? TRACE[e.name] : EXPLAIN[e.name]) || {
			title: e.name,
			category: e.trace ? "debug" : "protocol",
			text: "",
		}
	);
}

const NOISY = new Set(["message_update", "tool_execution_update"]);

function summary(e: TimelineEvent): string {
	const p: Json = e.data;
	switch (e.name) {
		case "message_start":
		case "message_end":
			return [p.message.role, p.message.stopReason !== "pending" && p.message.stopReason]
				.filter(Boolean)
				.join(" · ");
		case "message_update":
			return p.assistantMessageEvent.type;
		case "tool_execution_start":
			return `${p.toolName} ${JSON.stringify(p.args).slice(0, 80)}`;
		case "tool_execution_end":
			return `${p.toolName}${p.isError ? " · error" : ""}${p.durationMs !== undefined ? ` · ${p.durationMs} ms` : ""}`;
		case "agent_settled":
			return p.aborted ? "aborted" : "";
		case "queue_update":
			return `steering ${p.steering.length} · follow-up ${p.followUp.length}`;
		case "compaction_start":
			return p.reason;
		case "compaction_end":
			return `${p.reason}${p.result ? ` · ${p.result.tokensBefore} tokens before` : ""}${p.errorMessage ? ` · ${p.errorMessage}` : ""}`;
		case "thinking_level_changed":
			return p.level;
		case "compactionRequest":
			return e.trace ? `${p.reason} · ${p.tokensBefore} tokens before` : "";
		case "compacted":
			return e.trace
				? `${p.reason} · ${p.tokensBefore} → ${p.tokensAfter} tokens · ${p.messages.length} messages`
				: "";
		case "toolsRegistered":
			return e.trace ? p.tools.map((t: Json) => t.function?.name).join(", ") : "";
		case "toolDispatch":
			return e.trace
				? `${p.tool} ${JSON.stringify(p.arguments).slice(0, 80)}${p.parallel ? " · parallel" : ""}`
				: "";
		case "toolOutput":
			return e.trace ? `${p.tool}${p.isError ? " · error" : ""} → ${p.tokens} tok` : "";
		case "promptAssembled":
			return e.trace ? p.fragments.map((f: Json) => `${f.kind}${f.changed ? "+" : ""}`).join(" · ") : "";
		case "skillsLoaded":
			return e.trace
				? `${p.skills.length} skills in ${p.roots.length} folders${p.projectTrusted ? "" : " · project not trusted"}${p.errors.length ? ` · ${p.errors.length} warnings` : ""}`
				: "";
		case "loopIteration":
			return e.trace ? `needsFollowUp=${p.needsFollowUp} → ${p.decision}` : "";
		case "modelRequest":
			return e.trace ? `${p.body.messages.length} messages · ${p.body.model}` : "";
		case "paused":
		case "resumed":
			return e.trace ? `${p.breakpoint}${p.info?.tool ? ` · ${p.info.tool}` : ""}` : "";
		case "pricing":
			return e.trace
				? p.pricing
					? `input $${p.pricing.perMillionTokens.prompt}/M · cached $${p.pricing.perMillionTokens.cache_read}/M · output $${p.pricing.perMillionTokens.completion}/M`
					: "no pricing"
				: "";
		case "cost":
			return e.trace
				? `${usd(p.last.billedUsd ?? p.last.usd?.total)} · ${pct(p.last.cacheHitRate)} of ${p.last.tokens.input} input tokens cached · session ${usd(p.total.billedUsd ?? p.total.usd?.total)}`
				: "";
		case "modelResponse":
			return e.trace ? `${p.stopReason} · ${p.usage.input} in / ${p.usage.output} out · ${p.seconds}s` : "";
		default:
			return "";
	}
}

export const piExplainer: Explainer = {
	info,
	summary,
	noisy: (e) => (e.trace ? e.name === "streamEvent" : NOISY.has(e.name)),
};
