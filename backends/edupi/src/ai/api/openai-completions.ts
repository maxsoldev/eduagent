// Mirrors pi packages/ai/src/api/openai-completions.ts (pinned 16f5f0af4): the OpenAI Chat
// Completions API, called with the OpenAI SDK. edupi points the SDK at OpenRouter, which speaks
// the same wire format. Same steps as pi: convert the transcript to Chat Completions messages,
// build the request body, stream the chunks and turn them into AssistantMessageEvents.
import OpenAI from "openai";
import type {
  ChatCompletionAssistantMessageParam,
  ChatCompletionChunk,
  ChatCompletionContentPart,
  ChatCompletionCreateParamsStreaming,
  ChatCompletionMessageParam,
  ChatCompletionTool,
} from "openai/resources/chat/completions";
import type {
  AssistantMessage,
  Message,
  Model,
  SimpleStreamOptions,
  StopReason,
  SystemMessage,
  TextContent,
  ThinkingContent,
  ThinkingLevel,
  Tool,
  ToolCall,
  ToolResultMessage,
  TranscriptContext,
  Usage,
} from "../types.ts";
import { clampThinkingLevel } from "../models.ts";
import { AssistantMessageEventStream } from "../utils/event-stream.ts";
import { parseStreamingJson, parseToolCallArguments } from "../utils/json-parse.ts";
import { getCurrentTools } from "../utils/transcript.ts";

/** pi's resolved OpenRouter compat values (detectCompat); edupi has no other provider. */
interface Compat {
  supportsDeveloperRole: boolean;
  supportsStore: boolean;
  supportsUsageInStreaming: boolean;
}

function getCompat(model: Model): Compat {
  // OpenRouter passes the developer role only to OpenAI and Anthropic models.
  const supportsDeveloperRole = model.id.startsWith("openai/") || model.id.startsWith("anthropic/");
  return { supportsDeveloperRole, supportsStore: true, supportsUsageInStreaming: true };
}

function getClientApiKey(provider: string, apiKey: string | undefined): string {
  if (apiKey) return apiKey;
  throw new Error(`No API key for provider: ${provider}`);
}

/** If the history has tool calls but no tools are offered now, pi still sends `tools: []`. */
function hasToolHistory(messages: Message[]): boolean {
  return messages.some((msg) => msg.role === "toolResult" || (msg.role === "assistant" && msg.content.some((b) => b.type === "toolCall")));
}

/** stream()'s own options: streamSimple turns the thinking level into a reasoning effort. */
export interface OpenAICompletionsOptions extends SimpleStreamOptions {
  reasoningEffort?: Exclude<ThinkingLevel, "off">;
}

/** The Chat Completions delta fields that can carry reasoning text; the first non-empty one wins. */
const REASONING_FIELDS = ["reasoning_content", "reasoning", "reasoning_text"] as const;

/** A tool call block while it streams: the raw arguments text and the stream index ride along until the end. */
type StreamingToolCall = ToolCall & { partialArgs?: string; streamIndex?: number };

function emptyUsage(): Usage {
  return { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } };
}

