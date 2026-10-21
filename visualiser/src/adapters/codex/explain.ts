// The Codex adapter's timeline texts: one short explanation per event, the educodex guide
// chapter and the Codex source file it mirrors (paths under codex-rs/ at the pinned commit).
// Keys are Codex method names; trace events are in educodex's trace/ namespace.
import type { Explainer, Info } from "../../view/explain";
import type { Json, TimelineEvent } from "../../view/model";
import { pct, usd } from "../../cost";

const EXPLAIN: Record<string, Info> = {
  "trace/toolsRegistered": { title: "Tools registered", category: "tools", chapter: "07", source: "core/src/tools/spec_plan.rs",
    text: "The tool list sent with every request. The model only knows a tool exists from its name, description and JSON schema." },
  "trace/promptAssembled": { title: "Prompt assembled", category: "prompt", chapter: "05", source: "core/src/session/world_state.rs",
    text: "The harness builds context fragments (permissions, AGENTS.md, environment). Only fragments that changed are appended, so earlier messages never change and the prompt cache keeps hitting." },
  "trace/historyChanged": { title: "History appended", category: "memory", chapter: "04", source: "core/src/context_manager/history.rs",
    text: "New items were appended to the conversation history. The whole history is resent on every request." },
  "trace/modelRequest": { title: "Model request", category: "model", chapter: "02", source: "core/src/client.rs",
    text: "POST /responses with the full history. store=false means the server keeps nothing; base instructions are the first developer message." },
  "trace/streamEvent": { title: "Stream event (SSE)", category: "model", chapter: "02", text: "One raw server-sent event from the streaming response." },
  "trace/modelResponse": { title: "Model response", category: "model", chapter: "02", source: "core/src/stream_events_utils.rs",
    text: "The streamed reply finished. Output items (reasoning, messages, tool calls) were recorded in history." },
  "trace/loopIteration": { title: "Loop decision", category: "loop", chapter: "04", source: "core/src/session/turn.rs#L424",
    text: "If the model asked for tools, run them and call the model again. If it only answered, the turn is over." },
  "trace/toolDispatch": { title: "Tool call", category: "tools", chapter: "03", source: "core/src/tools/router.rs",
    text: "The model asked the harness to run a tool. The router finds the handler by name." },
  "trace/toolOutput": { title: "Tool output", category: "tools", chapter: "07", source: "core/src/tools/context.rs",
    text: "What the model will see: formatted, and truncated in the middle if it is too long." },
  "trace/policyDecision": { title: "Policy decision", category: "guardrails", chapter: "09", source: "core/src/exec_policy.rs",
    text: "Allow (maybe inside the sandbox), ask the user, or forbid — decided by rules, a dangerous-command check, the approval policy and the sandbox mode." },
  "trace/sandboxCommand": { title: "Sandboxed command", category: "guardrails", chapter: "10", source: "sandboxing/src/seatbelt.rs",
    text: "The command is wrapped in macOS sandbox-exec. The OS, not the model, enforces where it can write and whether it can use the network." },
  "trace/sandboxDenied": { title: "Sandbox denial", category: "guardrails", chapter: "10", source: "sandboxing/src/denial.rs",
    text: "The OS blocked the command. The model sees the error and can retry with sandbox_permissions=require_escalated, which asks you." },
  "trace/approvalRequested": { title: "Approval requested", category: "guardrails", chapter: "09", source: "core/src/tools/approvals.rs",
    text: "The turn is paused. The server sent a JSON-RPC request to this UI and waits for your decision." },
  "trace/approvalResolved": { title: "Approval answered", category: "guardrails", chapter: "09", text: "Your decision went back to the core." },
  "trace/mcpToolsListed": { title: "MCP tools listed", category: "mcp", chapter: "12", source: "codex-mcp/src/tools.rs",
    text: "Raw tools/list result from an MCP server, exactly as the server describes its tools." },
  "trace/mcpToolExposed": { title: "MCP tools exposed", category: "mcp", chapter: "12", source: "core/src/tools/handlers/mcp.rs",
    text: "The same tools as the model sees them: one namespace tool mcp__<server>, names and schemas cleaned up." },
  "trace/mcpServerFailed": { title: "MCP server failed", category: "mcp", chapter: "12", text: "The server could not be started; its tools are not available." },
  "trace/compactionRequest": { title: "Compaction request", category: "memory", chapter: "15", source: "core/src/compact.rs",
    text: "The context is nearly full. The model is asked, with no tools, to write a handoff summary." },
  "trace/compacted": { title: "History compacted", category: "memory", chapter: "15", source: "core/src/compact.rs",
    text: "History was replaced by recent user messages + fresh context + the summary." },
  "trace/skillsLoaded": { title: "Skills scanned", category: "prompt", chapter: "14", source: "ext/skills/src/host_roots.rs",
    text: "The harness scanned the skill roots for SKILL.md files. Only name, description and path go into the prompt (the <skills_instructions> catalog); the model reads a SKILL.md itself when a task matches." },
  "trace/skillInjected": { title: "Skill injected", category: "prompt", chapter: "14", source: "ext/skills/src/fragments.rs",
    text: "You named a skill with $name, so the harness added its whole SKILL.md as a <skill> user message after your message." },
  "trace/memoryCandidates": { title: "Memory: session logs chosen", category: "memory", chapter: "17", source: "memories/write/src/phase1.rs",
    text: "Phase 1 picks recent session logs (not this thread) that changed since they were last read. At most two per run." },
  "trace/memoryExtractionRequest": { title: "Memory: phase-1 request", category: "memory", chapter: "17", source: "memories/write/src/phase1.rs",
    text: "One model call per session log, with no tools and a strict JSON schema: the filtered, redacted conversation in, a raw memory and a rollout summary out." },
  "trace/memoryExtracted": { title: "Memory: extracted", category: "memory", chapter: "17", source: "memories/write/src/phase1_output.rs",
    text: "The phase-1 result. Empty fields mean the model found nothing a future agent would act on (the \"no-op gate\")." },
  "trace/memoryConsolidationStarted": { title: "Memory: phase 2 starts", category: "memory", chapter: "17", source: "memories/write/src/phase2.rs",
    text: "The inputs changed (git diff of the memory folder), so a sub-agent now rewrites MEMORY.md and memory_summary.md. It can write only in the memory folder and has no network." },
  "trace/memoryAgent": { title: "Memory agent step", category: "memory", chapter: "17", source: "memories/write/src/phase2.rs",
    text: "A step of the phase-2 sub-agent. It is a normal educodex session with its own thread, tools and sandbox." },
  "trace/hook": { title: "Hook ran", category: "tools", chapter: "13", source: "hooks/", text: "A user-configured command ran at a fixed point in the loop." },
  "trace/pricing": { title: "Pricing", category: "model", chapter: "05",
    text: "Per-token prices from OpenRouter's /models list: input, cached input (≈10x cheaper), cache writes and output. educodex only: Codex shows tokens, not money." },
  "trace/cost": { title: "Request cost", category: "model", chapter: "05",
    text: "What the last request cost. Input tokens split into uncached, read from the prompt cache, and written to it. Because every request repeats the previous one as a prefix, most input is a cache hit." },
  "trace/paused": { title: "Paused (step mode)", category: "debug", text: "Step mode: the loop is waiting. Press Continue." },
  "trace/resumed": { title: "Resumed", category: "debug", text: "The loop continues." },
  "thread/started": { title: "thread/started", category: "protocol", chapter: "18", text: "A new conversation (thread) exists on the server." },
  "turn/started": { title: "turn/started", category: "protocol", chapter: "18", text: "One user message → one turn, which may contain many model calls." },
  "turn/completed": { title: "turn/completed", category: "protocol", chapter: "18", text: "The turn ended (completed, interrupted or failed)." },
  "item/started": { title: "item/started", category: "protocol", chapter: "18", text: "A UI-level item began (message, command, file change…)." },
  "item/completed": { title: "item/completed", category: "protocol", chapter: "18", text: "A UI-level item finished; this is its final state." },
  "turn/plan/updated": { title: "Plan updated", category: "tools", chapter: "07", source: "core/src/tools/handlers/plan.rs", text: "The model called update_plan." },
  "thread/tokenUsage/updated": { title: "Token usage", category: "model", chapter: "02", text: "Tokens used by the last request." },
  "thread/compacted": { title: "thread/compacted", category: "memory", chapter: "15", text: "Compaction finished." },
  error: { title: "Error", category: "protocol", text: "The turn failed." },
};

