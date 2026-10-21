// Mirrors pi packages/coding-agent/src/main.ts (pinned 16f5f0af4): parse the arguments, build
// the model, the Agent and the AgentSession, then run the chosen mode. edupi has one mode, RPC
// (pi's `pi --mode rpc`), because the launcher talks to every backend over stdio.
import { appendFileSync } from "node:fs";
import type { StreamFn } from "../agent/types.ts";
import { streamSimple } from "../ai/api/openai-completions.ts";
import { fauxProvider, loadFauxScript } from "../ai/providers/faux.ts";
import { OPENROUTER_API_KEY_ENV } from "../ai/providers/openrouter.ts";
import { Tracer } from "../observe/tracer.ts";
import { type Args, parseArgs } from "./cli/args.ts";
import { AgentSessionRuntime } from "./core/agent-session-runtime.ts";
import { ModelRegistry } from "./core/model-registry.ts";
import { createAgentSession } from "./core/sdk.ts";
import { SessionManager } from "./core/session-manager.ts";
import { SettingsManager } from "./core/settings-manager.ts";
import { runRpcMode } from "./modes/rpc/rpc-mode.ts";

export async function main(argv: string[]): Promise<void> {
  const parsed = parseArgs(argv);
  if (parsed.mode !== "rpc") parsed.diagnostics.push({ type: "error", message: "edupi needs --mode rpc" });
  for (const d of parsed.diagnostics) console.error(`edupi: ${d.message}`);
  if (parsed.diagnostics.length > 0) process.exit(1);

  // With --faux, the OpenAI SDK's HTTP calls (and the model list) go to the faux provider instead of OpenRouter.
  let fetch: typeof globalThis.fetch | undefined;
  if (parsed.faux) {
    const fauxLog = parsed.fauxLog;
    const script = loadFauxScript(parsed.faux);
    const faux = fauxProvider({ models: script.models, onRequest: fauxLog ? (request) => appendFileSync(fauxLog, `${JSON.stringify(request)}\n`) : undefined });
    faux.setResponses(script.responses);
    fetch = faux.fetch;
  }
  const modelRegistry = await ModelRegistry.load({ fetch, offline: parsed.offline });
  const model = parsed.model ? modelRegistry.find("openrouter", parsed.model) : undefined; // else the session's, else the default
  const getApiKey = (provider: string) => (parsed.faux ? "faux" : provider === "openrouter" ? process.env[OPENROUTER_API_KEY_ENV] || undefined : undefined);
  // The teaching extras watch the core through its probe hooks; the core does not know them.
  const tracer = new Tracer();
  const streamFn: StreamFn = (m, context, options) => streamSimple(m, context, { ...options, fetch, probe: tracer });

  const settingsManager = SettingsManager.create();
  const cwd = process.cwd();
  const createRuntime = (sessionManager: SessionManager) => createAgentSession({ sessionManager, model, modelRegistry, streamFn, getApiKey, settingsManager, probe: tracer });
  const session = createRuntime(createSessionManager(parsed, cwd));
  // The tracer lives in streamFn, which every session from createRuntime shares, so it survives new_session.
  await runRpcMode(new AgentSessionRuntime(session, cwd, createRuntime), { connect: (output) => tracer.connect(output) });
}

/** Which session to start with: pi's --no-session, --session, --continue, else a new one. */
function createSessionManager(parsed: Args, cwd: string): SessionManager {
  if (parsed.noSession) return SessionManager.inMemory(cwd);
  if (parsed.session) return SessionManager.open(parsed.session);
  if (parsed.continue) return SessionManager.continueRecent(cwd);
  return SessionManager.create(cwd);
}
