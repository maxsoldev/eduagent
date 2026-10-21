// edupi only: the Tracer turns the core's probe calls into trace events, as educodex's
// observe/tracer.py does. pi has no trace events. edupi sends them in pi's type-tagged style,
// {type: "trace", name, ...payload}, on the same stdout as the RPC events. Names and payloads
// are the shared trace vocabulary in protocol/README.md section 6.
import type { AgentMessage, AgentToolCall, AgentToolResult, Checkpoint, LoopIteration } from "../agent/types.ts";
import type { AssistantMessage, ModelCost } from "../ai/types.ts";
import { contentText } from "../ai/utils/transcript.ts";
import type { CompactionResult } from "../coding-agent/core/compaction/compaction.ts";
import type { Probe, PromptAssembledInfo, SkillsLoadedInfo } from "../coding-agent/core/probe.ts";
import { addTotals, type CostTotal, costBreakdown, pricingJson } from "./pricing.ts";
import { Stepper } from "./stepper.ts";

/** Where each prompt section comes from (pi's file, or the files the user wrote). */
function sectionSource(name: string, info: PromptAssembledInfo): string {
	switch (name) {
		case "preamble":
			return info.customPromptFiles.systemPrompt ?? "system-prompt.ts";
		case "tools":
			return "system-prompt.ts + tool snippets";
		case "rules":
			return "system-prompt.ts + tool guidelines";
		case "addendum":
			return info.customPromptFiles.appendSystemPrompt ?? "APPEND_SYSTEM.md";
		case "project_context":
			return info.contextFiles.join(", ");
		case "skills":
			return "skills.ts formatSkillsForPrompt";
		case "cwd":
			return "process cwd";
		default:
			return name;
	}
}

const approxTokens = (text: string) => Math.ceil(text.length / 4);

export type TraceOutput = (message: object) => void;

export interface TracerOptions {
	/** A model's prices (pi's Model.cost), if OpenRouter's list has it. */
	findPricing?: (modelId: string) => ModelCost | undefined;
}

export class Tracer implements Probe {
	private output: TraceOutput | null = null;
	private started = 0; // when the current model request was sent (ms)
	private body: { messages?: unknown[]; tools?: unknown[] } = {}; // the current request's body
	private billedUsd: number | null = null; // OpenRouter's usage.cost of the current response
	private pricedModel: string | undefined; // the model the last pricing event was for
	private pricing: ModelCost | undefined;
	private totalCost: CostTotal | undefined; // this session's running cost

	private registeredTools = new Map<string | undefined, string>(); // the last tool specs sent, per session (JSON)
	/** Step mode; the debug_ commands drive it. */
	readonly stepper = new Stepper();

	constructor(private readonly options: TracerOptions = {}) {}

	sessionStarted() {
		this.totalCost = undefined;
	}

	/** RPC mode calls this once it owns stdout. Events before that are dropped. */
	connect(output: TraceOutput) {
		this.output = output;
	}

	private emit(name: string, payload: object) {
		this.output?.({ type: "trace", name, ...payload });
	}

	/** Step mode: pause here (paused, then resumed) until debug_continue or an abort. */
	async checkpoint(name: Checkpoint, info: Record<string, unknown>, signal?: AbortSignal) {
		if (!this.stepper.shouldPause(name)) return;
		if (await this.stepper.pause(() => this.emit("paused", { breakpoint: name, info }), signal))
			this.emit("resumed", { breakpoint: name });
	}

	/** Before the request: the tool specs the model gets, when they are new for this session (educodex's toolsRegistered). */
	modelRequest(request: { api: string; url: string; body: unknown }, sessionId?: string) {
		const tools = (request.body as { tools?: unknown[] }).tools ?? [];
		// A request without tools in a new session (a compaction's summary request) registers nothing.
		const isToolless = tools.length === 0 && !this.registeredTools.has(sessionId);
		if (!isToolless && JSON.stringify(tools) !== this.registeredTools.get(sessionId)) {
			this.registeredTools.set(sessionId, JSON.stringify(tools));
			this.emit("toolsRegistered", { tools });
		}
		this.ensurePricing((request.body as { model: string }).model);
		this.started = performance.now();
		this.body = request.body as typeof this.body;
		this.billedUsd = null;
		this.emit("modelRequest", request);
	}

