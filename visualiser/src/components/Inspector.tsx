import { useEffect, useMemo, useRef, useState } from "react";
import type { Json, RpcClient } from "../rpc";
import type { State, TraceEvent } from "../store";
import { CATEGORY_COLORS, codexLink, guideLink, info, type Category } from "../explain";
import { JsonView } from "./JsonView";
import { CostPanel } from "./CostPanel";
import { useStickToBottom } from "../useStickToBottom";
import { CategoryBreakdown, ContextBar, CTX_CATS, type CtxCat, type Highlight, type Segment } from "./ContextBar";
import { cacheStatus, nextRequestCost, pct, uncachedCost, usd } from "../cost";

const TABS = ["Timeline", "Context", "Requests", "Tools", "Guardrails", "Protocol"] as const;
type Tab = (typeof TABS)[number];
const NOISY = new Set(["item/agentMessage/delta", "item/commandExecution/outputDelta", "item/reasoning/summaryTextDelta", "trace/sseEvent"]);

export function Inspector({ state, rpc }: { state: State; rpc: RpcClient | null }) {
  const [tab, setTab] = useState<Tab>("Timeline");
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => { if (body.current) body.current.scrollTop = 0; }, [tab]); // tabs share one scroller
  // state.events spans every thread on this connection; per-thread tabs only show the current one.
  const threadEvents = useMemo(() => state.events.filter((e) => e.params.threadId === state.threadId), [state.events, state.threadId]);
  return (
    <div className="inspector">
      <div className="tabs">
        {TABS.map((t) => (
          <button key={t} className={t === tab ? "tab active" : "tab"} onClick={() => setTab(t)} data-testid={`tab-${t}`}>{t}</button>
        ))}
      </div>
      <div className={tab === "Context" || tab === "Timeline" ? "tab-body pinned" : "tab-body"} ref={body}>
        {tab === "Timeline" && <Timeline events={state.events} threadId={state.threadId} />}
        {tab === "Context" && <ContextView state={state} rpc={rpc} />}
        {tab === "Requests" && <Requests key={state.threadId} events={threadEvents} />}
        {tab === "Tools" && <Tools events={threadEvents} />}
        {tab === "Guardrails" && <Guardrails events={threadEvents} />}
        {tab === "Protocol" && <Protocol wire={state.wire} />}
      </div>
    </div>
  );
}

function Links({ method }: { method: string }) {
  const i = info(method);
  return (
    <span className="links">
      {i.chapter && <a href={guideLink(i.chapter)} target="_blank">guide ch.{i.chapter}</a>}
      {i.codex && <a href={codexLink(i.codex)} target="_blank">Codex: {i.codex}</a>}
    </span>
  );
}

