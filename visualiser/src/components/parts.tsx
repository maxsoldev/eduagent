// Small building blocks shared by the generic chat and the backend-only components.
import { type ReactNode, useState } from "react";
import type { Entry } from "../view/model";

export function Status({ s }: { s: string }) {
	return <span className={`status ${s}`}>{s}</span>;
}

// A tool card whose body (arguments, output, diff) can be folded away; the header stays as a summary.
export function ToolCard({
	testId,
	className = "tool",
	head,
	children,
}: {
	testId: string;
	className?: string;
	head: ReactNode;
	children?: ReactNode;
}) {
	const [open, setOpen] = useState(true);
	return (
		<div className={`card ${className}${open ? "" : " collapsed"}`} data-testid={testId}>
			<button type="button" className="card-head" aria-expanded={open} onClick={() => setOpen(!open)}>
				<span className="chevron">{open ? "▾" : "▸"}</span>
				{head}
			</button>
			{open && children}
		</div>
	);
}

export function AssistantMessage({
	entry,
	children,
}: {
	entry: Extract<Entry, { kind: "assistant" }>;
	children?: ReactNode;
}) {
	return (
		<div className="msg agent" data-testid="agent-message">
			<div className="who">agent</div>
			<div className="text">
				{entry.text}
				{entry.streaming && <span className="cursor">▍</span>}
				{children}
			</div>
		</div>
	);
}