	/** Once per model: its prices from OpenRouter's list, as educodex's pricing event. */
	private ensurePricing(model: string) {
		if (model === this.pricedModel) return;
		this.pricedModel = model;
		this.pricing = this.options.findPricing?.(model);
		this.emit("pricing", {
			model,
			pricing: this.pricing ? pricingJson(model, this.pricing) : null,
			source: "GET /models",
		});
	}

	streamEvent(event: unknown) {
		const cost = (event as { usage?: { cost?: unknown } }).usage?.cost; // OpenRouter's bill, in the last chunk
		if (typeof cost === "number") this.billedUsd = cost;
		this.emit("streamEvent", { event });
	}

	/** Also the response's cost (when the provider reported usage), and the session's running total. */
	modelResponse(message: AssistantMessage) {
		const { stopReason, errorMessage, responseId, content, usage } = message;
		const seconds = Math.round(performance.now() - this.started) / 1000;
		const cost = usage.totalTokens > 0 ? costBreakdown(usage, this.pricing, this.billedUsd) : undefined;
		this.emit("modelResponse", { stopReason, errorMessage, responseId, content, usage, seconds, cost });
		if (!cost) return;
		this.totalCost = addTotals(this.totalCost, cost);
		const toolsTokens = approxTokens(JSON.stringify({ tools: this.body.tools ?? [] }));
		this.emit("cost", {
			last: cost,
			total: this.totalCost,
			inputItems: this.body.messages?.length ?? 0,
			toolsTokens,
		});
	}

	toolDispatch({ toolCall, parallel }: { toolCall: AgentToolCall; parallel: boolean }) {
		this.emit("toolDispatch", { tool: toolCall.name, callId: toolCall.id, arguments: toolCall.arguments, parallel });
	}

	/** output is the text the model reads; tokens a rough count (4 bytes per token), as in educodex. */
	toolOutput({
		toolCall,
		result,
		isError,
		durationMs,
	}: {
		toolCall: AgentToolCall;
		result: AgentToolResult<unknown>;
		isError: boolean;
		durationMs?: number;
	}) {
		const output = contentText(result.content);
		const tokens = Math.floor((Buffer.byteLength(output, "utf-8") + 3) / 4);
		this.emit("toolOutput", { tool: toolCall.name, callId: toolCall.id, output, isError, durationMs, tokens });
	}

	/** tokens: the context size after the reply, from its usage (what pi's compaction check reads). */
	loopIteration({ iteration, needsFollowUp, message, decision }: LoopIteration) {
		const tokens = message.usage.totalTokens;
		this.emit("loopIteration", { iteration, needsFollowUp, tokens, stopReason: message.stopReason, decision });
	}

	/** One fragment per prompt section, as educodex's promptAssembled; changed = in this run's system message patch. */
	promptAssembled(info: PromptAssembledInfo) {
		const patch = info.patch ?? {};
		const fragments = Object.entries(info.sections).map(([kind, text]) => ({
			kind,
			role: "system",
			source: sectionSource(kind, info),
			text,
			tokens: approxTokens(text),
			changed: kind in patch,
		}));
		const removed = Object.keys(patch).filter((name) => patch[name] === null);
		this.emit("promptAssembled", { fragments, removed, firstTurn: info.firstTurn });
	}

	skillsLoaded(info: SkillsLoadedInfo) {
		this.emit("skillsLoaded", {
			roots: info.roots,
			skills: info.skills.map((s) => ({
				name: s.name,
				description: s.description,
				path: s.filePath,
				scope: s.sourceInfo.scope,
				disableModelInvocation: s.disableModelInvocation,
			})),
			errors: info.diagnostics.map((d) => ({ path: d.path, message: d.message })),
			projectTrusted: info.projectTrusted,
		});
	}

	compactionRequest(request: { reason: string; tokensBefore: number; body: unknown }) {
		this.emit("compactionRequest", request);
	}

	/** tokensAfter is pi's estimate of the rebuilt context (estimatedTokensAfter). */
	compacted(compaction: CompactionResult & { reason: string; messages: AgentMessage[] }) {
		const { reason, summary, firstKeptEntryId, tokensBefore, estimatedTokensAfter, details, messages } = compaction;
		this.emit("compacted", {
			reason,
			summary,
			firstKeptEntryId,
			tokensBefore,
			tokensAfter: estimatedTokensAfter,
			details,
			messages,
		});
	}
}
