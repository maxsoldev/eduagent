// pi's RPC transport over the launcher's WebSocket: one JSON object per frame (one stdin/stdout
// line on pi's side). Commands are {type, id?, ...}; pi answers each with {type: "response",
// command, id, success, data | error}. Every other message is an event. pi handles commands
// concurrently, so replies are matched by id, not by order (packages/coding-agent/docs/rpc.md).
import type { RpcCommand } from "@eduagent/edupi/rpc-types";
import type { Direction, Json } from "../../view/model";
import { openSocket, type SocketStatus } from "../socket";
import type { PiMessage, RpcResponse } from "./protocol";

type CommandType = RpcCommand["type"];
type Fields<T extends CommandType> = Omit<Extract<RpcCommand, { type: T }>, "id" | "type">;
/** The data of a command's success reply (undefined for commands without data). */
type Data<T extends CommandType> = RpcResponse extends infer R
	? R extends { command: infer C; success: true }
		? T extends C
			? R extends { data: infer D }
				? D
				: undefined
			: never
		: never
	: never;

type Handlers = {
	onMessage: (message: PiMessage) => void; // every incoming message, replies included
	onWire: (direction: Direction, message: Json) => void;
	onStatus: (status: SocketStatus, reason?: string) => void;
};

export class PiRpcClient {
	private ws: WebSocket | null = null;
	private nextId = 1;
	private pending = new Map<string, { resolve: (v: unknown) => void; reject: (e: Error) => void }>();
	constructor(
		private url: string,
		private h: Handlers,
	) {}

	async connect(): Promise<void> {
		this.ws = await openSocket(this.url, {
			onStatus: this.h.onStatus,
			onMessage: (message) => this.receive(message as PiMessage),
			onClose: (reason) => {
				for (const p of this.pending.values()) p.reject(new Error(reason));
				this.pending.clear();
			},
		});
	}

	private receive(message: PiMessage) {
		this.h.onWire("in", message);
		const p = message.type === "response" && message.id !== undefined ? this.pending.get(message.id) : undefined;
		if (p && message.type === "response") {
			this.pending.delete(message.id!);
			if (message.success) p.resolve("data" in message ? message.data : undefined);
			else p.reject(new Error(message.error));
		}
		this.h.onMessage(message);
	}

	/** Sends a command with a fresh id and resolves with the reply's data. */
	command<T extends CommandType>(
		type: T,
		// biome-ignore lint/complexity/noBannedTypes: `{} extends X` asks "are all of X's fields optional?"
		...[fields]: {} extends Fields<T> ? [Fields<T>?] : [Fields<T>]
	): Promise<Data<T>> {
		const id = String(this.nextId++);
		const message = { id, type, ...fields };
		return new Promise((resolve, reject) => {
			this.pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
			this.h.onWire("out", message);
			this.ws?.send(JSON.stringify(message));
		});
	}
}
