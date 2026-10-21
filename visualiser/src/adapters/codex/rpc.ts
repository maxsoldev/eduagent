// A JSON-RPC "lite" client (Codex app-server style): like JSON-RPC 2.0 but without "jsonrpc": "2.0".
// The server can also send *requests* to us (approvals); we answer them with respond().
// This is the Codex adapter's transport (adapters/codex/client.ts).
import type { Direction, Json } from "../../view/model";
import { openSocket, type SocketStatus } from "../socket";

export type WireMessage = { id?: string | number; method?: string; params?: Json; result?: Json; error?: Json };

type Handlers = {
	onMessage: (message: WireMessage) => void; // notifications and server -> client requests
	onWire: (direction: Direction, message: WireMessage) => void;
	onStatus: (status: SocketStatus, reason?: string) => void;
};

export class RpcClient {
	private ws: WebSocket | null = null;
	private nextId = 1;
	private pending = new Map<number, { resolve: (v: Json) => void; reject: (e: Error) => void }>();
	constructor(
		private url: string,
		private h: Handlers,
	) {}

	async connect(): Promise<void> {
		this.ws = await openSocket(this.url, {
			onStatus: this.h.onStatus,
			onMessage: (message) => this.receive(message as WireMessage),
			onClose: (reason) => {
				for (const p of this.pending.values()) p.reject(new Error(reason));
				this.pending.clear();
			},
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
