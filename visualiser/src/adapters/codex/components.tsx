// Codex-only parts: plans, file-change diffs, memory updates, memory citations, approval
// prompts and the approval/sandbox controls. They read Codex item shapes directly.
import type { AdapterModule } from "../types";
import { shows } from "../../view/capabilities";
import type { Approval, Entry, Json, NativePart } from "../../view/model";
import { AssistantMessage, Status, ToolCard } from "../../components/parts";

function NativeEntry({ entry, part }: { entry: Entry; part: NativePart }) {
  const item = part.data;
  switch (part.type) {
    case "plan": return <Plan plan={item.plan} explanation={item.explanation} />;
    case "fileChange": return <FileChange item={item} status={entry.kind === "tool" ? entry.status : item.status} />;
    case "memoryUpdate": return <MemoryUpdate item={item} live={"streaming" in entry && entry.streaming} />;
    case "agentMessage": // an answer that used memories: Codex hides the <oai-mem-citation> block from the text
      return entry.kind === "assistant" ? (
        <AssistantMessage entry={entry}>
          <div className="muted small" data-testid="memory-citation" title="the model's <oai-mem-citation> block, hidden from the text">
            memory used: {item.memoryCitation.entries.map((e: Json) => `${e.path}:${e.lineStart}-${e.lineEnd} (${e.note})`).join(", ") || item.memoryCitation.threadIds.join(", ")}</div>
        </AssistantMessage>
      ) : null;
    default:
      return <pre className="small">{JSON.stringify(item)}</pre>;
  }
}

function FileChange({ item, status }: { item: Json; status: string }) {
  const names = item.changes.map((c: Json) => c.path).join(", ");
  return (
    <ToolCard testId="file-change" head={<><span className="badge patch">patch</span><span className="grow" title={names}>{item.changes.length} file(s): {names}</span><Status s={status} /></>}>
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

// /memory-update (an educodex item): phase 1 per session log, then the phase-2 sub-agent.
function MemoryUpdate({ item, live }: { item: Json; live?: boolean }) {
  const p2 = item.phase2;
  return (
    <ToolCard testId="memory-update" head={<><span className="badge memory">memory</span>
      <span className="grow">{live ? "updating memories…" : "memory update"}</span><Status s={live ? "running" : item.status} /></>}>
      {live && <div className="muted small">Phase 1 reads recent session logs; phase 2 runs a sub-agent in the memory folder. Watch the Timeline.</div>}
      {item.error && <pre className="out err">{item.error}</pre>}
      {item.phase1 && (
        <div className="small"><b>Phase 1</b> · {item.phase1.length ? `${item.phase1.length} session log(s)` : "no new session logs"}
          {item.phase1.map((r: Json) => (
            <div key={r.threadId} className="muted">thread {r.threadId.slice(0, 8)}: {r.status}{r.slug ? ` · ${r.slug}` : ""}{r.error ? ` · ${r.error}` : ""}</div>
          ))}
        </div>
      )}
      {p2 && (
        <div className="small"><b>Phase 2</b> · {p2.status}{p2.error ? `: ${p2.error}` : ""}
          {p2.changes?.length > 0 && <div className="muted">inputs changed: {p2.changes.map((c: [string, string]) => `${c[0]} ${c[1]}`).join(", ")}</div>}
          {p2.files && <div className="muted">memory folder: {p2.files.join(", ")}</div>}
        </div>
      )}
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

function ApprovalCard({ approval, onAnswer }: { approval: Approval; onAnswer: (r: Json) => void }) {
  const method = approval.part.type;
  const p = approval.part.data;
  const mcp = method === "mcpServer/elicitation/request";
  const choices: string[] = mcp ? ["accept", "decline", "cancel"] : p.availableDecisions ?? ["accept", "acceptForSession", "decline", "cancel"];
  const result = (c: string) => mcp ? { action: c }
    : c === "acceptWithExecpolicyAmendment" ? { decision: { acceptWithExecpolicyAmendment: { execpolicy_amendment: p.proposedExecpolicyAmendment } } }
    : { decision: c };
  return (
    <div className="card approval" data-testid="approval">
      <div className="card-head"><span className="badge guard">approval</span><code>{method}</code></div>
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
            onClick={() => onAnswer(result(c))}>{c}</button>
        ))}
      </div>
    </div>
  );
}

// Codex's approval policy and sandbox mode, each shown only if the backend lists the capability.
const Controls: AdapterModule["Controls"] = ({ settings, set, capabilities }) => (
  <>
    {shows(capabilities, "approvals") && (
      <select value={settings.approvalPolicy} onChange={(e) => set("approvalPolicy", e.target.value)} title="approval policy" data-testid="approval-policy">
        <option value="on-request">approval: on-request</option><option value="never">approval: never</option>
      </select>
    )}
    {shows(capabilities, "sandbox") && (
      <select value={settings.sandbox} onChange={(e) => set("sandbox", e.target.value)} title="sandbox mode" data-testid="sandbox">
        <option value="read-only">sandbox: read-only</option><option value="workspace-write">sandbox: workspace-write</option>
        <option value="danger-full-access">sandbox: danger-full-access</option>
      </select>
    )}
  </>
);

export const codexComponents = { NativeEntry, ApprovalCard, Controls };
