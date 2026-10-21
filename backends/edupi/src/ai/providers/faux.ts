// Mirrors pi packages/ai/src/providers/faux.ts (pinned 16f5f0af4): a scripted model for tests.
// You queue assistant messages; each model request takes the next one and streams it back in
// small random chunks, as a real model would.
// Unlike pi's faux provider, which replaces the whole API, edupi's fakes only the HTTP endpoint:
// it is a `fetch` for the OpenAI SDK that answers with Chat Completions SSE chunks. So the real
// openai-completions code runs in tests too, and every request body can be recorded.
import { readFileSync } from "node:fs";
import type { AssistantMessage, StopReason, TextContent } from "../types.ts";

const DEFAULT_MIN_TOKEN_SIZE = 3;
const DEFAULT_MAX_TOKEN_SIZE = 5;

export type FauxContentBlock = TextContent;

export function fauxText(text: string): TextContent {
  return { type: "text", text };
}

/** A scripted reply. Only content and stopReason matter; the provider fills in the rest. */
export function fauxAssistantMessage(content: string | FauxContentBlock | FauxContentBlock[],
  options: { stopReason?: StopReason } = {}): AssistantMessage {
  const blocks = typeof content === "string" ? [fauxText(content)] : Array.isArray(content) ? content : [content];
  return {
    role: "assistant",
    content: blocks,
    api: "faux",
    provider: "faux",
    model: "faux-1",
    usage: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, totalTokens: 0, cost: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 } },
    stopReason: options.stopReason ?? "stop",
    timestamp: Date.now(),
  };
}

export interface RegisterFauxProviderOptions {
  tokensPerSecond?: number; // delay between chunks; unset = as fast as possible
  tokenSize?: { min?: number; max?: number }; // chunk size in tokens (4 characters each)
  onRequest?: (request: { url: string; body: unknown }) => void;
}

export interface FauxProvider {
  fetch: typeof globalThis.fetch;
  state: { callCount: number };
  setResponses(responses: AssistantMessage[]): void;
  appendResponses(responses: AssistantMessage[]): void;
  getPendingResponseCount(): number;
}

function estimateTokens(text: string): number {
  return Math.ceil(text.length / 4);
}

function splitStringByTokenSize(text: string, minTokenSize: number, maxTokenSize: number): string[] {
  const chunks: string[] = [];
  let index = 0;
  while (index < text.length) {
    const tokenSize = minTokenSize + Math.floor(Math.random() * (maxTokenSize - minTokenSize + 1));
    const charSize = Math.max(1, tokenSize * 4);
    chunks.push(text.slice(index, index + charSize));
    index += charSize;
  }
  return chunks.length > 0 ? chunks : [""];
}

function scheduleChunk(chunk: string, tokensPerSecond: number | undefined): Promise<void> {
  if (!tokensPerSecond || tokensPerSecond <= 0) return new Promise((resolve) => setImmediate(resolve));
  return new Promise((resolve) => setTimeout(resolve, (estimateTokens(chunk) / tokensPerSecond) * 1000));
}

const FINISH_REASONS: Partial<Record<StopReason, string>> = { stop: "stop", length: "length", toolUse: "tool_calls" };

export function fauxProvider(options: RegisterFauxProviderOptions = {}): FauxProvider {
  const minTokenSize = Math.max(1, Math.min(options.tokenSize?.min ?? DEFAULT_MIN_TOKEN_SIZE, options.tokenSize?.max ?? DEFAULT_MAX_TOKEN_SIZE));
  const maxTokenSize = Math.max(minTokenSize, options.tokenSize?.max ?? DEFAULT_MAX_TOKEN_SIZE);
  let pendingResponses: AssistantMessage[] = [];
  const state = { callCount: 0 };

  const fetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const url = String(input instanceof Request ? input.url : input);
    const body = JSON.parse(String(init?.body ?? "null"));
    options.onRequest?.({ url, body });
    state.callCount++;
    const message = pendingResponses.shift();
    if (!message) {
      return Response.json({ error: { message: "No more faux responses queued" } }, { status: 500 });
    }

    // The SSE chunks a Chat Completions endpoint sends for this message.
    const chunk = (delta: object, finishReason: string | null = null, usage?: object) => ({
      id: "chatcmpl-faux", object: "chat.completion.chunk", created: Math.floor(Date.now() / 1000), model: body.model,
      choices: usage ? [] : [{ index: 0, delta, finish_reason: finishReason }], ...(usage ? { usage } : {}),
    });
    const promptTokens = estimateTokens(JSON.stringify(body.messages));
    const outputText = message.content.map((block) => block.type === "text" ? block.text : "").join("");
    const usage = { prompt_tokens: promptTokens, completion_tokens: estimateTokens(outputText), total_tokens: promptTokens + estimateTokens(outputText) };

    const encoder = new TextEncoder();
    const sse = new ReadableStream<Uint8Array>({
      async start(controller) {
        const send = (data: object) => controller.enqueue(encoder.encode(`data: ${JSON.stringify(data)}\n\n`));
        send(chunk({ role: "assistant", content: "" }));
        for (const block of message.content) {
          if (block.type !== "text") continue;
          for (const piece of splitStringByTokenSize(block.text, minTokenSize, maxTokenSize)) {
            await scheduleChunk(piece, options.tokensPerSecond);
            if (init?.signal?.aborted) return controller.error(new Error("Request was aborted"));
            send(chunk({ content: piece }));
          }
        }
        send(chunk({}, FINISH_REASONS[message.stopReason] ?? "stop"));
        send(chunk({}, null, usage));
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      },
    });
    return new Response(sse, { status: 200, headers: { "content-type": "text/event-stream" } });
  };

  return {
    fetch,
    state,
    setResponses(responses) {
      pendingResponses = [...responses];
    },
    appendResponses(responses) {
      pendingResponses.push(...responses);
    },
    getPendingResponseCount() {
      return pendingResponses.length;
    },
  };
}

/**
 * Reads a faux script file: `{"responses": [...]}`. A response is a string (one text reply) or
 * `{"content": string | blocks, "stopReason"?: ...}`, the arguments of fauxAssistantMessage.
 */
export function loadFauxScript(path: string): AssistantMessage[] {
  const script = JSON.parse(readFileSync(path, "utf8"));
  return script.responses.map((step: string | { content: string | FauxContentBlock[]; stopReason?: StopReason }) =>
    typeof step === "string" ? fauxAssistantMessage(step) : fauxAssistantMessage(step.content, { stopReason: step.stopReason }));
}