function summarize(e: TraceEvent): string {
  const p = e.params;
  switch (e.method) {
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

function Timeline({ events, threadId }: { events: TraceEvent[]; threadId: string | null }) {
  const [showNoisy, setShowNoisy] = useState(false);
  const [hidden, setHidden] = useState<Set<Category>>(new Set());
  const [open, setOpen] = useState<number | null>(null);
  const follow = useStickToBottom(events[events.length - 1]?.seq ?? 0);
  const shown = events.filter((e) => (showNoisy || !NOISY.has(e.method)) && !hidden.has(info(e.method).category));
  const t0 = events[0]?.ts ?? 0;
  return (
    <div className="pinned-view">
      <div className="chips pinned-top">
        {(Object.keys(CATEGORY_COLORS) as Category[]).map((c) => (
          <button key={c} className={hidden.has(c) ? "chip off" : "chip"} style={{ borderColor: CATEGORY_COLORS[c] }}
            onClick={() => { const n = new Set(hidden); n.has(c) ? n.delete(c) : n.add(c); setHidden(n); }}>{c}</button>
        ))}
        <label className="muted small"><input type="checkbox" checked={showNoisy} onChange={(e) => setShowNoisy(e.target.checked)} /> streaming deltas</label>
      </div>
      <div className="scroll-list-wrap">
      <div className="timeline scroll-list" data-testid="timeline" ref={follow.ref} onScroll={follow.onScroll}>
        {shown.map((e) => {
          const i = info(e.method);
          return (
            <div key={e.seq} className={`t-row${e.params.threadId && e.params.threadId !== threadId ? " other-thread" : ""}${follow.isFresh(e.seq) ? " fresh" : ""}`}
              data-method={e.method}
              title={e.params.threadId && e.params.threadId !== threadId ? `thread ${e.params.threadId.slice(0, 8)} (not the current one)` : undefined}>
              <div className="t-head" onClick={() => setOpen(open === e.seq ? null : e.seq)}>
                <span className="t-time">{((e.ts - t0) / 1000).toFixed(2)}s</span>
                <span className="dot" style={{ background: CATEGORY_COLORS[i.category] }} />
                <span className="t-title">{i.title}</span>
                <span className="t-sum">{summarize(e)}</span>
              </div>
              {open === e.seq && (
                <div className="t-detail">
                  {i.text && <p className="explain">{i.text} <Links method={e.method} /></p>}
                  <code className="muted small">{e.method}</code>
                  <JsonView value={e.params} open={1} />
                </div>
              )}
            </div>
          );
        })}
      </div>
      {!follow.atBottom && <button className="to-latest" onClick={follow.toBottom} data-testid="timeline-to-latest">↓ latest</button>}
      </div>
    </div>
  );
}

// Label each input item by where it came from: this is the core idea of prompt assembly.
function classify(item: Json, index: number): { label: string; cat: CtxCat } {
  const text = item.content?.[0]?.text ?? "";
  if (item.type === "message") {
    if (index === 0 && item.role === "developer") return { label: "base instructions", cat: "base" };
    if (item.role === "developer") return { label: developerLabel(item), cat: "injected" };
    if (item.role === "user") {
      if (text.startsWith("# AGENTS.md") || text.startsWith("<environment_context>")) return { label: "context (AGENTS.md / env)", cat: "injected" };
      if (text.startsWith("<skill>")) return { label: `skill ${/<name>(.*?)<\/name>/.exec(text)?.[1] ?? ""} (SKILL.md)`, cat: "injected" };
      if (text.startsWith("Another language model started")) return { label: "compaction summary", cat: "summary" };
      return { label: "user", cat: "user" };
    }
    return { label: "assistant", cat: "assistant" };
  }
  if (item.type === "reasoning") return { label: "reasoning (encrypted)", cat: "reasoning" };
  if (item.type.endsWith("_output")) return { label: "tool output", cat: "output" };
  if (item.type.endsWith("call")) return { label: "tool call", cat: "call" };
  return { label: item.type, cat: "other" };
}

// The developer bundle holds several fragments, one per content part: name them all.
const DEV_PARTS: [string, string][] = [["## Memory", "memories"], ["<skills_instructions>", "skills"],
  ["<permissions", "permissions"], ["<collaboration_mode>", "collaboration mode"]];
function developerLabel(item: Json): string {
  const names = (item.content ?? []).map((p: Json) => DEV_PARTS.find(([prefix]) => (p.text ?? "").startsWith(prefix))?.[1] ?? "instructions");
  return `developer: ${names.join(" + ")}`;
}

// A short text snippet of an item, for the bar tooltip.
function preview(item: Json): string {
  const raw = item.content?.map((p: Json) => p.text ?? "").join(" ")
    ?? (item.type.endsWith("call") ? `${item.name ?? ""}(${item.arguments ?? item.input ?? ""})` : null)
    ?? (typeof item.output === "string" ? item.output : item.summary?.map((p: Json) => p.text).join(" ")) ?? "";
  const flat = String(raw).replace(/\s+/g, " ").trim();
  return flat.length > 160 ? flat.slice(0, 160) + "…" : flat;
}

const approxTokens = (v: Json) => Math.ceil(JSON.stringify(v).length / 4);

function ContextView({ state, rpc }: { state: State; rpc: RpcClient | null }) {
  const [ctx, setCtx] = useState<Json | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [zoom, setZoom] = useState(true);
  const [hl, setHl] = useState<Highlight>(null);
  const historyEvents = state.events.filter((e) => e.method === "trace/historyChanged").length;
  useEffect(() => {
    if (!rpc || !state.threadId) return;
    const t = setTimeout(() => rpc.request("debug/context/get", { threadId: state.threadId }).then(setCtx).catch(() => {}), 150);
    return () => clearTimeout(t);
  }, [rpc, state.threadId, historyEvents]);
  // The item list scrolls on its own and follows new items while it is scrolled to the bottom.
  const follow = useStickToBottom(ctx?.request.input.length ?? 0, state.threadId);
  if (!ctx) return <p className="muted">Start a thread to see its context.</p>;
  const input: Json[] = ctx.request.input;
  const sizes = input.map(approxTokens);
  const toolsTokens = approxTokens(ctx.request.tools);
  const total = sizes.reduce((a, b) => a + b, 0) + toolsTokens;
  // Zoomed: the bar spans what is used (so small items are visible); otherwise the whole window.
  const scale = zoom ? Math.max(total * 1.1, 1) : ctx.contextWindow;
  const last = state.costs[state.costs.length - 1] ?? null;
  const cache = cacheStatus(sizes, toolsTokens, last);
  const real = (t: number) => t * cache.scale; // estimate -> provider token count
  const nextCosts = input.map((_, i) => nextRequestCost(real(sizes[i]), cache.status[i], state.pricing));
  const nextTotal = state.pricing ? nextCosts.reduce((a: number, b) => a + (b ?? 0), 0)
    + (nextRequestCost(real(toolsTokens), last ? "cached" : "new", state.pricing) ?? 0) : null;
  const nextUncached = uncachedCost(real(total), state.pricing);
  const kinds = input.map(classify);
  const segments: Segment[] = [
    { index: -1, label: "tool definitions", cat: "tools", tokens: toolsTokens, status: last ? "cached" : undefined,
      cost: nextRequestCost(real(toolsTokens), last ? "cached" : "new", state.pricing),
      preview: ctx.request.tools.map((t: Json) => t.name ?? t.type).join(", ") },
    ...input.map((it, i) => ({ index: i, ...kinds[i], tokens: sizes[i], status: cache.status[i], cost: nextCosts[i], preview: preview(it) })),
  ];
  // Clicking a bar segment opens that item in the list below.
  const select = (i: number) => {
    if (i < 0) return;
    setOpen(i);
    requestAnimationFrame(() => document.querySelector(`[data-ctx-index="${i}"]`)?.scrollIntoView({ block: "nearest", behavior: "smooth" }));
  };
  return (
    <div className="pinned-view" data-testid="context-view">
      <div className="pinned-top">
      <p className="explain">This is <b>exactly</b> what the next request sends: the whole history, every time.
        Colours show where each item came from. <Links method="trace/promptAssembled" /></p>
      <ContextBar segments={segments} total={total} scale={scale} contextWindow={ctx.contextWindow}
        autoCompactLimit={ctx.autoCompactLimit} zoom={zoom} hl={hl} setHl={setHl} onSelect={select} />
      <div className="muted small">
        <label><input type="checkbox" checked={zoom} onChange={(e) => setZoom(e.target.checked)} /> zoom to used</label> · ~{total.toLocaleString()} of {ctx.contextWindow.toLocaleString()} tokens (estimate) · auto-compact at {ctx.autoCompactLimit.toLocaleString()} · {ctx.request.tools.length} tools (~{toolsTokens} tok)</div>
      <CategoryBreakdown segments={segments} total={total} contextWindow={ctx.contextWindow} hl={hl} setHl={setHl} />
      {last ? <CostPanel costs={state.costs} pricing={state.pricing} next={{ withCache: nextTotal, withoutCache: nextUncached }} />
        : <div className="cost-empty muted small">{state.events.some((e) => e.method === "trace/modelRequest" && e.params.threadId === state.threadId)
            ? <>The app server sent no cost data. It is probably older than this UI: restart <code>educodex app-server</code>.</>
            : <>Costs and the prompt cache appear here after the first request.</>}</div>}
      {last && <div className="muted small cost-note">Per-item costs below are estimates for the next request: the provider bills per request, so the total is spread over items by size. <i>cached</i> = inside the prefix the last request read from the cache.</div>}
      </div>
      <div className="scroll-list-wrap">
      <div className="ctx-list scroll-list" ref={follow.ref} onScroll={follow.onScroll} data-testid="ctx-list">
        {input.map((item, i) => {
          const c = kinds[i];
          const parts: Json[] | null = item.type === "message" ? item.content : null;
          const lit = hl && ("item" in hl ? hl.item === i : hl.cat === c.cat);
          return (
            <div key={i} className={`ctx-item${lit ? " lit" : ""}${follow.isFresh(i + 1) ? " fresh" : ""}`}
              data-testid="ctx-item" data-ctx-index={i}
              onPointerEnter={() => setHl({ item: i })} onPointerLeave={() => setHl(null)}>
              <div className="t-head" onClick={() => setOpen(open === i ? null : i)}>
                <span className="t-time">{i}</span>
                <span className="dot" style={{ background: CTX_CATS[c.cat].color }} />
                <span className="t-title">{c.label}</span>
                <span className="t-sum">{item.type}{item.role ? `/${item.role}` : ""}{parts && parts.length > 1 ? ` · ${parts.length} parts` : ""} · {sizes[i]} tok</span>
                <span className={`cache-tag ${cache.status[i].replace(" ", "-")}`} title="prompt cache status in the last request">{cache.status[i]}</span>
                {nextCosts[i] !== null && <span className="item-cost" title="estimated input cost of this item in the next request">{usd(nextCosts[i])}</span>}
              </div>
              {open === i && (parts ? parts.map((part: Json, j: number) => (
                <div key={j} className="part" data-testid="ctx-part">
                  <div className="part-head">part {j + 1} · type: <code>{part.type}</code> · ~{approxTokens(part)} tok</div>
                  {typeof part.text === "string" ? <pre>{part.text}</pre> : <JsonView value={part} open={1} />}
                </div>
              )) : <JsonView value={item} open={2} />)}
            </div>
          );
        })}
      </div>
      {!follow.atBottom && <button className="to-latest" onClick={follow.toBottom} data-testid="ctx-to-latest">↓ latest</button>}
      </div>
    </div>
  );
}

function Requests({ events }: { events: TraceEvent[] }) {
  const requests = events.filter((e) => e.method === "trace/modelRequest");
  const [sel, setSel] = useState<number>(-1);
  const index = sel < 0 ? requests.length - 1 : sel;
  const req = requests[index];
  const response = useMemo(() => {
    if (!req) return null;
    return events.find((e) => e.seq > req.seq && e.method === "trace/modelResponse") ?? null;
  }, [events, req]);
  if (!req) return <p className="muted">No model requests yet.</p>;
  const prev = requests[index - 1];
  const prevInput: Json[] = prev?.params.body.input ?? [];
  const input: Json[] = req.params.body.input;
  const prefixOk = prevInput.every((it, i) => JSON.stringify(it) === JSON.stringify(input[i]));
  return (
    <div data-testid="requests-view">
      <div className="row wrap">
        {requests.map((r, i) => (
          <button key={r.seq} className={i === index ? "chip" : "chip off"} onClick={() => setSel(i)}>#{i + 1}</button>
        ))}
      </div>
      <p className="explain">POST <code>{req.params.url}</code>. {prev && (
        <>Compared to request #{index}: <b>{input.length - prevInput.length}</b> items appended, earlier items {prefixOk ? <b className="ok">unchanged ✓ (prompt cache can hit)</b> : <b className="bad">changed ✗</b>}.</>
      )} <Links method="trace/modelRequest" /></p>
      {response?.params.cost && <CostTable cost={response.params.cost} />}
      <h4>Request body</h4>
      <JsonView value={req.params.body} open={1} />
      {response && (
        <>
          <h4>Response</h4>
          <JsonView value={response.params} open={2} />
        </>
      )}
    </div>
  );
}

// One request's bill: where the input tokens came from (cache or not) and what each part cost.
function CostTable({ cost }: { cost: Json }) {
  const t = cost.tokens, u = cost.usd;
  const rows: [string, number, number | undefined, string][] = [
    ["uncached input", t.uncached, u?.uncachedInput, "full input price"],
    ["read from cache", t.cached, u?.cachedInput, "cheap: same prefix as an earlier request"],
    ["written to cache", t.cacheWrite, u?.cacheWrite, "new tokens stored for the next request"],
    ["output", t.output, u?.output, t.reasoning ? `includes ${t.reasoning} reasoning tokens` : "model's reply and tool calls"],
  ];
  return (
    <div data-testid="cost-table">
      <h4>Cost</h4>
      <table className="cost-table">
        <tbody>
          {rows.map(([label, tokens, dollars, note]) => (
            <tr key={label}><td>{label}</td><td className="num">{tokens.toLocaleString()} tok</td><td className="num">{usd(dollars)}</td><td className="muted">{note}</td></tr>
          ))}
          <tr className="total"><td>total</td><td className="num">{(t.input + t.output).toLocaleString()} tok</td><td className="num">{usd(u?.total)}</td>
            <td className="muted">billed by OpenRouter: {usd(cost.billedUsd)}</td></tr>
          {u && <tr><td>without caching</td><td /><td className="num">{usd(u.withoutCache)}</td>
            <td className="ok">caching saved {usd(u.savedByCache)} ({pct(cost.cacheHitRate)} of input cached)</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function Tools({ events }: { events: TraceEvent[] }) {
  const reg = [...events].reverse().find((e) => e.method === "trace/toolsRegistered");
  const listed = events.filter((e) => e.method === "trace/mcpToolsListed");
  const exposed = events.filter((e) => e.method === "trace/mcpToolExposed");
  if (!reg) return <p className="muted">No tools yet.</p>;
  return (
    <div data-testid="tools-view">
      <p className="explain">The model sees only these specs: a name, a description and an input schema. <Links method="trace/toolsRegistered" /></p>
      {reg.params.tools.map((t: Json) => (
        <details key={t.name} className="tool-spec">
          <summary><code>{t.name}</code> <span className="muted">{t.type}{t.type === "namespace" ? ` · ${t.tools.length} tools` : ""}</span></summary>
          <JsonView value={t} open={2} />
        </details>
      ))}
      {listed.map((l) => {
        const ex = exposed.find((e) => e.params.server === l.params.server);
        return (
          <div key={l.seq}>
            <h4>MCP server “{l.params.server}”: what the server sends vs what the model sees</h4>
            <p className="explain"><Links method="trace/mcpToolExposed" /></p>
            <div className="side-by-side">
              <div><div className="muted small">tools/list (MCP)</div><JsonView value={l.params.tools} open={2} /></div>
              <div><div className="muted small">Responses API tool spec</div><JsonView value={ex?.params.spec} open={2} /></div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

function Guardrails({ events }: { events: TraceEvent[] }) {
  const rows = events.filter((e) => ["trace/policyDecision", "trace/sandboxCommand", "trace/sandboxDenied", "trace/approvalRequested", "trace/approvalResolved"].includes(e.method));
  if (!rows.length) return <p className="muted">No tool has run yet. Policy decisions and sandbox commands appear here.</p>;
  return (
    <div data-testid="guardrails-view">
      <p className="explain">Two separate layers: the <b>approval policy</b> decides when to ask you; the <b>sandbox</b> is enforced by the OS. <Links method="trace/policyDecision" /></p>
      {rows.map((e) => (
        <div key={e.seq} className={`guard-row ${e.params.decision ?? ""}`}>
          <div className="t-head"><span className="t-title">{info(e.method).title}</span>
            <span className="t-sum">{e.method === "trace/policyDecision" ? `${e.params.tool} → ${e.params.decision}${e.params.sandboxed ? " · sandboxed" : ""}` : e.params.decision ?? e.params.requestMethod ?? ""}</span></div>
          {e.method === "trace/policyDecision" && <div className="small">{e.params.reason} <span className="muted">(approval={e.params.approvalPolicy}, sandbox={e.params.sandboxMode})</span></div>}
          {e.method === "trace/sandboxCommand" && (
            <>
              <pre className="small">{e.params.argv.join(" ")}</pre>
              {e.params.policy && <details><summary className="small">Seatbelt policy ({e.params.policy.split("\n").length} lines)</summary><pre className="small">{e.params.policy}</pre></details>}
            </>
          )}
          {e.method === "trace/sandboxDenied" && <div className="small">{e.params.note}</div>}
        </div>
      ))}
    </div>
  );
}

function Protocol({ wire }: { wire: State["wire"] }) {
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const shown = wire.map((w, i) => ({ ...w, i })).filter((w) => !filter || JSON.stringify(w.message).includes(filter));
  return (
    <div data-testid="protocol-view">
      <p className="explain">Raw JSON-RPC lite messages on the WebSocket. No <code>"jsonrpc": "2.0"</code> field, as in Codex. Server→client <b>requests</b> (with an id) are approvals.</p>
      <input className="filter" placeholder="filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      {shown.slice(-400).map((w) => (
        <div key={w.i} className="t-row">
          <div className="t-head" onClick={() => setOpen(open === w.i ? null : w.i)}>
            <span className={w.direction === "out" ? "dir out" : "dir in"}>{w.direction === "out" ? "→" : "←"}</span>
            <span className="t-title">{w.message.method ?? (w.message.error ? "error" : "result")}</span>
            <span className="t-sum">{w.message.id !== undefined ? `id=${w.message.id}` : "notification"}</span>
          </div>
          {open === w.i && <JsonView value={w.message} open={1} />}
        </div>
      ))}
    </div>
  );
}