/** Streams one Chat Completions response. Failures end the stream with an `error` event; it never throws. */
export function stream(model: Model, context: TranscriptContext, options?: OpenAICompletionsOptions): AssistantMessageEventStream {
  const stream = new AssistantMessageEventStream();

  (async () => {
    const output: AssistantMessage = {
      role: "assistant",
      content: [],
      api: model.api,
      provider: model.provider,
      model: model.id,
      usage: emptyUsage(),
      stopReason: "pending",
      timestamp: Date.now(),
    };

    let requested = false; // edupi: a model response is traced only after a traced request
    try {
      const apiKey = getClientApiKey(model.provider, options?.apiKey);
      const compat = getCompat(model);
      const client = createClient(model, apiKey, options?.headers, options?.fetch, options?.sessionId);
      const params = buildParams(model, context, options, compat);
      requested = true;
      await options?.probe?.modelRequest?.({ api: model.api, url: `${model.baseUrl}/chat/completions`, body: params }, options?.sessionId);
      const openaiStream = await client.chat.completions.create(params, {
        ...(options?.signal ? { signal: options.signal } : {}),
        maxRetries: 0,
      });
      stream.push({ type: "start", partial: output });

      let textBlock: TextContent | null = null;
      let thinkingBlock: ThinkingContent | null = null;
      let hasFinishReason = false;
      const blocks = output.content;
      const toolCallBlocksByIndex = new Map<number, StreamingToolCall>();
      const getContentIndex = (block: (typeof blocks)[number]) => blocks.indexOf(block);
      const ensureTextBlock = () => {
        if (!textBlock) {
          textBlock = { type: "text", text: "" };
          blocks.push(textBlock);
          stream.push({ type: "text_start", contentIndex: getContentIndex(textBlock), partial: output });
        }
        return textBlock;
      };
      // The field the reasoning came in is kept as the signature, so a replay can use the same field.
      const ensureThinkingBlock = (thinkingSignature: string) => {
        if (!thinkingBlock) {
          thinkingBlock = { type: "thinking", thinking: "", thinkingSignature };
          blocks.push(thinkingBlock);
          stream.push({ type: "thinking_start", contentIndex: getContentIndex(thinkingBlock), partial: output });
        }
        return thinkingBlock;
      };
      // Tool calls are keyed by the stream's index: the first delta has the id and the name, later ones only argument text.
      const ensureToolCallBlock = (delta: { index?: number; id?: string; function?: { name?: string } }) => {
        let block = delta.index !== undefined ? toolCallBlocksByIndex.get(delta.index) : undefined;
        if (!block) {
          block = { type: "toolCall", id: delta.id || "", name: delta.function?.name ?? "", arguments: {}, partialArgs: "", streamIndex: delta.index };
          if (delta.index !== undefined) toolCallBlocksByIndex.set(delta.index, block);
          blocks.push(block);
          stream.push({ type: "toolcall_start", contentIndex: getContentIndex(block), partial: output });
        }
        return block;
      };
      const finishBlock = (block: (typeof blocks)[number]) => {
        if (block.type === "text") {
          stream.push({ type: "text_end", contentIndex: blocks.indexOf(block), content: block.text, partial: output });
        } else if (block.type === "thinking") {
          stream.push({ type: "thinking_end", contentIndex: blocks.indexOf(block), content: block.thinking, partial: output });
        } else if (block.type === "toolCall") {
          const toolCall = block as StreamingToolCall;
          Object.assign(toolCall, parseToolCallArguments(toolCall.partialArgs));
          delete toolCall.partialArgs; // only the parsed arguments are kept
          delete toolCall.streamIndex;
          stream.push({ type: "toolcall_end", contentIndex: blocks.indexOf(block), toolCall, partial: output });
        }
      };

      for await (const chunk of openaiStream) {
        await options?.probe?.streamEvent?.(chunk);
        // Every chunk of one completion carries the same id.
        output.responseId ||= chunk.id;
        if (typeof chunk.model === "string" && chunk.model.length > 0 && chunk.model !== model.id) {
          output.responseModel ||= chunk.model;
        }
        if (chunk.usage) output.usage = parseChunkUsage(chunk.usage, model);

        const choice = Array.isArray(chunk.choices) ? chunk.choices[0] : undefined;
        if (!choice) continue;

        if (choice.finish_reason) {
          output.rawStopReason = choice.finish_reason;
          const result = mapStopReason(choice.finish_reason);
          output.stopReason = result.stopReason;
          if (result.errorMessage) output.errorMessage = result.errorMessage;
          hasFinishReason = true;
        }

        // Reasoning before content: the thinking block must come before the text block.
        const deltaFields = (choice.delta ?? {}) as Record<string, unknown>;
        const reasoningField = REASONING_FIELDS.find((field) => typeof deltaFields[field] === "string" && (deltaFields[field] as string).length > 0);
        if (reasoningField) {
          const delta = deltaFields[reasoningField] as string;
          const block = ensureThinkingBlock(reasoningField);
          block.thinking += delta;
          stream.push({ type: "thinking_delta", contentIndex: getContentIndex(block), delta, partial: output });
        }

        if (choice.delta?.content) {
          const block = ensureTextBlock();
          block.text += choice.delta.content;
          stream.push({ type: "text_delta", contentIndex: getContentIndex(block), delta: choice.delta.content, partial: output });
        }

        for (const toolCall of choice.delta?.tool_calls ?? []) {
          const block = ensureToolCallBlock(toolCall);
          if (!block.id && toolCall.id) block.id = toolCall.id;
          if (!block.name && toolCall.function?.name) block.name = toolCall.function.name;
          const delta = toolCall.function?.arguments ?? "";
          if (delta) {
            block.partialArgs = (block.partialArgs ?? "") + delta;
            block.arguments = parseStreamingJson(block.partialArgs, block.arguments);
          }
          stream.push({ type: "toolcall_delta", contentIndex: getContentIndex(block), delta, partial: output });
        }
      }

      for (const block of blocks) finishBlock(block);
      if (options?.signal?.aborted) throw new Error("Request was aborted");
      if (output.stopReason === "error") throw new Error(output.errorMessage || "Provider returned an error stop reason");
      if (!hasFinishReason || output.stopReason === "pending") throw new Error("Stream ended without finish_reason");

      await options?.probe?.modelResponse?.(output);
      stream.push({ type: "done", reason: output.stopReason as "stop" | "length" | "toolUse", message: output });
      stream.end();
    } catch (error) {
      output.stopReason = options?.signal?.aborted ? "aborted" : "error";
      output.errorMessage = error instanceof Error ? error.message : String(error);
      // OpenRouter puts the upstream provider's error text here.
      const rawMetadata = (error as { error?: { metadata?: { raw?: unknown } } })?.error?.metadata?.raw;
      if (rawMetadata && !output.errorMessage.includes(String(rawMetadata))) output.errorMessage += `\n${rawMetadata}`;
      if (requested) await options?.probe?.modelResponse?.(output);
      stream.push({ type: "error", reason: output.stopReason, error: output });
      stream.end();
    }
  })();

  return stream;
}

