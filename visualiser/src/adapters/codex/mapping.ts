// Codex app-server protocol -> neutral view model. This file and the other files in
// adapters/codex/ are the only places that know Codex's message and item shapes.
// Item types: codex-rs/app-server-protocol/src/protocol/v2.rs (ThreadItem).
import type { Entry, Json, ToolStatus, ViewAction } from "../../view/model";

export const PROTOCOL = "codex-app-server";

// One incoming JSON-RPC lite message -> view actions. Responses to our own requests map to
// nothing here; the client handles them (adapters/codex/client.ts).
export function codexActions(message: Json): ViewAction[] {
	if (!message.method) return [];
	if (message.id !== undefined)
		// a server -> client request: an approval or an MCP elicitation
		return [
			{
				type: "approval",
				approval: { id: message.id, part: { protocol: PROTOCOL, type: message.method, data: message.params } },
			},
		];
	const { _seq, _ts, ...p } = message.params ?? {};
	const method: string = message.method;
	const trace = method.startsWith("trace/");
	const event: ViewAction = {
		type: "event",
		event: {
			seq: _seq,
			ts: _ts !== undefined ? _ts * 1000 : undefined,
			name: trace ? method.slice("trace/".length) : method,
			trace,
			sessionId: p.threadId ?? p.thread?.id,
			data: p,
		},
	};
	return [event, ...notificationActions(method, p)];
}

function notificationActions(method: string, p: Json): ViewAction[] {
	switch (method) {
		case "thread/started":
			return [{ type: "session", id: p.thread.id }];
		case "turn/started":
			return [{ type: "turnStarted", id: p.turn.id }];
		case "turn/completed":
			return [{ type: "turnEnded", id: p.turn.id, status: p.turn.status, durationMs: p.turn.durationMs }];
		case "serverRequest/resolved":
			return [{ type: "approvalResolved", id: p.requestId }];
		case "item/started":
			return [{ type: "entry", entry: toEntry(p.item, true) }];
		case "item/completed":
			return [{ type: "entry", entry: toEntry(p.item, false) }];
		case "item/agentMessage/delta":
			return [{ type: "append", id: p.itemId, field: "text", delta: p.delta }];
		case "item/commandExecution/outputDelta":
			return [{ type: "append", id: p.itemId, field: "output", delta: p.delta }];
		case "item/reasoning/summaryTextDelta":
			return [{ type: "append", id: p.itemId, field: "summary", delta: p.delta, index: p.summaryIndex }];
		case "turn/plan/updated":
			return [
				{
					type: "entry",
					entry: {
						kind: "native",
						id: `plan-${p.turnId}-${planCount++}`,
						streaming: false,
						part: { protocol: PROTOCOL, type: "plan", data: { plan: p.plan, explanation: p.explanation } },
					},
				},
			];
		case "error":
			return [{ type: "notice", level: "error", source: "backend", text: p.error?.message ?? "error" }];
		default:
			return [];
	}
}

let planCount = 0;

// Codex item status: inProgress | completed | failed | declined.
const status = (s: string | undefined, streaming: boolean): ToolStatus =>
	streaming || s === "inProgress" || !s ? "running" : (s as ToolStatus);

function toEntry(item: Json, streaming: boolean): Entry {
	const native = { protocol: PROTOCOL, type: item.type, data: item };
	switch (item.type) {
		case "userMessage":
			return {
				kind: "user",
				id: item.id,
				text: (item.content ?? [])
					.filter((c: Json) => c.type === "text")
					.map((c: Json) => c.text)
					.join("\n"),
				skills: (item.content ?? [])
					.filter((c: Json) => c.type === "skill")
					.map((c: Json) => ({ name: c.name, path: c.path })),
			};
		case "agentMessage":
			return {
				kind: "assistant",
				id: item.id,
				text: item.text ?? "",
				streaming,
				part: item.memoryCitation ? native : undefined,
			};
		case "reasoning":
			return { kind: "reasoning", id: item.id, summary: item.summary ?? [], streaming };
		case "commandExecution":
			return {
				kind: "tool",
				id: item.id,
				name: "exec_command",
				toolKind: "shell",
				title: item.command,
				arguments: { command: item.command, cwd: item.cwd },
				output: item.aggregatedOutput ?? "",
				status: status(item.status, streaming),
				exitCode: item.exitCode,
				streaming,
			};
		case "fileChange":
			return {
				kind: "tool",
				id: item.id,
				name: "apply_patch",
				toolKind: "other",
				title: item.changes.map((c: Json) => c.path).join(", "),
				arguments: { changes: item.changes.map((c: Json) => ({ path: c.path, kind: c.kind.type })) },
				output: "",
				status: status(item.status, streaming),
				streaming,
				part: native,
			};
		case "mcpToolCall":
			return {
				kind: "tool",
				id: item.id,
				name: `${item.server}.${item.tool}`,
				toolKind: "mcp",
				title: `${item.server}.${item.tool}`,
				arguments: item.arguments,
				output: item.result
					? (item.result.content?.map((c: Json) => c.text).join("\n") ?? JSON.stringify(item.result))
					: "",
				error: item.error?.message,
				status: status(item.status, streaming),
				streaming,
			};
		case "contextCompaction":
			return { kind: "compaction", id: item.id, streaming };
		default: // memoryUpdate and any item type this UI does not know
			return { kind: "native", id: item.id, part: native, streaming };
	}
}
