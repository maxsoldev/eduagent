// The Codex adapter's client half: sends Codex app-server requests over the JSON-RPC lite client.
// Incoming messages go through codexActions (mapping.ts) into the view model.
import type { Adapter, AdapterOptions, Command, ContextSnapshot, Settings, SkillInfo } from "../types";
import type { Approval, Json } from "../../view/model";
import { shows } from "../../view/capabilities";
import { RpcClient } from "./rpc";
import { codexActions } from "./mapping";
import { codexExplainer } from "./explain";
import { codexContext } from "./context";

// Slash commands, in Codex's popup order (codex-rs/tui/src/slash_command.rs: "enum order is
// presentation order"). The descriptions of skills, new and compact are Codex's own. Codex has
// /memory-update and /memory-drop only as hidden debug stubs; here they run the memory pipeline.
const COMMANDS: Command[] = [
  { name: "skills", description: "use skills to improve how Codex performs specific tasks", needs: "skills" },
  { name: "new", description: "start a new chat during a conversation" },
  { name: "compact", description: "summarize conversation to prevent hitting the context limit", needs: "compaction" },
  { name: "memory-update", description: "learn from earlier threads now (memory phase 1 + phase 2)", needs: "memories" },
  { name: "memory-drop", description: "delete all memories", needs: "memories" },
];

// thread/start takes a kebab-case sandbox mode; turn/start takes a camelCase SandboxPolicy (as in Codex v2).
const SANDBOX_POLICY_TAGS: Record<string, string> = { "read-only": "readOnly", "workspace-write": "workspaceWrite", "danger-full-access": "dangerFullAccess" };

export function createCodexAdapter({ url, capabilities, dispatch }: AdapterOptions): Adapter {
  const rpc = new RpcClient(url, {
    onMessage: (message) => codexActions(message).forEach(dispatch),
    onWire: (direction, message) => dispatch({ type: "wire", direction, message }),
    onStatus: (status, reason) => dispatch({ type: "status", status, reason }),
  });
  let threadId: string | null = null;
  let turnId: string | null = null;
  const thread = () => ({ threadId, turnId });
  // Without the capability, leave the setting to the backend's default.
  const approvals = (s: Settings) => (shows(capabilities, "approvals") ? s.approvalPolicy : undefined);
  const sandbox = (s: Settings) => (shows(capabilities, "sandbox") ? s.sandbox : undefined);

  return {
    explain: codexExplainer,
    commands: COMMANDS,
    efforts: [{ value: "low", label: "low" }, { value: "medium", label: "medium" }, { value: "high", label: "high" }],
    protocolNote: "Raw JSON-RPC lite messages on the WebSocket. No \"jsonrpc\": \"2.0\" field, as in Codex. Server→client requests (with an id) are approvals.",
    contextTriggers: ["historyChanged"],

    async connect() {
      await rpc.connect();
      await rpc.request("initialize", { clientInfo: { name: "educodex-web", title: "educodex web UI", version: "0.1.0" }, capabilities: {} });
      rpc.notify("initialized");
      const list = await rpc.request("model/list");
      return { models: list.data.map((m: Json) => ({ value: m.id, label: m.displayName })) };
    },
    async startSession(s) {
      const res = await rpc.request("thread/start", {
        model: s.model || undefined, approvalPolicy: approvals(s), sandbox: sandbox(s), cwd: s.cwd || undefined, effort: s.effort || undefined,
      });
      threadId = res.thread.id;
      turnId = null;
      return { model: res.model, cwd: res.cwd };
    },
    async send(s, text, skills) {
      const sandboxMode = sandbox(s);
      const res = await rpc.request("turn/start", {
        threadId, input: [{ type: "text", text }, ...skills.map((k) => ({ type: "skill", ...k }))],
        approvalPolicy: approvals(s), sandboxPolicy: sandboxMode ? { type: SANDBOX_POLICY_TAGS[sandboxMode] } : undefined,
        model: s.model || undefined, effort: s.effort || undefined,
      });
      turnId = res.turn.id;
    },
    async interrupt() { await rpc.request("turn/interrupt", thread()); },
    async compact() { await rpc.request("thread/compact/start", { threadId }); },
    async listSkills(cwd): Promise<SkillInfo[]> {
      const res = await rpc.request("skills/list", { cwds: cwd ? [cwd] : undefined });
      return res.data[0]?.skills ?? [];
    },
    async runCommand(name) {
      if (name === "memory-update") await rpc.request("memory/update/start", { threadId });
      else if (name === "memory-drop") { await rpc.request("memory/reset"); return "All memories were deleted. New threads start without them."; }
    },
    async setStepMode(enabled) { if (threadId) await rpc.request("debug/stepMode/set", { threadId, enabled }); },
    async continueStep() { await rpc.request("debug/continue", thread()); },
    async context(): Promise<ContextSnapshot | null> {
      return threadId ? codexContext(await rpc.request("debug/context/get", { threadId })) : null;
    },
    wireLabel: (m) => ({ title: m.method ?? (m.error ? "error" : "result"), detail: m.id !== undefined ? `id=${m.id}` : "notification" }),
    respond(approval: Approval, result) {
      rpc.respond(approval.id, result);
      dispatch({ type: "approvalResolved", id: approval.id });
    },
  };
}
