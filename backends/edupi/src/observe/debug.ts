// edupi only: the debug_ commands of RPC mode, as educodex's debug/stepMode/set, debug/continue
// and debug/context/get. pi has no such commands. Step mode lives in the Tracer (the core's
// probe); get context builds the exact next request body from the session's state.
import { buildParams, toCompletionsOptions } from "../ai/api/openai-completions.ts";
import type { AgentSession } from "../coding-agent/core/agent-session.ts";
import { estimateProjectedContextTokens } from "../coding-agent/core/compaction/compaction.ts";
import type { DebugCommands } from "../coding-agent/modes/rpc/rpc-mode.ts";
import type { Tracer } from "./tracer.ts";

export function debugCommands(tracer: Tracer): DebugCommands {
  const { stepper } = tracer;
  return {
    setStepMode(enabled, breakpoints) {
      stepper.configure(enabled, breakpoints);
      return { enabled: stepper.enabled, breakpoints: [...stepper.breakpoints].sort() };
    },
    continue: () => stepper.release(),
    getContext,
  };
}

// The next request, built as the loop builds it (streamAssistantResponse, then streamSimple). Paused at
// beforeModelRequest, it is the body sent next; when idle, the next prompt adds its user message (and
// a system message if the prompt's sections changed). tokens and autoCompactLimit are the numbers
// pi's threshold rule compares (AgentSession._checkCompaction).
async function getContext(session: AgentSession) {
  const { agent, sessionManager, settingsManager } = session;
  const model = agent.state.model;
  const messages = await agent.convertToLlm(agent.state.messages);
  const reasoning = agent.state.thinkingLevel === "off" ? undefined : agent.state.thinkingLevel;
  const body = buildParams(model, { messages }, toCompletionsOptions(model, { reasoning }));
  const tokens = estimateProjectedContextTokens(sessionManager.buildSessionProjection(), sessionManager.getBranch()).tokens;
  return {
    body,
    messageCount: agent.state.messages.length,
    tokens,
    contextWindow: model.contextWindow,
    autoCompactLimit: model.contextWindow - settingsManager.getCompactionSettings().reserveTokens,
  };
}
