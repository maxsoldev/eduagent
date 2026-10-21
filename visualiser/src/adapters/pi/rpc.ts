// pi's RPC transport over the launcher's WebSocket: one JSON object per frame (one stdin/stdout
// line on pi's side). Commands are {type, id?, ...}; pi answers each with {type: "response",
// command, id, success, data | error}. Every other message is an event. pi handles commands
// concurrently, so replies are matched by id, not by order (packages/coding-agent/docs/rpc.md).
import type { Direction, Json } from "../../view/model";

type Handlers = {
  onMessage: (message: Json) => void; // every incoming message, replies included
  onWire: (direction: Direction, message: Json) => void;
  onStatus: (status: "connecting" | "open" | "closed", reason?: string) => void;
};

export class PiRpcClient {
  private ws: WebSocket | null = null;
  private nextId = 1;
  private pending = new Map<string, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
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
      ws.onclose = (e) => {
        for (const p of this.pending.values()) p.reject(new Error(e.reason || "connection closed"));
        this.pending.clear();
        this.h.onStatus("closed", e.reason);
      };
      ws.onmessage = (e) => this.receive(JSON.parse(e.data));
    });
  }

  private receive(message: Json) {
    this.h.onWire("in", message);
    const p = message.type === "response" && message.id !== undefined ? this.pending.get(message.id) : undefined;
    if (p) {
      this.pending.delete(message.id);
      if (message.success) p.resolve(message.data);
      else p.reject(new Error(message.error));
    }
    this.h.onMessage(message);
  }

  /** Sends a command with a fresh id and resolves with the reply's data. */
  command(type: string, fields: Json = {}): Promise<Json> {
    const id = String(this.nextId++);
    const message = { id, type, ...fields };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.h.onWire("out", message);
      this.ws?.send(JSON.stringify(message));
    });
  }
}