/**
 * The agent's entry point: pi's streamSimple fills request options from the model, clamps the
 * thinking level to what the model supports and passes it on as the reasoning effort.
 */
export function streamSimple(model: Model, context: TranscriptContext, options?: SimpleStreamOptions): AssistantMessageEventStream {
  const clampedReasoning = options?.reasoning ? clampThinkingLevel(model, options.reasoning) : undefined;
  const reasoningEffort = clampedReasoning === "off" ? undefined : clampedReasoning;
  return stream(model, context, { ...options, maxTokens: options?.maxTokens ?? model.maxTokens, reasoningEffort });
}

function createClient(model: Model, apiKey: string, optionsHeaders?: Record<string, string>,
  fetch?: typeof globalThis.fetch, sessionId?: string) {
  const headers: Record<string, string> = { ...model.headers };
  if (sessionId) headers["x-session-id"] = sessionId; // OpenRouter session affinity: same upstream, warm cache
  Object.assign(headers, optionsHeaders);
  return new OpenAI({ apiKey, baseURL: model.baseUrl, dangerouslyAllowBrowser: true, fetch, defaultHeaders: headers });
}

/** The request body. Field order follows pi's, so a recorded body reads the same as pi's. */
export function buildParams(model: Model, context: TranscriptContext, options: OpenAICompletionsOptions | undefined,
  compat: Compat = getCompat(model)): ChatCompletionCreateParamsStreaming {
  const params: ChatCompletionCreateParamsStreaming = {
    model: model.id,
    messages: convertMessages(model, context, compat),
    stream: true,
  };
  if (compat.supportsUsageInStreaming) params.stream_options = { include_usage: true };
  if (compat.supportsStore) params.store = false;
  if (options?.maxTokens) params.max_completion_tokens = options.maxTokens;
  if (options?.temperature !== undefined) params.temperature = options.temperature;
  // The tools come from the transcript: the system messages declare them.
  const tools = getCurrentTools(context.messages);
  if (tools.length > 0) params.tools = convertTools(tools);
  else if (hasToolHistory(context.messages)) params.tools = [];
  // OpenRouter's reasoning object works for every provider behind it (pi's thinkingFormat
  // "openrouter"). No level means reasoning off: effort "none". Non-reasoning models get nothing.
  if (model.reasoning) {
    (params as typeof params & { reasoning?: { effort: string } }).reasoning = { effort: options?.reasoningEffort ?? "none" };
  }
  return params;
}

function systemText(message: SystemMessage): string {
  const content = typeof message.content === "string" ? message.content : message.content.map((c) => c.text).join("\n");
  const parts = [content, ...Object.values(message.sections ?? {}).filter((s): s is string => s !== null)];
  return parts.filter((p) => p.length > 0).join("\n\n");
}

