// Mirrors pi packages/coding-agent/src/main.ts (pinned 16f5f0af4): parse the arguments, build
// the model, the Agent and the AgentSession, then run the chosen mode. edupi has one mode, RPC
// (pi's `pi --mode rpc`), because the launcher talks to every backend over stdio.
import { randomUUID } from "node:crypto";
import { appendFileSync } from "node:fs";
import { Agent } from "../agent/agent.ts";
import type { StreamFn } from "../agent/types.ts";
import { streamSimple } from "../ai/api/openai-completions.ts";
import { fauxProvider, loadFauxScript } from "../ai/providers/faux.ts";
import { OPENROUTER_API_KEY_ENV, openRouterModel } from "../ai/providers/openrouter.ts";
import { Tracer } from "../observe/tracer.ts";
import { parseArgs } from "./cli/args.ts";
import { AgentSession } from "./core/agent-session.ts";
import { runRpcMode } from "./modes/rpc/rpc-mode.ts";

export async function main(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv);
  if (parsed.mode !== "rpc") parsed.diagnostics.push({ type: "error", message: "edupi needs --mode rpc" });
  for (const d of parsed.diagnostics) console.error(`edupi: ${d.message}`);
  if (parsed.diagnostics.length > 0) process.exit(1);

  const model = openRouterModel(parsed.model);

  // With --faux, the OpenAI SDK's HTTP call goes to the faux provider instead of OpenRouter.
  let fetch: typeof globalThis.fetch | undefined;
  if (parsed.faux) {
    const fauxLog = parsed.fauxLog;
    const faux = fauxProvider({ onRequest: fauxLog ? (request) => appendFileSync(fauxLog, `${JSON.stringify(request)}\n`) : undefined });
    faux.setResponses(loadFauxScript(parsed.faux));
    fetch = faux.fetch;
  }
  const getApiKey = (provider: string) => (parsed.faux ? "faux" : provider === "openrouter" ? process.env[OPENROUTER_API_KEY_ENV] || undefined : undefined);
  // The teaching extras watch the core through its probe hooks; the core does not know them.
  const tracer = new Tracer();
  const streamFn: StreamFn = (m, context, options) => streamSimple(m, context, { ...options, fetch, probe: tracer });

  // pi's session ids are UUIDv7 (time-ordered); any unique id works here.
  const sessionId = randomUUID();
  const agent = new Agent({ initialState: { model }, streamFn, getApiKey, sessionId });
  const session = new AgentSession({ agent, sessionId, getApiKey });
  await runRpcMode(session, { connect: (output) => tracer.connect(output) });
}
