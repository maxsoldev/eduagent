// A fake OpenAI-compatible Chat Completions server. It replays scripted replies as SSE, so the
// real pi can run with no API key and no network model call (see test/record-pi.mjs).
//
// A script is a list of replies, used in order (the last one repeats):
//   {"text": ["Hel", "lo"], "delayMs": 50}           streamed text pieces
//   {"toolCalls": [{"id", "name", "arguments"}]}      tool calls (finish_reason "tool_calls")
//   {"error": {"status": 400, "message": "..."}}      an HTTP error
//   "promptTokens": N                                 the reported prompt tokens (default 100)
//
// CLI: node fake-chat-completions.mjs <port> <script.json> [requests-log.jsonl]
import { appendFileSync, readFileSync } from "node:fs";
import { createServer } from "node:http";
import { fileURLToPath } from "node:url";

const chunk = (delta, finish = null) => ({ id: "chatcmpl-fake", object: "chat.completion.chunk", created: 0, model: "fake",
  choices: [{ index: 0, delta, finish_reason: finish }] });

/** Starts the server on 127.0.0.1. onRequest gets {method, url, body} of every request. */
export function startFakeChatCompletions(script, { port = 0, onRequest = () => {} } = {}) {
  let next = 0;
  const server = createServer((req, res) => {
    let body = "";
    req.on("data", (d) => (body += d));
    req.on("end", async () => {
      onRequest({ method: req.method, url: req.url, body: body ? JSON.parse(body) : null });
      if (req.method !== "POST" || !req.url.endsWith("/chat/completions")) return res.writeHead(404).end();
      const reply = script[Math.min(next++, script.length - 1)];
      if (reply.error) {
        res.writeHead(reply.error.status ?? 400, { "content-type": "application/json" });
        return res.end(JSON.stringify({ error: { message: reply.error.message, code: reply.error.status ?? 400 } }));
      }
      res.writeHead(200, { "content-type": "text/event-stream" });
      const send = (obj) => res.write(`data: ${JSON.stringify(obj)}\n\n`);
      send(chunk({ role: "assistant", content: "" }));
      for (const piece of reply.text ?? []) {
        if (reply.delayMs) await new Promise((r) => setTimeout(r, reply.delayMs));
        if (res.destroyed) return; // the client aborted
        send(chunk({ content: piece }));
      }
      // Each tool call: one chunk with the name, one with the arguments (as OpenAI streams them).
      (reply.toolCalls ?? []).forEach((tc, index) => {
        send(chunk({ tool_calls: [{ index, id: tc.id, type: "function", function: { name: tc.name, arguments: "" } }] }));
        send(chunk({ tool_calls: [{ index, function: { arguments: JSON.stringify(tc.arguments) } }] }));
      });
      send(chunk({}, reply.toolCalls?.length ? "tool_calls" : "stop"));
      const prompt = reply.promptTokens ?? 100;
      send({ ...chunk({}), choices: [], usage: { prompt_tokens: prompt, completion_tokens: 20, total_tokens: prompt + 20 } });
      res.end("data: [DONE]\n\n");
    });
  });
  return new Promise((resolve) => server.listen(port, "127.0.0.1", () =>
    resolve({ port: server.address().port, close: () => new Promise((r) => { server.closeAllConnections(); server.close(r); }) })));
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const [port, scriptPath, logPath] = process.argv.slice(2);
  const script = JSON.parse(readFileSync(scriptPath, "utf8"));
  const log = logPath ? (r) => appendFileSync(logPath, JSON.stringify(r) + "\n") : () => {};
  const { port: p } = await startFakeChatCompletions(script, { port: Number(port), onRequest: log });
  console.error(`fake Chat Completions server on http://127.0.0.1:${p}/v1`);
}
