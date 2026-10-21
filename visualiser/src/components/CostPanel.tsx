import { useState } from "react";
import type { Json } from "../view/model";
import { pct, usd } from "../cost";

// The prompt cache, made visible: KPI tiles, the last request as two part-to-whole bars
// (tokens vs dollars, same four parts) and the cost of every request in this thread.
// Colours: a categorical palette validated for the dark surface (dataviz skill validator).
const PARTS = [
	{ key: "cached", label: "read from cache", color: "#3987e5", usd: "cachedInput" },
	{ key: "cacheWrite", label: "written to cache", color: "#d95926", usd: "cacheWrite" },
	{ key: "uncached", label: "uncached input", color: "#199e70", usd: "uncachedInput" },
	{ key: "output", label: "output", color: "#c98500", usd: "output" },
] as const;

type Readout = { title: string; value: string; detail: string } | null;

export function CostPanel({
	costs,
	pricing,
	next,
}: {
	costs: Json[];
	pricing: Json | null;
	next: { withCache: number | null; withoutCache: number | null };
}) {
	const [readout, setReadout] = useState<Readout>(null);
	// Remember whether the panel is folded (per browser), so it stays that way across turns.
	const [open, setOpenState] = useState(() => localStorage.getItem("educodex.costPanel") !== "closed");
	const setOpen = (v: boolean) => {
		setOpenState(v);
		localStorage.setItem("educodex.costPanel", v ? "open" : "closed");
	};
	const last = costs[costs.length - 1]?.last;
	const total = costs[costs.length - 1]?.total;
	if (!last) return null;
	const billed = last.billedUsd ?? last.usd?.total;

	return (
		<section
			className={open ? "cost-panel" : "cost-panel collapsed"}
			data-testid="context-cost"
			aria-label="Cost and prompt cache"
		>
			<button
				type="button"
				className="cost-head"
				aria-expanded={open}
				onClick={() => setOpen(!open)}
				data-testid="cost-toggle"
			>
				<span className="chevron">{open ? "▾" : "▸"}</span>
				<span className="split-title">Cost &amp; prompt cache</span>
				{!open && (
					<span className="muted small">
						last request {usd(billed)} · {pct(last.cacheHitRate)} cached · session{" "}
						{usd(total?.billedUsd ?? total?.usd?.total)}
					</span>
				)}
			</button>
			{open && (
				<>
					<div className="kpi-row">
						<Tile
							label="Last request"
							value={usd(billed)}
							sub={last.usd ? `${usd(last.usd.withoutCache)} without cache` : "billed by OpenRouter"}
						/>
						<Tile
							label="Read from cache"
							value={pct(last.cacheHitRate)}
							sub={`${last.tokens.cached.toLocaleString()} of ${last.tokens.input.toLocaleString()} input tokens`}
							meter={last.cacheHitRate}
						/>
						<Tile
							label="Saved by caching"
							value={usd(last.usd?.savedByCache)}
							sub={last.usd ? `${pct(last.usd.savedByCache / (last.usd.withoutCache || 1))} cheaper` : "–"}
							good
						/>
						<Tile
							label="Re-sending this context"
							value={next.withCache === null ? "–" : `≥ ${usd(next.withCache)}`}
							sub={`min. input of every next call · ${usd(next.withoutCache)} if the cache misses`}
							hint="Every model call resends the whole context. This prices what is already in it (earlier items as cache reads, items added since as cache writes). New input and the model's output come on top, so this is a floor that grows with every step."
						/>
						<Tile
							label="Session"
							value={usd(total?.billedUsd ?? total?.usd?.total)}
							sub={`${total?.requests ?? 0} requests · ${pct(total?.cacheHitRate ?? 0)} cached`}
						/>
					</div>

					<div className="split">
						<div className="split-title">Last request: where the tokens go, and where the money goes</div>
						<StackBar
							label="Tokens"
							values={PARTS.map((p) => last.tokens[p.key])}
							format={(n) => `${n.toLocaleString()} tok`}
							onReadout={setReadout}
						/>
						{last.usd && (
							<StackBar
								label="Cost"
								values={PARTS.map((p) => last.usd[p.usd])}
								format={usd}
								onReadout={setReadout}
							/>
						)}
						<div className="legend" role="list">
							{PARTS.map((p) => (
								<span key={p.key} role="listitem" className="legend-item">
									<span className="swatch" style={{ background: p.color }} />
									{p.label}
									{pricing && <span className="muted"> · ${rateFor(p.key, pricing)}/M</span>}
								</span>
							))}
						</div>
						<div className="readout" aria-live="polite">
							{readout ? (
								<>
									<b>{readout.value}</b> <span>{readout.title}</span>{" "}
									<span className="muted">{readout.detail}</span>
								</>
							) : (
								<span className="muted">
									Hover a segment for its value. Cached tokens are most of the input but a small part of the
									bill.
								</span>
							)}
						</div>
					</div>

					{costs.length > 1 && <PerRequest costs={costs} onReadout={setReadout} />}
				</>
			)}
		</section>
	);
}

