// The pi adapter's client half: sends pi RPC commands (packages/coding-agent/src/modes/rpc/rpc-types.ts).
// Incoming messages go through the pi mapping (mapping.ts) into the view model.
import type { Adapter, AdapterOptions, Command, SkillInfo } from "../types";
import type { Json } from "../../view/model";
import { PiRpcClient } from "./rpc";
import { createPiMapping } from "./mapping";
import { piExplainer } from "./explain";
import { piContext } from "./context";

// pi's own descriptions (packages/coding-agent/src/core/slash-commands.ts). In pi a skill is the
// slash command /skill:<name>; here it is picked with $, as for Codex.
const COMMANDS: Command[] = [
  { name: "new", description: "Start a new session" },
  { name: "compact", description: "Manually compact the session context", needs: "compaction" },
];

// pi's thinking levels (packages/agent/src/types.ts ThinkingLevel). pi clamps them to the model.
const LEVELS = ["off", "minimal", "low", "medium", "high", "xhigh"];

export function createPiAdapter({ url, dispatch }: AdapterOptions): Adapter {
  const map = createPiMapping();
  // edupi's trace events of the current session: the last request body and the prompt's sections.
  let lastRequest: Json = null, fragments: Json[] | null = null;
  const watch = (m: Json) => {
    if (m.type !== "trace") return;
    if (m.name === "modelRequest") lastRequest = m.body;
    if (m.name === "promptAssembled") fragments = m.fragments;
  };
  const rpc = new PiRpcClient(url, {
    onMessage: (message) => { watch(message); map(message).forEach(dispatch); },
    onWire: (direction, message) => dispatch({ type: "wire", direction, message }),
    onStatus: (status, reason) => dispatch({ type: "status", status, reason }),
  });
  let state: Json = null; // the last get_state reply

  async function setLevel(effort: string) {
    if (effort && effort !== state?.thinkingLevel) {
      await rpc.command("set_thinking_level", { level: effort });
      state = await rpc.command("get_state");
    }
  }

  return {
    explain: piExplainer,
    commands: COMMANDS,
    efforts: LEVELS.map((l) => ({ value: l, label: l })),
    protocolNote: "pi RPC: one JSON object per line, tagged by \"type\". A command may carry an \"id\"; pi answers it with {type: \"response\", command, id}. Every other message is an event. There is no handshake.",
    contextTriggers: ["modelRequest"],

    // pi has no handshake: the process already holds a session. get_state names it and its model.
    async connect() {
      await rpc.connect();
      state = await rpc.command("get_state");
      return { models: state.model ? [{ value: state.model.id, label: state.model.name ?? state.model.id }] : [] };
    },
    async startSession(s) {
      if (state?.messageCount || state?.isStreaming) { // "new thread"
        await rpc.command("new_session");
        lastRequest = fragments = null;
      }
      state = await rpc.command("get_state");
      await setLevel(s.effort);
      // get_state has no cwd; pi runs in the directory the launcher started it in.
      return { model: state.model?.id, cwd: new URL(url).searchParams.get("cwd") ?? undefined };
    },
    async send(s, text, skills) {
      await setLevel(s.effort);
      const message = skills.length ? `/skill:${skills[0].name} ${text}` : text; // pi expands one /skill: per prompt
      await rpc.command("prompt", { message });
      state = { ...state, messageCount: (state?.messageCount ?? 0) + 1 };
    },
    async interrupt() { await rpc.command("abort"); },
    async compact() { await rpc.command("compact"); },
    async listSkills(): Promise<SkillInfo[]> {
      const { commands } = await rpc.command("get_commands");
      return commands.filter((c: Json) => c.source === "skill").map((c: Json) => ({
        name: c.name.slice("skill:".length), description: c.description ?? "", path: c.sourceInfo?.path ?? "", scope: c.sourceInfo?.scope ?? "",
      }));
    },
    async runCommand() {},
    // pi has no step mode or context inspector; edupi adds them as debug_* commands later.
    async setStepMode() {},
    async continueStep() {},
    // Until edupi answers a debug_ context command, the Context tab shows the last request edupi traced.
    async context() {
      if (!lastRequest) return null;
      return piContext(lastRequest, fragments, state?.model?.contextWindow ?? 128000,
        "edupi: this is the last request edupi sent (from its modelRequest trace event); the next one adds the reply and your next message.");
    },
    wireLabel: (m) => m.type === "response"
      ? { title: `response ${m.command}`, detail: `${m.id !== undefined ? `id=${m.id} · ` : ""}${m.success ? "ok" : m.error}` }
      : { title: m.type, detail: m.id !== undefined ? `id=${m.id}` : "event" },
    respond() {}, // pi has no approvals
  };
}