const method = (e: Pick<TimelineEvent, "name" | "trace">) => (e.trace ? `trace/${e.name}` : e.name);

function info(e: Pick<TimelineEvent, "name" | "trace">): Info {
  return EXPLAIN[method(e)] ?? { title: method(e), category: e.trace ? "debug" : "protocol", text: "" };
}

const NOISY = new Set(["item/agentMessage/delta", "item/commandExecution/outputDelta", "item/reasoning/summaryTextDelta", "trace/streamEvent"]);

function summary(e: TimelineEvent): string {
  const p = e.data;
  switch (method(e)) {
    case "trace/modelRequest": return `#${p.iteration} · ${p.body.input.length} input items · ${p.body.tools.length} tools · ~${p.inputTokensEstimate} tok`;
    case "trace/modelResponse": return `${p.outputItems.map((i: Json) => i.type).join(", ")} · ${p.usage?.total_tokens ?? "?"} tok · ${p.seconds}s`;
    case "trace/loopIteration": return `needs_follow_up=${p.needsFollowUp} → ${p.decision}`;
    case "trace/toolDispatch": return `${p.tool} ${p.input ? p.input.slice(0, 80) : JSON.stringify(p.arguments ?? {}).slice(0, 80)}`;
    case "trace/toolOutput": return `${p.tool} → ${p.tokens} tok`;
    case "trace/policyDecision": return `${p.tool}: ${p.decision}${p.sandboxed ? " (sandboxed)" : ""} — ${p.reason}`;
    case "trace/promptAssembled": return p.fragments.map((f: Json) => `${f.kind}${f.changed ? "+" : ""}`).join(" · ");
    case "trace/historyChanged": return `+${p.appended.length} → ${p.totalItems} items`;
    case "item/started": case "item/completed": return p.item.type;
    case "trace/toolsRegistered": return p.tools.map((t: Json) => t.name).join(", ");
    case "trace/compacted": return `${p.itemsBefore} → ${p.itemsAfter} items`;
    case "trace/paused": return p.breakpoint;
    case "trace/skillsLoaded": return `${p.skills.length} skills in ${p.roots.length} roots${p.errors.length ? ` · ${p.errors.length} errors` : ""}`;
    case "trace/skillInjected": return `$${p.name} · ${p.tokens} tok`;
    case "trace/memoryCandidates": return `${p.candidates.length} session log(s)`;
    case "trace/memoryExtractionRequest": return `thread ${p.sourceThreadId.slice(0, 8)} · ${p.body.model}`;
    case "trace/memoryExtracted": return `thread ${p.result.threadId.slice(0, 8)}: ${p.result.status}`;
    case "trace/memoryConsolidationStarted": return `${p.inputs} memories · ${p.changes.length} changed files`;
    case "trace/memoryAgent": return p.item ? `${p.item.type}${p.item.command ? `: ${p.item.command.slice(0, 70)}` : ""}` : p.agentMethod;
    case "trace/cost": return `${usd(p.last.billedUsd ?? p.last.usd?.total)} · ${pct(p.last.cacheHitRate)} of ${p.last.tokens.input} input tokens cached · session ${usd(p.total.billedUsd ?? p.total.usd?.total)}`;
    case "trace/pricing": return p.pricing ? `input $${p.pricing.perMillionTokens.prompt}/M · cached $${p.pricing.perMillionTokens.cache_read}/M · output $${p.pricing.perMillionTokens.completion}/M` : "no pricing";
    default: return "";
  }
}

export const codexExplainer: Explainer = { info, summary, noisy: (e) => NOISY.has(method(e)) };
