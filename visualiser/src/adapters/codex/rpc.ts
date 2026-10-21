// A JSON-RPC "lite" client (Codex app-server style): like JSON-RPC 2.0 but without "jsonrpc": "2.0".
// The server can also send *requests* to us (approvals); we answer them with respond().
// This is the Codex adapter's transport (adapters/codex/client.ts).
import type { Direction, Json } from "../../view/model";

export type WireMessage = { id?: string | number; method?: string; params?: Json; result?: Json; error?: Json };

type Handlers = {
  onMessage: (message: WireMessage) => void; // notifications and server -> client requests
  onWire: (direction: Direction, message: WireMessage) => void;
  onStatus: (status: "connecting" | "open" | "closed", reason?: string) => void;
};

export class RpcClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
  constructor(private url: string, private h: Handlers) {}

  connect(): Promise<void> {
    this.h.onStatus("connecting");
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url);
      this.ws = ws;
      ws.onopen = () => {
        this.h.onStatus("open");
        resolve();
      };
      ws.onerror = () => reject(new Error(`cannot connect to ${this.url}`));
      // The launcher closes with a reason when the backend process exits ("educodex exited with code 1").
      ws.onclose = (e) => {
        for (const p of this.pending.values()) p.reject(new Error(e.reason || "connection closed"));
        this.pending.clear();
        this.h.onStatus("closed", e.reason);
      };
      ws.onmessage = (e) => this.receive(JSON.parse(e.data));
    });
  }

  private send(message: WireMessage) {
    this.h.onWire("out", message);
    this.ws?.send(JSON.stringify(message));
  }

  private receive(message: WireMessage) {
    this.h.onWire("in", message);
    if (message.method) {
      this.h.onMessage(message);
    } else if (typeof message.id === "number") {
      const p = this.pending.get(message.id);
      this.pending.delete(message.id);
      if (message.error) p?.reject(new Error(message.error.message));
      else p?.resolve(message.result);
    }
  }

  request(method: string, params: Json = {}): Promise<Json> {
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.send({ id, method, params });
    });
  }

  notify(method: string, params?: Json) {
    this.send(params === undefined ? { method } : { method, params });
  }

  respond(id: string | number, result: Json) {
    this.send({ id, result });
  }
}
