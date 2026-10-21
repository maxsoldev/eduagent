// Mirrors pi packages/agent/src/agent-loop.ts (pinned 16f5f0af4): the agent loop.
// It works with AgentMessages throughout and turns them into provider Messages only at the
// model call. One run: agent_start, then turns (turn_start, messages, turn_end), then agent_end.
import type { AssistantMessage, ToolResultMessage } from "../ai/types.ts";
import type { AgentContext, AgentEvent, AgentLoopConfig, AgentMessage, StreamFn } from "./types.ts";

export type AgentEventSink = (event: AgentEvent) => Promise<void> | void;

/** Starts a run with new prompt messages. They go into the context, each with message events. */
export async function runAgentLoop(
  prompts: AgentMessage[],
  context: AgentContext,
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal: AbortSignal | undefined,
  streamFn: StreamFn,
): Promise<AgentMessage[]> {
  const newMessages: AgentMessage[] = [...prompts];
  const currentContext: AgentContext = { ...context, messages: [...context.messages, ...prompts] };

  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });
  for (const message of prompts) {
    await emit({ type: "message_start", message });
    await emit({ type: "message_end", message });
  }

  await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
  return newMessages;
}

/**
 * Continues from the current context without a new message, e.g. to retry after the context was
 * compacted. The last message must not be an assistant message: the model answers what is there.
 */
export async function runAgentLoopContinue(
  context: AgentContext,
  config: AgentLoopConfig,
  emit: AgentEventSink,
  signal: AbortSignal | undefined,
  streamFn: StreamFn,
): Promise<AgentMessage[]> {
  if (context.messages.length === 0) throw new Error("Cannot continue: no messages in context");
  if (context.messages[context.messages.length - 1].role === "assistant") {
    throw new Error("Cannot continue from message role: assistant");
  }

  const newMessages: AgentMessage[] = [];
  const currentContext: AgentContext = { ...context };

  await emit({ type: "agent_start" });
  await emit({ type: "turn_start" });

  await runLoop(currentContext, newMessages, config, signal, emit, streamFn);
  return newMessages;
}

/** The loop shared by every run: call the model, end the turn, decide whether to go on. */
async function runLoop(
  currentContext: AgentContext,
  newMessages: AgentMessage[],
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
  streamFunction: StreamFn,
): Promise<void> {
  const message = await streamAssistantResponse(currentContext, config, signal, emit, streamFunction);
  newMessages.push(message);

  if (message.stopReason === "error" || message.stopReason === "aborted") {
    await emit({ type: "turn_end", message, toolResults: [] });
    await emit({ type: "agent_end", messages: newMessages });
    return;
  }

  const toolResults: ToolResultMessage[] = []; // edupi does not run tools yet
  await emit({ type: "turn_end", message, toolResults });
  await emit({ type: "agent_end", messages: newMessages });
}

/**
 * Streams one assistant response. This is where AgentMessage[] becomes Message[]. The partial
 * message goes into the context at `start` and is replaced by each update and by the final message.
 */
async function streamAssistantResponse(
  context: AgentContext,
  config: AgentLoopConfig,
  signal: AbortSignal | undefined,
  emit: AgentEventSink,
  streamFunction: StreamFn,
): Promise<AssistantMessage> {
  const llmMessages = await config.convertToLlm(context.messages);
  const llmContext = { messages: llmMessages };

  // Resolved per request, so an expiring key can be refreshed.
  const resolvedApiKey = (config.getApiKey ? await config.getApiKey(config.model.provider) : undefined) || config.apiKey;

  const response = await streamFunction(config.model, llmContext, { ...config, apiKey: resolvedApiKey, signal });
  // Record the requested level, whichever stream function answered.
  const result = async () => Object.assign(await response.result(), { thinkingLevel: config.reasoning ?? "off" });

  let partialMessage: AssistantMessage | null = null;
  let addedPartial = false;

  for await (const event of response) {
    switch (event.type) {
      case "start":
        partialMessage = event.partial;
        context.messages.push(partialMessage);
        addedPartial = true;
        await emit({ type: "message_start", message: { ...partialMessage } });
        break;

      case "text_start":
      case "text_delta":
      case "text_end":
      case "thinking_start":
      case "thinking_delta":
      case "thinking_end":
      case "toolcall_start":
      case "toolcall_delta":
      case "toolcall_end":
        if (partialMessage) {
          partialMessage = event.partial;
          context.messages[context.messages.length - 1] = partialMessage;
          await emit({ type: "message_update", assistantMessageEvent: event, message: { ...partialMessage } });
        }
        break;

      case "done":
      case "error": {
        const finalMessage = await result();
        if (addedPartial) context.messages[context.messages.length - 1] = finalMessage;
        else context.messages.push(finalMessage);
        if (!addedPartial) await emit({ type: "message_start", message: { ...finalMessage } });
        await emit({ type: "message_end", message: finalMessage });
        return finalMessage;
      }
    }
  }

  const finalMessage = await result();
  if (addedPartial) {
    context.messages[context.messages.length - 1] = finalMessage;
  } else {
    context.messages.push(finalMessage);
    await emit({ type: "message_start", message: { ...finalMessage } });
  }
  await emit({ type: "message_end", message: finalMessage });
  return finalMessage;
}