/** Transcript messages to Chat Completions messages. */
export function convertMessages(model: Model, context: TranscriptContext, compat: Compat): ChatCompletionMessageParam[] {
  const params: ChatCompletionMessageParam[] = [];
  // Reasoning models take the harness's instructions as "developer", as in the Responses API.
  const instructionRole = model.reasoning && compat.supportsDeveloperRole ? "developer" : "system";

  for (const msg of context.messages) {
    if (msg.role === "system") {
      const text = systemText(msg);
      if (text.length > 0) params.push({ role: instructionRole, content: text });
    } else if (msg.role === "user") {
      if (typeof msg.content === "string") {
        params.push({ role: "user", content: msg.content });
        continue;
      }
      const content = msg.content
        .filter((item) => item.type !== "text" || item.text.length > 0)
        .map((item): ChatCompletionContentPart => item.type === "text"
          ? { type: "text", text: item.text }
          : { type: "image_url", image_url: { url: `data:${item.mimeType};base64,${item.data}` } });
      if (content.length > 0) params.push({ role: "user", content });
    } else if (msg.role === "assistant") {
      const assistantMsg: ChatCompletionAssistantMessageParam = { role: "assistant", content: null };
      // Assistant text goes back as one plain string, the Chat Completions standard.
      const text = msg.content.filter((b): b is TextContent => b.type === "text" && b.text.trim().length > 0)
        .map((b) => b.text).join("");
      if (text.length > 0) assistantMsg.content = text;
      // Reasoning goes back in the field it came in (the block's signature), so the model sees its thinking.
      const thinkingBlocks = msg.content.filter((b): b is ThinkingContent => b.type === "thinking" && b.thinking.trim().length > 0);
      const signature = thinkingBlocks[0]?.thinkingSignature;
      if (signature && (REASONING_FIELDS as readonly string[]).includes(signature)) {
        (assistantMsg as unknown as Record<string, unknown>)[signature] = thinkingBlocks.map((b) => b.thinking).join("\n");
      }
      const toolCalls = msg.content.filter((b): b is ToolCall => b.type === "toolCall");
      if (toolCalls.length > 0) {
        assistantMsg.tool_calls = toolCalls.map((tc) => ({
          id: tc.id, type: "function" as const, function: { name: tc.name, arguments: JSON.stringify(tc.arguments) },
        }));
      }
      // Providers refuse an assistant message with neither content nor tool calls (an aborted reply).
      if (assistantMsg.content === null && !assistantMsg.tool_calls) continue;
      params.push(assistantMsg);
    } else if (msg.role === "toolResult") {
      params.push(convertToolResult(msg));
    }
  }
  return params;
}

/** One "tool" message per result, answering the call with the same id. Its content is plain text. */
function convertToolResult(msg: ToolResultMessage): ChatCompletionMessageParam {
  const text = msg.content.filter((c): c is TextContent => c.type === "text").map((c) => c.text).join("\n");
  const hasImages = msg.content.some((c) => c.type === "image");
  const content = text.trim().length > 0 ? text : hasImages ? "(see attached image)" : "(no tool output)";
  return { role: "tool", content, tool_call_id: msg.toolCallId };
}

/** Tools as Chat Completions function specs. OpenRouter gets no `strict` field (pi's compat: supportsStrictMode false). */
function convertTools(tools: Tool[]): ChatCompletionTool[] {
  return tools.map((tool) => ({
    type: "function",
    function: { name: tool.name, description: tool.description, parameters: tool.parameters as Record<string, unknown> },
  }));
}

function parseChunkUsage(rawUsage: NonNullable<ChatCompletionChunk["usage"]>, model: Model): Usage {
  const promptTokens = rawUsage.prompt_tokens || 0;
  const cacheReadTokens = rawUsage.prompt_tokens_details?.cached_tokens ?? 0;
  const cacheWriteTokens = (rawUsage.prompt_tokens_details as { cache_write_tokens?: number } | undefined)?.cache_write_tokens || 0;
  const input = Math.max(0, promptTokens - cacheReadTokens - cacheWriteTokens);
  const outputTokens = rawUsage.completion_tokens || 0; // already includes reasoning tokens
  const usage: Usage = {
    input,
    output: outputTokens,
    cacheRead: cacheReadTokens,
    cacheWrite: cacheWriteTokens,
    reasoning: rawUsage.completion_tokens_details?.reasoning_tokens || 0,
    totalTokens: input + outputTokens + cacheReadTokens + cacheWriteTokens,
    cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  };
  calculateCost(model, usage);
  return usage;
}

/** Mirrors pi packages/ai/src/models.ts calculateCost: model prices are USD per million tokens. */
export function calculateCost(model: Model, usage: Usage): Usage["cost"] {
  usage.cost.input = (model.cost.input / 1_000_000) * usage.input;
  usage.cost.output = (model.cost.output / 1_000_000) * usage.output;
  usage.cost.cacheRead = (model.cost.cacheRead / 1_000_000) * usage.cacheRead;
  usage.cost.cacheWrite = (model.cost.cacheWrite / 1_000_000) * usage.cacheWrite;
  usage.cost.total = usage.cost.input + usage.cost.output + usage.cost.cacheRead + usage.cost.cacheWrite;
  return usage.cost;
}

function mapStopReason(reason: string): { stopReason: StopReason; errorMessage?: string } {
  switch (reason) {
    case "stop":
    case "end":
      return { stopReason: "stop" };
    case "length":
      return { stopReason: "length" };
    case "function_call":
    case "tool_calls":
      return { stopReason: "toolUse" };
    default:
      return { stopReason: "error", errorMessage: `Provider finish_reason: ${reason}` };
  }
}
