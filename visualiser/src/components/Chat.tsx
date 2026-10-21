// The conversation, drawn from the neutral view model. Entries with a backend-only part are
// drawn by that adapter's components (NativeEntry); everything else is drawn here.
import { Fragment, useEffect, useRef } from "react";
import type { AdapterModule } from "../adapters/types";
import type { Approval, Entry, Json, Turn, View } from "../view/model";
import { AssistantMessage, Status, ToolCard } from "./parts";

export function Chat({
	turns,
	approvals,
	paused,
	module,
	onAnswer,
	onContinue,
	welcome,
}: {
	turns: Turn[];
	approvals: Approval[];
	paused: View["paused"];
	module: AdapterModule;
	onAnswer: (a: Approval, result: Json) => void;
	onContinue: () => void;
	welcome: string[];
}) {
	// Scroll only this container (scrollIntoView would also scroll the page and the grid).
	const box = useRef<HTMLDivElement>(null);
	const size = turns.reduce((n, t) => n + t.entries.length, 0);
	const last = turns[turns.length - 1]?.entries.at(-1);
	useEffect(() => {
		if (box.current) box.current.scrollTop = box.current.scrollHeight;
	}, [size, last, approvals.length, paused]);
	return (
		<div className="chat" data-testid="chat" ref={box}>
			{size === 0 && <Welcome lines={welcome} />}
			{turns.map((t, i) => (
				<Fragment key={t.id ?? `loose-${i}`}>
					{t.entries.map((e) => (
						<EntryView key={e.id} entry={e} module={module} />
					))}
					{t.status && t.status !== "running" && (
						<div className="turn-sep" data-testid="turn-sep">
							turn {t.status} · {((t.durationMs ?? 0) / 1000).toFixed(1)}s
						</div>
					)}
				</Fragment>
			))}
			{approvals.map((a) => (
				<module.ApprovalCard key={String(a.id)} approval={a} onAnswer={(r) => onAnswer(a, r)} />
			))}
			{paused && (
				<div className="paused" data-testid="paused">
					<div>
						<b>⏸ Paused</b> at <code>{paused.breakpoint}</code>{" "}
						<span className="muted">{JSON.stringify(paused.info)}</span>
					</div>
					<button className="primary" onClick={onContinue} data-testid="continue">
						Continue ▶
					</button>
				</div>
			)}
		</div>
	);
}

function Welcome({ lines }: { lines: string[] }) {
	return (
		<div className="welcome">
			<h2>Inside a coding agent</h2>
			<p>
				Send a task. On the right you can watch everything the harness does: how the prompt is assembled, the exact
				request to the model, every tool call.
			</p>
			<p className="muted">
				Try: <i>"Create hello.py that prints hi, then run it."</i>
			</p>
			{lines.map((l) => (
				<p key={l} className="muted">
					{l}
				</p>
			))}
		</div>
	);
}

function EntryView({ entry, module }: { entry: Entry; module: AdapterModule }) {
	const part = "part" in entry ? entry.part : undefined;
	if (part) return <module.NativeEntry entry={entry} part={part} />;
	switch (entry.kind) {
		case "user":
			return (
				<div className="msg user">
					<div className="who">you</div>
					<div className="text">
						{entry.text}
						{entry.skills.map((s) => (
							<span key={s.path} className="badge skill" title={s.path}>
								${s.name}
							</span>
						))}
					</div>
				</div>
			);
		case "assistant":
			return <AssistantMessage entry={entry} />;
		case "reasoning":
			return entry.summary.length ? (
				<details className="reasoning" open={entry.streaming}>
					<summary>reasoning summary</summary>
					{entry.summary.join("\n\n")}
				</details>
			) : null;
		case "tool":
			return <ToolCall entry={entry} />;
		case "compaction":
			return (
				<div className="turn-sep compaction" data-testid="compaction">
					⟲ context compacted{entry.streaming ? "…" : ""}
					{entry.reason ? ` (${entry.reason})` : ""}
				</div>
			);
		case "notice":
			return entry.source === "visualiser" ? (
				<pre className={`note${entry.level === "error" ? " bad" : ""}`} data-testid="note">
					{entry.text}
				</pre>
			) : (
				<div className="card error">⚠ {entry.text}</div>
			);
		default:
			return <pre className="small">{JSON.stringify(entry)}</pre>;
	}
}

// A shell command shows its command line and output; an MCP call its server.tool and arguments.
function ToolCall({ entry }: { entry: Extract<Entry, { kind: "tool" }> }) {
	const shell = entry.toolKind === "shell";
	const testId = shell ? "command" : entry.toolKind === "mcp" ? "mcp-call" : "tool-call";
	const badge = shell ? (
		<span className="badge exec">$</span>
	) : entry.toolKind === "mcp" ? (
		<span className="badge mcp">MCP</span>
	) : (
		<span className="badge exec">{entry.name}</span>
	);
	return (
		<ToolCard
			testId={testId}
			head={
				<>
					{badge}
					<code className="grow">{entry.title}</code>
					{entry.exitCode !== null && entry.exitCode !== undefined && (
						<span className="muted">exit {entry.exitCode}</span>
					)}
					<Status s={entry.status} />
				</>
			}
		>
			{!shell && <pre className="small">{JSON.stringify(entry.arguments)}</pre>}
			{entry.output && <pre className="out">{entry.output}</pre>}
			{entry.error && <pre className="out err">{entry.error}</pre>}
		</ToolCard>
	);
}
