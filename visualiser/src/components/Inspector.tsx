// The Inspector: tabs that read the neutral view model (events, wire, costs) and the adapter
// (explanations, the next request). Tabs for missing capabilities are not shown.
import { useEffect, useMemo, useRef, useState } from "react";
import type { Adapter, ContextSnapshot } from "../adapters/types";
import type { Capabilities } from "../view/capabilities";
import type { Json, TimelineEvent, View } from "../view/model";
import { CATEGORY_COLORS, type Category, type Explainer } from "../view/explain";
import type { Links as HarnessLinks } from "../view/harness";
import { JsonView } from "./JsonView";
import { CostPanel } from "./CostPanel";
import { useStickToBottom } from "../useStickToBottom";
import { CategoryBreakdown, ContextBar, CTX_CATS, type Highlight, type Segment } from "./ContextBar";
import { cacheStatus, nextRequestCost, pct, uncachedCost, usd } from "../cost";

const TABS = ["Timeline", "Context", "Requests", "Tools", "Guardrails", "Protocol"] as const;
type Tab = (typeof TABS)[number];
// Which capability each tab needs (Timeline and Protocol show native messages, so they always stay).
const shownTab = (t: Tab, caps: Capabilities) =>
  t === "Context" ? caps.has("contextInspector")
  : t === "Requests" || t === "Tools" ? caps.has("trace")
  : t === "Guardrails" ? caps.has("trace") && (caps.has("approvals") || caps.has("sandbox"))
  : true;

type Props = { view: View; adapter: Adapter | null; capabilities: Capabilities; links: HarnessLinks };

export function Inspector({ view, adapter, capabilities, links }: Props) {
  const [tab, setTab] = useState<Tab>("Timeline");
  const body = useRef<HTMLDivElement>(null);
  useEffect(() => { if (body.current) body.current.scrollTop = 0; }, [tab]); // tabs share one scroller
  // view.events spans every session on this connection; per-session tabs only show the current one.
  const sessionEvents = useMemo(() => view.events.filter((e) => e.sessionId === view.sessionId), [view.events, view.sessionId]);
  if (!adapter) return <div className="inspector" />;
  const ex = adapter.explain;
  const tabs = TABS.filter((t) => shownTab(t, capabilities));
  return (
    <div className="inspector">
      <div className="tabs">
        {tabs.map((t) => (
          <button key={t} className={t === tab ? "tab active" : "tab"} onClick={() => setTab(t)} data-testid={`tab-${t}`}>{t}</button>
        ))}
      </div>
      <div className={tab === "Context" || tab === "Timeline" ? "tab-body pinned" : "tab-body"} ref={body}>
        {tab === "Timeline" && <Timeline events={view.events} sessionId={view.sessionId} ex={ex} links={links} />}
        {tab === "Context" && <ContextView view={view} adapter={adapter} links={links} />}
        {tab === "Requests" && <Requests key={view.sessionId} events={sessionEvents} ex={ex} links={links} />}
        {tab === "Tools" && <Tools events={sessionEvents} ex={ex} links={links} mcp={capabilities.has("mcp")} />}
        {tab === "Guardrails" && <Guardrails events={sessionEvents} ex={ex} links={links} />}
        {tab === "Protocol" && <Protocol wire={view.wire} adapter={adapter} />}
      </div>
    </div>
  );
}

// Guide and source links for one event, from the connected backend's harness and guide section.
function Links({ ex, links, name, trace = true }: { ex: Explainer; links: HarnessLinks; name: string; trace?: boolean }) {
  const i = ex.info({ name, trace });
  return (
    <span className="links">
      {i.chapter && links.guide && <a href={links.guide(i.chapter)} target="_blank">guide ch.{i.chapter}</a>}
      {i.source && links.source && <a href={links.source(i.source)} target="_blank">{links.harness}: {i.source}</a>}
    </span>
  );
}

