// The launcher's WebSocket for one backend, shared by every adapter's transport: one JSON message
// per frame (one stdin/stdout line on the backend's side).
export type SocketStatus = "connecting" | "open" | "closed";

type SocketHandlers = {
	onStatus: (status: SocketStatus, reason?: string) => void;
	onMessage: (message: unknown) => void;
	onClose: (reason: string) => void; // before the "closed" status: reject what still waits for a reply
};

/** Opens the socket; resolves once it is open. */
export function openSocket(url: string, h: SocketHandlers): Promise<WebSocket> {
	h.onStatus("connecting");
	return new Promise((resolve, reject) => {
		const ws = new WebSocket(url);
		ws.onopen = () => {
			h.onStatus("open");
			resolve(ws);
		};
		ws.onerror = () => reject(new Error(`cannot connect to ${url}`));
		// The launcher closes with a reason when the backend process exits ("educodex exited with code 1").
		ws.onclose = (e) => {
			h.onClose(e.reason || "connection closed");
			h.onStatus("closed", e.reason);
		};
		ws.onmessage = (e) => h.onMessage(JSON.parse(e.data));
	});
}
