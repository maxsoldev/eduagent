import { useEffect, useRef, useState, type ReactNode } from "react";
import type { Json } from "../rpc";
import type { Approval, ChatEntry } from "../store";

export function Chat({ chat, live, approvals, onAnswer, paused, onContinue }: {
  chat: ChatEntry[]; live: Record<string, Json>; approvals: Approval[];
  onAnswer: (a: Approval, result: Json) => void; paused: Json | null; onContinue: () => void;
}) {
  // Scroll only this container (scrollIntoView would also scroll the page and the grid).
  const box = useRef<HTMLDivElement>(null);
  useEffect(() => { if (box.current) box.current.scrollTop = box.current.scrollHeight; }, [chat.length, Object.keys(live).length, approvals.length, paused]);
  return (
    <div className="chat" data-testid="chat" ref={box}>
      {chat.length === 0 && Object.keys(live).length === 0 && <Welcome />}
      {chat.map((entry, i) => <Entry key={i} entry={entry} />)}
      {Object.values(live).map((item) => <Item key={item.id} item={item} live />)}
      {approvals.map((a) => <ApprovalCard key={String(a.id)} approval={a} onAnswer={onAnswer} />)}
      {paused && (
        <div className="paused" data-testid="paused">
          <div><b>⏸ Paused</b> at <code>{paused.breakpoint}</code> <span className="muted">{JSON.stringify(paused.info)}</span></div>
          <button className="primary" onClick={onContinue} data-testid="continue">Continue ▶</button>
        </div>
      )}
    </div>
  );
}

function Welcome() {
  return (
    <div className="welcome">
      <h2>Inside a coding agent</h2>
      <p>Send a task. On the right you can watch everything the harness does: how the prompt is assembled,
        the exact request to the model, every tool call, every policy decision.</p>
      <p className="muted">Try: <i>"Create hello.py that prints hi, then run it."</i> or turn on <b>Step mode</b> to pause before each model call.</p>
    </div>
  );
}

function Entry({ entry }: { entry: ChatEntry }) {
  if (entry.kind === "item") return <Item item={entry.item} />;
  if (entry.kind === "plan") return <Plan plan={entry.plan} explanation={entry.explanation} />;
  if (entry.kind === "error") return <div className="card error">⚠ {entry.message}</div>;
  const t = entry.turn;
  return <div className="turn-sep" data-testid="turn-sep">turn {t.status} · {(t.durationMs / 1000).toFixed(1)}s</div>;
}

function Item({ item, live }: { item: Json; live?: boolean }) {
  switch (item.type) {
    case "userMessage":
      return <div className="msg user"><div className="who">you</div><div className="text">{item.content?.map((c: Json) => c.text).join("\n")}</div></div>;
    case "agentMessage":
      return <div className="msg agent" data-testid="agent-message"><div className="who">agent</div><div className="text">{item.text}{live && <span className="cursor">▍</span>}</div></div>;
    case "reasoning":
      return item.summary?.length ? <details className="reasoning" open={live}><summary>reasoning summary</summary>{item.summary.join("\n\n")}</details> : null;
    case "commandExecution":
      return <Command item={item} />;
    case "fileChange":
      return <FileChange item={item} />;
    case "mcpToolCall":
      return (
        <ToolCard testId="mcp-call" head={<><span className="badge mcp">MCP</span><code className="grow">{item.server}.{item.tool}</code><Status s={item.status} /></>}>
          <pre className="small">{JSON.stringify(item.arguments)}</pre>
          {item.result && <pre className="out">{item.result.content?.map((c: Json) => c.text).join("\n") ?? JSON.stringify(item.result)}</pre>}
          {item.error && <pre className="out err">{item.error.message}</pre>}
        </ToolCard>
      );
    case "contextCompaction":
      return <div className="turn-sep compaction">⟲ context compacted{live ? "…" : ""}</div>;
    default:
      return <pre className="small">{JSON.stringify(item)}</pre>;
  }
}

function Status({ s }: { s: string }) {
  return <span className={`status ${s}`}>{s}</span>;
}