function rateFor(key: string, pricing: Json): number {
	const r = pricing.perMillionTokens;
	return { cached: r.cache_read, cacheWrite: r.cache_write, uncached: r.prompt, output: r.completion }[key] ?? 0;
}

function Tile({
	label,
	value,
	sub,
	meter,
	good,
	hint,
}: {
	label: string;
	value: string;
	sub: string;
	meter?: number;
	good?: boolean;
	hint?: string;
}) {
	return (
		<div className="kpi" title={hint ? `${hint}\n\n${sub}` : sub}>
			<div className="kpi-label">{label}</div>
			<div className={good ? "kpi-value good" : "kpi-value"}>{value}</div>
			{meter !== undefined && (
				<div className="meter" role="meter" aria-valuemin={0} aria-valuemax={1} aria-valuenow={meter}>
					<div className="meter-fill" style={{ width: `${Math.round(meter * 100)}%` }} />
				</div>
			)}
			<div className="kpi-sub">{sub}</div>
		</div>
	);
}

// One horizontal 100% bar; segments separated by a 2px surface gap, labelled inside only when they fit.
function StackBar({
	label,
	values,
	format,
	onReadout,
}: {
	label: string;
	values: number[];
	format: (n: number) => string;
	onReadout: (r: Readout) => void;
}) {
	const sum = values.reduce((a, b) => a + (b || 0), 0) || 1;
	return (
		<div className="stack-row">
			<span className="stack-label">{label}</span>
			<div className="stack">
				{PARTS.map((p, i) => {
					const share = (values[i] || 0) / sum;
					if (share <= 0) return null;
					const show = () =>
						onReadout({
							title: `${p.label} (${label.toLowerCase()})`,
							value: format(values[i]),
							detail: `${pct(share)} of the request`,
						});
					return (
						<div
							key={p.key}
							className="seg"
							tabIndex={0}
							style={{ flexGrow: share, background: p.color }}
							aria-label={`${p.label}: ${format(values[i])}, ${pct(share)}`}
							onPointerEnter={show}
							onFocus={show}
							onPointerLeave={() => onReadout(null)}
							onBlur={() => onReadout(null)}
						>
							{share > 0.16 && <span className="seg-label">{pct(share)}</span>}
						</div>
					);
				})}
			</div>
		</div>
	);
}

// Cost of each request: one series, so emphasis (latest in accent, the rest grey) rather than colours.
function PerRequest({ costs, onReadout }: { costs: Json[]; onReadout: (r: Readout) => void }) {
	const values = costs.map((c) => c.last.billedUsd ?? c.last.usd?.total ?? 0);
	const max = Math.max(...values, 1e-12);
	return (
		<div className="per-request">
			<div className="split-title">
				Cost per request <span className="muted">· max {usd(max)}</span>
			</div>
			<div className="columns">
				{costs.map((c, i) => {
					const show = () =>
						onReadout({
							title: `request #${i + 1}`,
							value: usd(values[i]),
							detail: `${pct(c.last.cacheHitRate)} cached · ${c.last.tokens.input.toLocaleString()} in / ${c.last.tokens.output.toLocaleString()} out`,
						});
					return (
						<div
							key={i}
							className="col-slot"
							tabIndex={0}
							aria-label={`request ${i + 1}: ${usd(values[i])}`}
							onPointerEnter={show}
							onFocus={show}
							onPointerLeave={() => onReadout(null)}
							onBlur={() => onReadout(null)}
						>
							<div
								className={i === costs.length - 1 ? "col latest" : "col"}
								style={{ height: `${Math.max(3, (100 * values[i]) / max)}%` }}
							/>
						</div>
					);
				})}
			</div>
			<div className="columns-axis">
				{costs.map((_, i) => (
					<span key={i}>#{i + 1}</span>
				))}
			</div>
		</div>
	);
}
