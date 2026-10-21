// The launcher at its HTTP and WebSocket seam, with the echo test backend (launcher/test/echo-backend.mjs).

import { realpathSync } from "node:fs";
import { request as httpRequest } from "node:http";
import { expect, test } from "@playwright/test";
import { E2E_DIR, PORT } from "./env";

type Echo = { pid: number; cwd: string; line: string };

function open(backend: string, cwd: string): Promise<WebSocket> {
	const ws = new WebSocket(`ws://127.0.0.1:${PORT}/backends/${backend}?cwd=${encodeURIComponent(cwd)}`);
	return new Promise((resolve, reject) => {
		ws.onopen = () => resolve(ws);
		ws.onerror = () => reject(new Error("cannot connect"));
	});
}

function next(ws: WebSocket): Promise<string> {
	return new Promise((resolve) => ws.addEventListener("message", (e) => resolve(String(e.data)), { once: true }));
}

function closed(ws: WebSocket): Promise<CloseEvent> {
	return new Promise((resolve) => ws.addEventListener("close", resolve, { once: true }));
}

function alive(pid: number): boolean {
	try {
		process.kill(pid, 0);
		return true;
	} catch {
		return false;
	}
}

test("lists the backends with harness, protocol and capabilities", async ({ request }) => {
	const list = await (await request.get("/backends")).json();
	expect(list.cwd).toBe(`${E2E_DIR}/ws`);
	const educodex = list.backends.find((b: { name: string }) => b.name === "educodex");
	expect(educodex).toMatchObject({ harness: "Codex", protocol: "codex-app-server" });
	expect(educodex.capabilities).toContain("approvals");
	expect(educodex.command).toBeUndefined(); // the page never sees what the launcher runs
});

test("serves the visualiser and the guide", async ({ request }) => {
	expect(await (await request.get("/")).text()).toContain('<div id="root">');
	expect(await (await request.get("/some/page")).text()).toContain('<div id="root">'); // single-page app
	const chapter = await request.get("/guide/educodex/18");
	expect(chapter.headers()["content-type"]).toContain("text/markdown");
	expect(await chapter.text()).toContain("The App Server");
	expect((await request.get("/guide/educodex/99")).status()).toBe(404);
	expect((await request.get("/guide/..%2F..%2Fpackage.json/x")).status()).toBe(404);
});

test("each viewer gets its own process in its directory; frames and lines pass unchanged", async () => {
	const a = await open("echo", `${E2E_DIR}/ws`);
	const b = await open("echo", `${E2E_DIR}/ws2`);
	const frame = '{"id":1,"method":"initialize","params":{ "spacing" : "kept" }}';
	const [ra, rb] = [next(a), next(b)];
	a.send(frame);
	b.send(frame);
	const echoA: Echo = JSON.parse(await ra);
	const echoB: Echo = JSON.parse(await rb);
	expect(echoA.line).toBe(frame);
	expect(echoA.pid).not.toBe(echoB.pid);
	expect(echoA.cwd).toBe(realpathSync(`${E2E_DIR}/ws`));
	expect(echoB.cwd).toBe(realpathSync(`${E2E_DIR}/ws2`));

	a.close(); // closing a viewer stops its process, and only its process
	await expect.poll(() => alive(echoA.pid), { timeout: 10_000 }).toBe(false);
	expect(alive(echoB.pid)).toBe(true);
	b.close();
});

test("a backend that exits closes the WebSocket with an error that names it", async () => {
	const ws = await open("echo", `${E2E_DIR}/ws`);
	const close = closed(ws);
	ws.send("exit");
	const event = await close;
	expect(event.code).toBe(1011);
	expect(event.reason).toBe("echo exited with code 7");
});

test("a bad directory or an unknown backend is refused with a reason", async () => {
	const ws = new WebSocket(`ws://127.0.0.1:${PORT}/backends/echo?cwd=${encodeURIComponent(`${E2E_DIR}/missing`)}`);
	const event = await closed(ws);
	expect(event.code).toBe(1008);
	expect(event.reason).toContain("not a directory");
	const unknown = await closed(new WebSocket(`ws://127.0.0.1:${PORT}/backends/nope`));
	expect(unknown.reason).toBe("unknown backend: nope");
});

test("refuses connections from non-loopback origins", async () => {
	const status = (headers: Record<string, string>) =>
		new Promise<number>((resolve, reject) => {
			const req = httpRequest({
				host: "127.0.0.1",
				port: PORT,
				path: "/backends/echo",
				headers: {
					Connection: "Upgrade",
					Upgrade: "websocket",
					"Sec-WebSocket-Version": "13",
					"Sec-WebSocket-Key": "dGhlIHNhbXBsZSBub25jZQ==",
					...headers,
				},
			});
			req.on("response", (res) => resolve(res.statusCode ?? 0));
			req.on("upgrade", (res, socket) => {
				socket.destroy();
				resolve(res.statusCode ?? 0);
			});
			req.on("error", reject);
			req.end();
		});
	expect(await status({ Origin: "https://evil.example" })).toBe(403);
	expect(await status({ Origin: "http://evil.example:8799" })).toBe(403);
	expect(await status({ Origin: `http://localhost:${PORT}` })).toBe(101);
});