// A tool card whose body (arguments, output, diff) can be folded away; the header stays as a summary.
function ToolCard({ testId, className = "tool", head, children }: {
  testId: string; className?: string; head: ReactNode; children?: ReactNode;
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

function Command({ item }: { item: Json }) {
  return (
    <ToolCard testId="command" head={<>
      <span className="badge exec">$</span><code className="grow">{item.command}</code>
      {item.exitCode !== null && item.exitCode !== undefined && <span className="muted">exit {item.exitCode}</span>}
      <Status s={item.status} />
    </>}>
      {item.aggregatedOutput && <pre className="out">{item.aggregatedOutput}</pre>}
    </ToolCard>
  );
}

function FileChange({ item }: { item: Json }) {
  const names = item.changes.map((c: Json) => c.path).join(", ");
  return (
    <ToolCard testId="file-change" head={<><span className="badge patch">patch</span><span className="grow" title={names}>{item.changes.length} file(s): {names}</span><Status s={item.status} /></>}>
      {item.changes.map((c: Json) => (
        <div key={c.path}>
          <div className="file"><b>{c.kind.type}</b> {c.path}{c.kind.move_path ? ` → ${c.kind.move_path}` : ""}</div>
          <pre className="diff">{c.diff.split("\n").map((line: string, i: number) => (
            <span key={i} className={line.startsWith("+") && !line.startsWith("+++") ? "add" : line.startsWith("-") && !line.startsWith("---") ? "del" : line.startsWith("@@") ? "hunk" : ""}>{line + "\n"}</span>
          ))}</pre>
        </div>
      ))}
    </ToolCard>
  );
}

function Plan({ plan, explanation }: { plan: { step: string; status: string }[]; explanation?: string }) {
  const icon = (s: string) => (s === "completed" ? "✔" : s === "inProgress" ? "◐" : "○");
  const done = plan.filter((p) => p.status === "completed").length;
  return (
    <ToolCard testId="plan" className="plan" head={<><span className="badge plan">plan</span>
      <span className="grow muted">{done}/{plan.length} done{explanation ? ` · ${explanation}` : ""}</span></>}>
      {plan.map((p, i) => <div key={i} className={`step ${p.status}`}>{icon(p.status)} {p.step}</div>)}
    </ToolCard>
  );
}

function ApprovalCard({ approval, onAnswer }: { approval: Approval; onAnswer: (a: Approval, r: Json) => void }) {
  const p = approval.params;
  const mcp = approval.method === "mcpServer/elicitation/request";
  const choices: string[] = mcp ? ["accept", "decline", "cancel"] : p.availableDecisions ?? ["accept", "acceptForSession", "decline", "cancel"];
  const result = (c: string) => mcp ? { action: c }
    : c === "acceptWithExecpolicyAmendment" ? { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: p.proposedExecpolicyAmendment } } }
    : { decision: c };
  return (
    <div className="card approval" data-testid="approval">
      <div className="card-head"><span className="badge guard">approval</span><code>{approval.method}</code></div>
      <div className="approval-body">
        {p.command && <div><span className="muted">command</span> <code>{p.command}</code></div>}
        {mcp && <div>{p.message}</div>}
        {p.proposedExecpolicyAmendment && <div><span className="muted">proposed rule</span> <code>prefix_rule(pattern={JSON.stringify(p.proposedExecpolicyAmendment)}, decision="allow")</code></div>}
        {p.reason && <div><span className="muted">reason</span> {p.reason}</div>}
        {p._meta?.annotations && <div><span className="muted">annotations</span> <code>{JSON.stringify(p._meta.annotations)}</code></div>}
        <div className="muted small">The turn is paused until you answer this server→client JSON-RPC request.</div>
      </div>
      <div className="row">
        {choices.map((c) => (
          <button key={c} className={c === "accept" ? "primary" : c === "cancel" ? "danger" : ""} data-testid={`approve-${c}`}
            onClick={() => onAnswer(approval, result(c))}>{c}</button>
        ))}
      </div>
    </div>
  );
}
