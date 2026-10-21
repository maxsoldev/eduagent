import { useCallback, useEffect, useReducer, useRef, useState } from "react";
import { defaultUrl, RpcClient, type Json } from "./rpc";
import { initialState, reducer, type Approval } from "./store";
import { Chat } from "./components/Chat";
import { Composer } from "./components/Composer";
import { Inspector } from "./components/Inspector";
import { pct, usd } from "./cost";

// thread/start takes a kebab-case sandbox mode; turn/start takes a camelCase SandboxPolicy (as in Codex v2).
const SANDBOX_POLICY_TAGS: Record<string, string> = { "read-only": "readOnly", "workspace-write": "workspaceWrite", "danger-full-access": "dangerFullAccess" };

type Settings = { model: string; approvalPolicy: string; sandbox: string; effort: string; cwd: string };

export function App() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const rpcRef = useRef<RpcClient | null>(null);
  const [models, setModels] = useState<Json[]>([]);
  const [settings, setSettings] = useState<Settings>({ model: "", approvalPolicy: "on-request", sandbox: "workspace-write", effort: "", cwd: "" });
  const [stepMode, setStepMode] = useState(false);
  const [connectError, setConnectError] = useState<string | null>(null);

  const startThread = useCallback(async (s: Settings) => {
    const rpc = rpcRef.current!;
    const res = await rpc.request("thread/start", {
      model: s.model || undefined, approvalPolicy: s.approvalPolicy, sandbox: s.sandbox, cwd: s.cwd || undefined,
      effort: s.effort || undefined,
    });
    dispatch({ type: "thread", thread: res.thread });
    setSettings((prev) => ({ ...prev, model: res.model, cwd: res.cwd }));
    if (stepMode) await rpc.request("debug/stepMode/set", { threadId: res.thread.id, enabled: true });
  }, [stepMode]);

  useEffect(() => {
    const rpc = new RpcClient(defaultUrl(), {
      onNotification: (method, params) => dispatch({ type: "notification", method, params }),
      onServerRequest: (id, method, params) => dispatch({ type: "serverRequest", approval: { id, method, params } }),
      onWire: (direction, message) => dispatch({ type: "wire", direction, message }),
      onStatus: (status) => dispatch({ type: "status", status }),
    });
    rpcRef.current = rpc;
    (async () => {
      try {
        await rpc.connect();
        await rpc.request("initialize", { clientInfo: { name: "educodex-web", title: "educodex web UI", version: "0.1.0" }, capabilities: {} });
        rpc.notify("initialized");
        const list = await rpc.request("model/list");
        setModels(list.data);
        await startThread(settings);
      } catch (err) {
        setConnectError(String(err));
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const note = (text: string, error = false) => dispatch({ type: "note", text, error });

  const send = async (text: string, skills: Json[]) => {
    if (!state.threadId || state.turnRunning) return;
    await rpcRef.current!.request("turn/start", {
      threadId: state.threadId, input: [{ type: "text", text }, ...skills],
      approvalPolicy: settings.approvalPolicy, sandboxPolicy: { type: SANDBOX_POLICY_TAGS[settings.sandbox] }, model: settings.model || undefined,
      effort: settings.effort || undefined,
    }).catch((err) => note(String(err.message ?? err), true));
  };

  const loadSkills = useCallback(async () => {
    const res = await rpcRef.current!.request("skills/list", { cwds: settings.cwd ? [settings.cwd] : undefined });
    return res.data[0]?.skills ?? [];
  }, [settings.cwd]);

  // Slash commands from the composer. Like Codex, each maps to one app-server request.
  const runCommand = async (name: string) => {
    const rpc = rpcRef.current!;
    note(`/${name}`);
    try {
      if (name === "new") await startThread(settings);
      else if (name === "compact") await rpc.request("thread/compact/start", { threadId: state.threadId });
      else if (name === "memory-update") await rpc.request("memory/update/start", { threadId: state.threadId });
      else if (name === "memory-drop") { await rpc.request("memory/reset"); note("All memories were deleted. New threads start without them."); }
      else if (name === "skills") {
        const skills = await loadSkills();
        note(skills.length ? `Skills (type $ to use one):\n${skills.map((s: Json) => `$${s.name} (${s.scope}): ${s.shortDescription || s.description}`).join("\n")}`
          : "No skills found. Add a folder with a SKILL.md to .agents/skills/ in your project.");
      }
    } catch (err) {
      note(String((err as Error).message ?? err), true);
    }
  };

  const answer = (a: Approval, result: Json) => {
    rpcRef.current!.respond(a.id, result);
    dispatch({ type: "approvalAnswered", id: a.id });
  };

  const toggleStep = async (enabled: boolean) => {
    setStepMode(enabled);
    if (state.threadId) await rpcRef.current!.request("debug/stepMode/set", { threadId: state.threadId, enabled });
  };

  const call = (method: string) => state.threadId && rpcRef.current!.request(method, { threadId: state.threadId, turnId: state.currentTurnId });
  const set = (k: keyof Settings) => (e: { target: { value: string } }) => setSettings({ ...settings, [k]: e.target.value });

  return (
    <div className="app">
      <header>
        <div className="brand"><b>educodex</b> <span className="muted">inside a coding agent</span></div>
        <div className="controls">
          <select value={settings.model} onChange={set("model")} title="model" data-testid="model">
            {models.map((m) => <option key={m.id} value={m.id}>{m.displayName}</option>)}
          </select>
          <select value={settings.approvalPolicy} onChange={set("approvalPolicy")} title="approval policy" data-testid="approval-policy">
            <option value="on-request">approval: on-request</option><option value="never">approval: never</option>
          </select>
          <select value={settings.sandbox} onChange={set("sandbox")} title="sandbox mode" data-testid="sandbox">
            <option value="read-only">sandbox: read-only</option><option value="workspace-write">sandbox: workspace-write</option>
            <option value="danger-full-access">sandbox: danger-full-access</option>
          </select>
          <select value={settings.effort} onChange={set("effort")} title="reasoning effort">
            <option value="">effort: default</option><option value="low">low</option><option value="medium">medium</option><option value="high">high</option>
          </select>
          <label className="toggle" title="pause before each model call and tool call"><input type="checkbox" checked={stepMode} onChange={(e) => toggleStep(e.target.checked)} data-testid="step-mode" /> step mode</label>
          <button onClick={() => call("thread/compact/start")} disabled={!state.threadId || state.turnRunning} title="summarise history now">compact</button>
          <button onClick={() => startThread(settings)} disabled={state.turnRunning} data-testid="new-thread">new thread</button>
          {state.costTotal && (
            <span className="cost-badge" data-testid="cost-badge"
              title={`${state.costTotal.requests} requests · ${state.costTotal.tokens.input.toLocaleString()} input tokens (${state.costTotal.tokens.cached.toLocaleString()} cached) · ${state.costTotal.tokens.output.toLocaleString()} output tokens${state.costTotal.usd ? ` · saved ${usd(state.costTotal.usd.savedByCache)} by caching` : ""}`}>
              {usd(state.costTotal.billedUsd ?? state.costTotal.usd?.total)} · {pct(state.costTotal.cacheHitRate)} cached
            </span>
          )}
          <span className={`conn ${state.status}`} data-testid="conn">{state.status}</span>
        </div>
      </header>
      {connectError && <div className="banner">Cannot reach the app server ({connectError}). Start it with <code>uv run educodex app-server</code>.</div>}
      <main>
        <section className="left">
          <div className="thread-info muted small">thread {state.threadId?.slice(0, 8) ?? "—"} · cwd <input className="cwd" value={settings.cwd} onChange={set("cwd")} title="working directory (applies to new threads)" /></div>
          <Chat chat={state.chat} live={state.live} approvals={state.approvals} onAnswer={answer} paused={state.paused}
            onContinue={() => call("debug/continue")} />
          <Composer disabled={!state.threadId} turnRunning={state.turnRunning} loadSkills={loadSkills}
            placeholder={!state.threadId ? "starting thread…" : state.turnRunning ? "agent is working…" : "Ask the agent to do something (/ for commands, $ for skills, Shift+Enter for newline)"}
            onSend={send} onCommand={runCommand} onInterrupt={() => call("turn/interrupt")} />
        </section>
        <section className="right"><Inspector state={state} rpc={rpcRef.current} /></section>
      </main>
    </div>
  );
}
