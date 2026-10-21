import { useRef, useState } from "react";
import { usd } from "../cost";

// Context categories, in the fixed order of a categorical palette validated for the dark
// surface (dataviz skill validator). Each item keeps its own finer label; this is the grouping.
export const CTX_CATS = {
	tools: { label: "tool definitions", color: "#d95926" },
	base: { label: "base instructions", color: "#3987e5" },
	injected: { label: "developer & env context", color: "#199e70" },
	user: { label: "user messages", color: "#c98500" },
	assistant: { label: "assistant messages", color: "#d55181" },
	reasoning: { label: "reasoning", color: "#008300" },
	call: { label: "tool calls", color: "#e66767" },
	output: { label: "tool outputs", color: "#9085e9" },
	summary: { label: "compaction summary", color: "#8b9bb0" },
	other: { label: "other", color: "#64748b" },
} as const;
export type CtxCat = keyof typeof CTX_CATS;

// One slice of the context: an input item (index >= 0) or the tool definitions (index -1).
export type Segment = {
	index: number;
	label: string;
	cat: CtxCat;
	tokens: number;
	status?: string;
	cost: number | null;
	preview: string;
};
// What is highlighted: one item (hovered in the bar or the list) or a whole category.
export type Highlight = { item: number } | { cat: CtxCat } | null;

// Percent with one decimal below 10%, so small slices don't read as 0%.
const share = (x: number) => `${(100 * x).toFixed(x < 0.1 ? 1 : 0)}%`;

const lit = (hl: Highlight, s: Segment) => !hl || ("item" in hl ? hl.item === s.index : hl.cat === s.cat);

export function ContextBar({
	segments,
	total,
	scale,
	contextWindow,
	autoCompactLimit,
	zoom,
	hl,
	setHl,
	onSelect,
}: {
	segments: Segment[];
	total: number;
	scale: number;
	contextWindow: number;
	autoCompactLimit: number;
	zoom: boolean;
	hl: Highlight;
	setHl: (h: Highlight) => void;
	onSelect: (index: number) => void;
}) {
	const bar = useRef<HTMLDivElement>(null);
	const [tip, setTip] = useState<{ seg: Segment; x: number } | null>(null);
	const width = (n: number) => `${Math.max(0.3, (100 * n) / scale)}%`;
	// Centre the tooltip on the segment, but keep it inside the bar.
	const show = (seg: Segment, el: HTMLElement) => {
		const w = bar.current?.clientWidth ?? 0;
		const x = Math.min(Math.max(el.offsetLeft + el.offsetWidth / 2, 140), Math.max(w - 140, 140));
		setTip({ seg, x });
		setHl({ item: seg.index });
	};
	const hide = () => {
		setTip(null);
		setHl(null);
	};
	const shown = tip && hl && "item" in hl && hl.item === tip.seg.index ? tip.seg : null;
	return (
		<div className="ctx-bar-wrap">
			<div className="window-bar" ref={bar} onPointerLeave={hide}>
				{segments.map((s) => (
					<div
						key={s.index}
						className={lit(hl, s) ? "seg" : "seg dim"}
						tabIndex={0}
						data-testid="ctx-seg"
						style={{ width: width(s.tokens), background: CTX_CATS[s.cat].color }}
						aria-label={`${s.label}: ${s.tokens} tokens, ${share(s.tokens / total)} of context`}
						onPointerEnter={(e) => show(s, e.currentTarget)}
						onFocus={(e) => show(s, e.currentTarget)}
						onBlur={hide}
						onClick={() => onSelect(s.index)}
					/>
				))}
				{!zoom && (
					<div
						className="limit"
						style={{ left: `${(100 * autoCompactLimit) / contextWindow}%` }}
						title="auto-compact limit"
					/>
				)}
			</div>
			{shown && (
				<div className="ctx-tip" style={{ left: tip!.x }} data-testid="ctx-tip" role="tooltip">
					<div className="ctx-tip-head">
						<b>{shown.tokens.toLocaleString()} tok</b>
						<span>{share(shown.tokens / total)} of context</span>
						<span className="muted">· {share(shown.tokens / contextWindow)} of window</span>
					</div>
					<div className="ctx-tip-label">
						<span className="key-line" style={{ background: CTX_CATS[shown.cat].color }} />
						{shown.index >= 0 ? `#${shown.index} ` : ""}
						{shown.label}
						{shown.label !== CTX_CATS[shown.cat].label && (
							<span className="muted"> · {CTX_CATS[shown.cat].label}</span>
						)}
						{shown.status && (
							<span className={`cache-tag ${shown.status.replace(" ", "-")}`}>{shown.status}</span>
						)}
					</div>
					{shown.preview && <div className="ctx-tip-preview">{shown.preview}</div>}
					<div className="muted ctx-tip-hint">
						{shown.index >= 0 ? "click to open it below" : "sent before every input item"}
					</div>
				</div>
			)}
		</div>
	);
}

