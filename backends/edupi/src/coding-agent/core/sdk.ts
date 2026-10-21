// Mirrors pi packages/coding-agent/src/core/sdk.ts (pinned 16f5f0af4), createAgentSession: builds
// the Agent and the AgentSession for one session file. If the file already has messages, the
// Agent starts from the context rebuilt from its entries, with the session's model and thinking
// level. A new session first records its model and thinking level as entries.
import { Agent } from "../../agent/agent.ts";
import type { StreamFn, ThinkingLevel } from "../../agent/types.ts";
import { openRouterModel } from "../../ai/providers/openrouter.ts";
import type { Model } from "../../ai/types.ts";
import { AgentSession } from "./agent-session.ts";
import { convertToLlm } from "./messages.ts";
import type { Probe } from "./probe.ts";
import type { SessionManager } from "./session-manager.ts";
import { createCodingTools } from "./tools/index.ts";

export interface CreateAgentSessionOptions {
  sessionManager: SessionManager;
  /** The model from --model. Without it: the session's model, else edupi's default. */
  model?: Model;
  streamFn: StreamFn;
  getApiKey: (provider: string) => string | undefined;
  /** Where the tools work. Default: the session's cwd. */
  cwd?: string;
  /** edupi: the teaching extras' hooks. */
  probe?: Probe;
}

export function createAgentSession(options: CreateAgentSessionOptions): AgentSession {
  const { sessionManager } = options;
  const existingSession = sessionManager.buildSessionContext();
  const hasExistingSession = existingSession.messages.length > 0;
  const hasThinkingEntry = sessionManager.getBranch().some((entry) => entry.type === "thinking_level_change");

  // pi looks the session's model up in its model registry. edupi knows only OpenRouter models.
  let model = options.model;
  if (!model && hasExistingSession && existingSession.model?.provider === "openrouter") {
    model = openRouterModel(existingSession.model.modelId);
  }
  model ??= openRouterModel();

  let thinkingLevel: ThinkingLevel = hasExistingSession && hasThinkingEntry ? (existingSession.thinkingLevel as ThinkingLevel) : "off";
  if (!model.reasoning) thinkingLevel = "off"; // pi clamps the level to what the model supports

  // pi's default coding tools, working in the session's directory.
  const tools = createCodingTools(options.cwd ?? sessionManager.getCwd());

  const agent = new Agent({
    initialState: { model, thinkingLevel, tools, messages: existingSession.messages },
    convertToLlm,
    streamFn: options.streamFn,
    getApiKey: options.getApiKey,
    sessionId: sessionManager.getSessionId(),
    probe: options.probe,
  });

  // Record the settings, so a reopened session restores them.
  if (hasExistingSession) {
    if (!hasThinkingEntry) sessionManager.appendThinkingLevelChange(thinkingLevel);
  } else {
    sessionManager.appendModelChange(model.provider, model.id);
    sessionManager.appendThinkingLevelChange(thinkingLevel);
  }

  return new AgentSession({ agent, sessionManager, getApiKey: options.getApiKey });
}
