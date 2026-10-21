// The pi adapter's client half: sends pi RPC commands (packages/coding-agent/src/modes/rpc/rpc-types.ts).
// Incoming messages go through the pi mapping (mapping.ts) into the view model.
import type { Adapter, AdapterOptions, Command, SkillInfo } from "../types";
import type { Json } from "../../view/model";
import { PiRpcClient } from "./rpc";
import { createPiMapping } from "./mapping";
import { piExplainer } from "./explain";

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
  const rpc = new PiRpcClient(url, {
    onMessage: (message) => map(message).forEach(dispatch),
    onWire: (direction, message) => dispatch({ type: "wire", direction, message }),
    onStatus: (status, reason) => dispatch({ type: "status", status, reason }),
  });
  let state: Json = null; // the last get_state reply
  let resumed = false; // connect found a session with messages: the first startSession keeps it

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
    contextTriggers: [],

    // pi has no handshake: the process already holds a session. get_state names it and its model;
    // get_messages shows a session already in progress (edupi or pi started with --continue).
    async connect() {
      await rpc.connect();
      state = await rpc.command("get_state");
      const { messages } = await rpc.command("get_messages");
      resumed = messages.some((m: Json) => m.role !== "system");
      return { models: state.model ? [{ value: state.model.id, label: state.model.name ?? state.model.id }] : [] };
    },
    async startSession(s) {
      if (resumed) resumed = false; // keep the session connect showed
      else if (state?.messageCount || state?.isStreaming) await rpc.command("new_session"); // "new thread"
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
    async interrupt() { await rpc.command("abort"); }, // the reply comes once the run has settled
    // Both reply "queued" at once; queue_update events show the queues, and the message starts later.
    async steer(text) { await rpc.command("steer", { message: text }); },
    async followUp(text) { await rpc.command("follow_up", { message: text }); },
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
    async context() { return null; },
    wireLabel: (m) => m.type === "response"
      ? { title: `response ${m.command}`, detail: `${m.id !== undefined ? `id=${m.id} · ` : ""}${m.success ? "ok" : m.error}` }
      : { title: m.type, detail: m.id !== undefined ? `id=${m.id}` : "event" },
    respond() {}, // pi has no approvals
  };
}