function Timeline({ events, sessionId, ex, links }: { events: TimelineEvent[]; sessionId: string | null; ex: Explainer; links: HarnessLinks }) {
  const [showNoisy, setShowNoisy] = useState(false);
  const [hidden, setHidden] = useState<Set<Category>>(new Set());
  const [open, setOpen] = useState<number | null>(null);
  const follow = useStickToBottom(events[events.length - 1]?.seq ?? 0);
  const shown = events.filter((e) => (showNoisy || !ex.noisy(e)) && !hidden.has(ex.info(e).category));
  const t0 = events[0]?.ts ?? 0;
  const other = (e: TimelineEvent) => Boolean(e.sessionId && e.sessionId !== sessionId);
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
          const i = ex.info(e);
          return (
            <div key={e.seq} className={`t-row${other(e) ? " other-thread" : ""}${follow.isFresh(e.seq) ? " fresh" : ""}`}
              data-event={e.name}
              title={other(e) ? `session ${e.sessionId!.slice(0, 8)} (not the current one)` : undefined}>
              <div className="t-head" onClick={() => setOpen(open === e.seq ? null : e.seq)}>
                <span className="t-time">{((e.ts - t0) / 1000).toFixed(2)}s</span>
                <span className="dot" style={{ background: CATEGORY_COLORS[i.category] }} />
                <span className="t-title">{i.title}</span>
                <span className="t-sum">{ex.summary(e)}</span>
              </div>
              {open === e.seq && (
                <div className="t-detail">
                  {i.text && <p className="explain">{i.text} <Links ex={ex} links={links} name={e.name} trace={e.trace} /></p>}
                  <code className="muted small">{e.trace ? `trace ${e.name}` : e.name}</code>
                  <JsonView value={e.data} open={1} />
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

function ContextView({ view, adapter, links }: { view: View; adapter: Adapter; links: HarnessLinks }) {
  const [ctx, setCtx] = useState<ContextSnapshot | null>(null);
  const [open, setOpen] = useState<number | null>(null);
  const [zoom, setZoom] = useState(true);
  const [hl, setHl] = useState<Highlight>(null);
  // Ask for the next request again after each event that changed it (Codex: trace historyChanged).
  const changes = view.events.filter((e) => e.trace && adapter.contextTriggers.includes(e.name)).length;
  useEffect(() => {
    if (!view.sessionId) return;
    const t = setTimeout(() => adapter.context().then(setCtx).catch(() => {}), 150);
    return () => clearTimeout(t);
  }, [adapter, view.sessionId, changes]);
  // The item list scrolls on its own and follows new items while it is scrolled to the bottom.
  const follow = useStickToBottom(ctx?.items.length ?? 0, view.sessionId);
  if (!ctx) return <p className="muted">Start a thread to see its context.</p>;
  const items = ctx.items;
  const sizes = items.map((it) => it.tokens);
  const toolsTokens = ctx.tools.tokens;
  const total = sizes.reduce((a, b) => a + b, 0) + toolsTokens;
  // Zoomed: the bar spans what is used (so small items are visible); otherwise the whole window.
  const scale = zoom ? Math.max(total * 1.1, 1) : ctx.contextWindow;
  const last = view.costs[view.costs.length - 1] ?? null;
  const cache = cacheStatus(sizes, toolsTokens, last);
  const real = (t: number) => t * cache.scale; // estimate -> provider token count
  const nextCosts = items.map((_, i) => nextRequestCost(real(sizes[i]), cache.status[i], view.pricing));
  const nextTotal = view.pricing ? nextCosts.reduce((a: number, b) => a + (b ?? 0), 0)
    + (nextRequestCost(real(toolsTokens), last ? "cached" : "new", view.pricing) ?? 0) : null;
  const nextUncached = uncachedCost(real(total), view.pricing);
  const segments: Segment[] = [
    { index: -1, label: "tool definitions", cat: "tools", tokens: toolsTokens, status: last ? "cached" : undefined,
      cost: nextRequestCost(real(toolsTokens), last ? "cached" : "new", view.pricing), preview: ctx.tools.names.join(", ") },
    ...items.map((it, i) => ({ index: i, label: it.label, cat: it.cat, tokens: sizes[i], status: cache.status[i], cost: nextCosts[i], preview: it.preview })),
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
        Colours show where each item came from. <Links ex={adapter.explain} links={links} name="promptAssembled" /></p>
      <ContextBar segments={segments} total={total} scale={scale} contextWindow={ctx.contextWindow}
        autoCompactLimit={ctx.autoCompactLimit} zoom={zoom} hl={hl} setHl={setHl} onSelect={select} />
      <div className="muted small">
        <label><input type="checkbox" checked={zoom} onChange={(e) => setZoom(e.target.checked)} /> zoom to used</label> · ~{total.toLocaleString()} of {ctx.contextWindow.toLocaleString()} tokens (estimate) · auto-compact at {ctx.autoCompactLimit.toLocaleString()} · {ctx.tools.names.length} tools (~{toolsTokens} tok)</div>
      <CategoryBreakdown segments={segments} total={total} contextWindow={ctx.contextWindow} hl={hl} setHl={setHl} />
      {last ? <CostPanel costs={view.costs} pricing={view.pricing} next={{ withCache: nextTotal, withoutCache: nextUncached }} />
        : <div className="cost-empty muted small">{view.events.some((e) => e.trace && e.name === "modelRequest" && e.sessionId === view.sessionId)
            ? <>The backend sent no cost data.</>
            : <>Costs and the prompt cache appear here after the first request.</>}</div>}
      {last && <div className="muted small cost-note">Per-item costs below are estimates for the next request: the provider bills per request, so the total is spread over items by size. <i>cached</i> = inside the prefix the last request read from the cache.</div>}
      </div>
      <div className="scroll-list-wrap">
      <div className="ctx-list scroll-list" ref={follow.ref} onScroll={follow.onScroll} data-testid="ctx-list">
        {items.map((item, i) => {
          const lit = hl && ("item" in hl ? hl.item === i : hl.cat === item.cat);
          return (
            <div key={i} className={`ctx-item${lit ? " lit" : ""}${follow.isFresh(i + 1) ? " fresh" : ""}`}
              data-testid="ctx-item" data-ctx-index={i}
              onPointerEnter={() => setHl({ item: i })} onPointerLeave={() => setHl(null)}>
              <div className="t-head" onClick={() => setOpen(open === i ? null : i)}>
                <span className="t-time">{i}</span>
                <span className="dot" style={{ background: CTX_CATS[item.cat].color }} />
                <span className="t-title">{item.label}</span>
                <span className="t-sum">{item.summary} · {sizes[i]} tok</span>
                <span className={`cache-tag ${cache.status[i].replace(" ", "-")}`} title="prompt cache status in the last request">{cache.status[i]}</span>
                {nextCosts[i] !== null && <span className="item-cost" title="estimated input cost of this item in the next request">{usd(nextCosts[i])}</span>}
              </div>
              {open === i && (item.parts ? item.parts.map((part, j) => (
                <div key={j} className="part" data-testid="ctx-part">
                  <div className="part-head">part {j + 1} · type: <code>{part.type}</code> · ~{part.tokens} tok</div>
                  {part.text !== undefined ? <pre>{part.text}</pre> : <JsonView value={part.raw} open={1} />}
                </div>
              )) : <JsonView value={item.raw} open={2} />)}
            </div>
          );
        })}
      </div>
      {!follow.atBottom && <button className="to-latest" onClick={follow.toBottom} data-testid="ctx-to-latest">↓ latest</button>}
      </div>
    </div>
  );
}

// The API of a request, named in the modelRequest trace event (Responses if absent).
const api = (data: Json): string => data.api ?? "openai-responses";
// The items of a request body: Chat Completions sends `messages`, Responses sends `input` items.
const requestItems = (data: Json): Json[] => (api(data) === "openai-completions" ? data.body.messages : data.body.input) ?? [];

const clip = (t: string) => (t.length > 160 ? `${t.slice(0, 160)}…` : t);
const partsText = (content: Json): string =>
  typeof content === "string" ? content
  : (content ?? []).map((c: Json) => c.text ?? c.refusal ?? (c.image_url || c.type === "input_image" ? "[image]" : `[${c.type}]`)).join(" ");

// One row per message (Chat Completions): role, then the text, tool calls or the tool call it answers.
function completionsRow(m: Json): [string, string] {
  const calls = (m.tool_calls ?? []).map((c: Json) => `${c.function?.name}(${c.function?.arguments ?? ""})`).join(" ");
  const head = m.role + (m.tool_call_id ? ` · ${m.tool_call_id}` : "");
  return [head, [partsText(m.content), calls].filter(Boolean).join(" ")];
}

// One row per input item (Responses): its type, the role of a message, the tool of a call.
function responsesRow(it: Json): [string, string] {
  switch (it.type) {
    case "message": return [`message · ${it.role}`, partsText(it.content)];
    case "function_call": case "custom_tool_call": return [it.type, `${it.name}(${it.arguments ?? it.input ?? ""})`];
    case "function_call_output": case "custom_tool_call_output":
      return [it.type, typeof it.output === "string" ? it.output : partsText(it.output)];
    case "reasoning": return ["reasoning", (it.summary ?? []).map((s: Json) => s.text).join(" ")];
    default: return [it.type ?? "item", JSON.stringify(it)];
  }
}

// The request as its API sees it: Chat Completions messages or Responses input items.
function RequestItems({ api, items }: { api: string; items: Json[] }) {
  const completions = api === "openai-completions";
  return (
    <div data-testid="request-items" data-api={api}>
      <h4>{completions ? "Chat Completions messages (body.messages)" : "Responses input items (body.input)"}</h4>
      <p className="muted small">{completions
        ? "Each message has a role (system or developer, user, assistant, tool). Tool calls ride on assistant messages; each result is a tool message."
        : "Each item has a type: messages with a role, function calls and their outputs, reasoning. Instructions are developer messages."}</p>
      {items.map((it, i) => {
        const [head, text] = completions ? completionsRow(it) : responsesRow(it);
        return (
          <div key={i} className="t-row" data-testid="request-item">
            <div className="t-head"><span className="t-time">{i}</span><span className="t-title">{head}</span><span className="t-sum">{clip(text)}</span></div>
          </div>
        );
      })}
    </div>
  );
}

function Requests({ events, ex, links }: { events: TimelineEvent[]; ex: Explainer; links: HarnessLinks }) {
  const requests = events.filter((e) => e.trace && e.name === "modelRequest");
  const [sel, setSel] = useState<number>(-1);
  const index = sel < 0 ? requests.length - 1 : sel;
  const req = requests[index];
  const response = useMemo(() => {
    if (!req) return null;
    return events.find((e) => e.seq > req.seq && e.trace && e.name === "modelResponse") ?? null;
  }, [events, req]);
  if (!req) return <p className="muted">No model requests yet.</p>;
  const prev = requests[index - 1];
  const prevInput: Json[] = prev ? requestItems(prev.data) : [];
  const input: Json[] = requestItems(req.data);
  const prefixOk = prevInput.every((it, i) => JSON.stringify(it) === JSON.stringify(input[i]));
  return (
    <div data-testid="requests-view">
      <div className="row wrap">
        {requests.map((r, i) => (
          <button key={r.seq} className={i === index ? "chip" : "chip off"} onClick={() => setSel(i)}>#{i + 1}</button>
        ))}
      </div>
      <p className="explain">POST <code>{req.data.url}</code>. {prev && (
        <>Compared to request #{index}: <b>{input.length - prevInput.length}</b> items appended, earlier items {prefixOk ? <b className="ok">unchanged ✓ (prompt cache can hit)</b> : <b className="bad">changed ✗</b>}.</>
      )} <Links ex={ex} links={links} name="modelRequest" /></p>
      {response?.data.cost && <CostTable cost={response.data.cost} />}
      <RequestItems api={api(req.data)} items={input} />
      <h4>Request body</h4>
      <JsonView value={req.data.body} open={1} />
      {response && (
        <>
          <h4>Response</h4>
          <JsonView value={response.data} open={2} />
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

const traced = (events: TimelineEvent[], name: string) => events.filter((e) => e.trace && e.name === name);

function Tools({ events, ex, links, mcp }: { events: TimelineEvent[]; ex: Explainer; links: HarnessLinks; mcp: boolean }) {
  const reg = traced(events, "toolsRegistered").at(-1);
  const listed = mcp ? traced(events, "mcpToolsListed") : [];
  const exposed = traced(events, "mcpToolExposed");
  if (!reg) return <p className="muted">No tools yet.</p>;
  return (
    <div data-testid="tools-view">
      <p className="explain">The model sees only these specs: a name, a description and an input schema. <Links ex={ex} links={links} name="toolsRegistered" /></p>
      {reg.data.tools.map((t: Json) => {
        const name = t.name ?? t.function?.name; // Responses tools carry name; Chat Completions tools nest it in function
        return (
          <details key={name} className="tool-spec">
            <summary><code>{name}</code> <span className="muted">{t.type}{t.type === "namespace" ? ` · ${t.tools.length} tools` : ""}</span></summary>
            <JsonView value={t} open={2} />
          </details>
        );
      })}
      {listed.map((l) => {
        const exp = exposed.find((e) => e.data.server === l.data.server);
        return (
          <div key={l.seq}>
            <h4>MCP server “{l.data.server}”: what the server sends vs what the model sees</h4>
            <p className="explain"><Links ex={ex} links={links} name="mcpToolExposed" /></p>
            <div className="side-by-side">
              <div><div className="muted small">tools/list (MCP)</div><JsonView value={l.data.tools} open={2} /></div>
              <div><div className="muted small">Responses API tool spec</div><JsonView value={exp?.data.spec} open={2} /></div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// Codex's guardrail trace events (approvals and sandbox); shown only for backends with those capabilities.
const GUARD = ["policyDecision", "sandboxCommand", "sandboxDenied", "approvalRequested", "approvalResolved"];

function Guardrails({ events, ex, links }: { events: TimelineEvent[]; ex: Explainer; links: HarnessLinks }) {
  const rows = events.filter((e) => e.trace && GUARD.includes(e.name));
  if (!rows.length) return <p className="muted">No tool has run yet. Policy decisions and sandbox commands appear here.</p>;
  return (
    <div data-testid="guardrails-view">
      <p className="explain">Two separate layers: the <b>approval policy</b> decides when to ask you; the <b>sandbox</b> is enforced by the OS. <Links ex={ex} links={links} name="policyDecision" /></p>
      {rows.map((e) => (
        <div key={e.seq} className={`guard-row ${e.data.decision ?? ""}`}>
          <div className="t-head"><span className="t-title">{ex.info(e).title}</span>
            <span className="t-sum">{e.name === "policyDecision" ? `${e.data.tool} → ${e.data.decision}${e.data.sandboxed ? " · sandboxed" : ""}` : e.data.decision ?? e.data.requestMethod ?? ""}</span></div>
          {e.name === "policyDecision" && <div className="small">{e.data.reason} <span className="muted">(approval={e.data.approvalPolicy}, sandbox={e.data.sandboxMode})</span></div>}
          {e.name === "sandboxCommand" && (
            <>
              <pre className="small">{e.data.argv.join(" ")}</pre>
              {e.data.policy && <details><summary className="small">Seatbelt policy ({e.data.policy.split("\n").length} lines)</summary><pre className="small">{e.data.policy}</pre></details>}
            </>
          )}
          {e.name === "sandboxDenied" && <div className="small">{e.data.note}</div>}
        </div>
      ))}
    </div>
  );
}

// The native messages, unchanged, as the backend sent them.
function Protocol({ wire, adapter }: { wire: View["wire"]; adapter: Adapter }) {
  const [filter, setFilter] = useState("");
  const [open, setOpen] = useState<number | null>(null);
  const shown = wire.map((w, i) => ({ ...w, i })).filter((w) => !filter || JSON.stringify(w.message).includes(filter));
  return (
    <div data-testid="protocol-view">
      <p className="explain">{adapter.protocolNote}</p>
      <input className="filter" placeholder="filter…" value={filter} onChange={(e) => setFilter(e.target.value)} />
      {shown.slice(-400).map((w) => {
        const label = adapter.wireLabel(w.message);
        return (
          <div key={w.i} className="t-row">
            <div className="t-head" onClick={() => setOpen(open === w.i ? null : w.i)}>
              <span className={w.direction === "out" ? "dir out" : "dir in"}>{w.direction === "out" ? "→" : "←"}</span>
              <span className="t-title">{label.title}</span>
              <span className="t-sum">{label.detail}</span>
            </div>
            {open === w.i && <JsonView value={w.message} open={1} />}
          </div>
        );
      })}
    </div>
  );
}