// Share of the used context per category: one row each, largest first. Cost is the estimated
// input cost of that category in the next request (null without pricing). Folds to a one-line summary.
export function CategoryBreakdown({
	segments,
	total,
	contextWindow,
	hl,
	setHl,
}: {
	segments: Segment[];
	total: number;
	contextWindow: number;
	hl: Highlight;
	setHl: (h: Highlight) => void;
}) {
	const [open, setOpenState] = useState(() => localStorage.getItem("educodex.ctxBreakdown") !== "closed");
	const setOpen = (v: boolean) => {
		setOpenState(v);
		localStorage.setItem("educodex.ctxBreakdown", v ? "open" : "closed");
	};
	const sums = new Map<CtxCat, { tokens: number; items: number; cost: number | null }>();
	for (const s of segments) {
		const v = sums.get(s.cat) ?? { tokens: 0, items: 0, cost: null };
		const cost = s.cost === null ? v.cost : (v.cost ?? 0) + s.cost;
		sums.set(s.cat, { tokens: v.tokens + s.tokens, items: v.items + 1, cost });
	}
	const rows = [...sums].sort((a, b) => b[1].tokens - a[1].tokens);
	const hasCost = segments.some((s) => s.cost !== null);
	const totalCost = segments.reduce((a, s) => a + (s.cost ?? 0), 0);
	return (
		<div
			className={open ? "ctx-breakdown" : "ctx-breakdown collapsed"}
			data-testid="ctx-breakdown"
			onPointerLeave={() => setHl(null)}
		>
			<button
				type="button"
				className="cost-head"
				aria-expanded={open}
				onClick={() => setOpen(!open)}
				data-testid="breakdown-toggle"
			>
				<span className="chevron">{open ? "▾" : "▸"}</span>
				<span className="split-title">By category</span>
				<span className="muted small">
					{share(total / contextWindow)} of the window used{hasCost && <> · ≈{usd(totalCost)} to resend</>}
				</span>
			</button>
			{open ? (
				<>
					{hasCost && (
						<div className="cat-row cat-head muted">
							<span />
							<span />
							<span />
							<span>share</span>
							<span>tokens</span>
							<span title="estimated input cost of this category in the next request">next cost</span>
						</div>
					)}
					{rows.map(([cat, v]) => {
						const c = CTX_CATS[cat];
						const active = hl && "cat" in hl && hl.cat === cat;
						return (
							<div
								key={cat}
								className={active ? "cat-row active" : "cat-row"}
								tabIndex={0}
								data-testid="cat-row"
								onPointerEnter={() => setHl({ cat })}
								onFocus={() => setHl({ cat })}
								onBlur={() => setHl(null)}
							>
								<span className="swatch" style={{ background: c.color }} />
								<span className="cat-label">
									{c.label}
									{v.items > 1 && <span className="muted"> ×{v.items}</span>}
								</span>
								<span className="cat-track">
									<span
										className="cat-fill"
										style={{ width: `${(100 * v.tokens) / total}%`, background: c.color }}
									/>
								</span>
								<span className="cat-pct">{share(v.tokens / total)}</span>
								<span className="cat-tok muted">{v.tokens.toLocaleString()} tok</span>
								{hasCost && (
									<span
										className="cat-tok muted"
										title={totalCost ? `${share((v.cost ?? 0) / totalCost)} of the cost` : undefined}
									>
										{usd(v.cost)}
									</span>
								)}
							</div>
						);
					})}
				</>
			) : (
				<div className="legend cat-summary">
					{rows.slice(0, 4).map(([cat, v]) => (
						<span key={cat} className="legend-item" onPointerEnter={() => setHl({ cat })}>
							<span className="swatch" style={{ background: CTX_CATS[cat].color }} />
							{CTX_CATS[cat].label} <b>{share(v.tokens / total)}</b>
						</span>
					))}
					{rows.length > 4 && <span className="muted">+{rows.length - 4} more</span>}
				</div>
			)}
		</div>
	);
}
