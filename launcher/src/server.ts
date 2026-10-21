// The launcher's HTTP server: the built visualiser, the guide, GET /backends, and one WebSocket per viewer
// at /backends/<name>?cwd=<dir>. It binds to loopback and refuses pages from other origins, because a
// connection starts a process that can run commands on this machine.
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { extname, join, normalize, resolve, sep } from "node:path";
import { WebSocketServer } from "ws";
import type { BackendList } from "./api.ts";
import type { Backend } from "./config.ts";
import { pipe } from "./pipe.ts";

export type LauncherOptions = {
	backends: Backend[];
	cwd: string; // the default directory for new viewers
	visualiserDir: string; // visualiser/dist
	guideDir: string; // docs/guide
};

const LOOPBACK = new Set(["127.0.0.1", "localhost", "::1", "[::1]"]);
const TYPES: Record<string, string> = {
	".html": "text/html; charset=utf-8",
	".js": "text/javascript",
	".css": "text/css",
	".svg": "image/svg+xml",
	".png": "image/png",
	".ico": "image/x-icon",
	".json": "application/json",
	".woff2": "font/woff2",
};

/** True for "http://localhost:8765" and "127.0.0.1:8765" (a Host header). A missing value is not a browser, so it passes. */
export function isLoopback(value: string | undefined): boolean {
	if (!value) return true;
	try {
		return LOOPBACK.has(new URL(value.includes("://") ? value : `http://${value}`).hostname);
	} catch {
		return false;
	}
}

export function createLauncher(opts: LauncherOptions) {
	const wss = new WebSocketServer({ noServer: true });
	const server = createServer((req, res) => {
		if (!isLoopback(req.headers.host)) return send(res, 403, "text/plain", "forbidden host"); // DNS rebinding
		const url = new URL(req.url ?? "/", "http://localhost");
		if (url.pathname === "/backends") {
			const list: BackendList = {
				cwd: opts.cwd,
				backends: opts.backends.map(({ name, harness, protocol, description, capabilities }) => ({
					name,
					harness,
					protocol,
					description,
					capabilities,
				})),
			};
			return send(res, 200, "application/json", JSON.stringify(list));
		}
		if (url.pathname.startsWith("/guide/")) return guide(res, opts.guideDir, url.pathname);
		return visualiser(res, opts.visualiserDir, url.pathname);
	});

	server.on("upgrade", (req: IncomingMessage, socket, head) => {
		if (!isLoopback(req.headers.origin) || !isLoopback(req.headers.host)) {
			socket.end("HTTP/1.1 403 Forbidden\r\n\r\n");
			return;
		}
		const url = new URL(req.url ?? "/", "http://localhost");
		const name = url.pathname.match(/^\/backends\/([^/]+)$/)?.[1];
		wss.handleUpgrade(req, socket, head, (ws) => {
			// Refuse after the upgrade, so the viewer can read the reason (a browser cannot see an HTTP status).
			const backend = opts.backends.find((b) => b.name === name);
			if (!backend) return ws.close(1008, `unknown backend: ${name ?? url.pathname}`);
			const cwd = resolve(opts.cwd, url.searchParams.get("cwd") || ".");
			if (!existsSync(cwd) || !statSync(cwd).isDirectory())
				return ws.close(1008, `not a directory: ${cwd}`.slice(0, 120));
			pipe(ws, backend, cwd);
		});
	});
	return server;
}

/** /guide/<section>/<chapter> -> docs/guide/<section>/<chapter>-*.md; /guide/<section> -> its README.md. */
function guide(res: ServerResponse, guideDir: string, pathname: string) {
	const [section, chapter] = pathname.split("/").slice(2);
	const safe = (s: string | undefined) => !s || /^[a-z0-9-]+$/.test(s);
	const dir = join(guideDir, section ?? "");
	if (!section || !safe(section) || !safe(chapter) || !existsSync(dir))
		return send(res, 404, "text/plain", "guide not found");
	const file = chapter
		? readdirSync(dir)
				.sort()
				.find((f) => f.startsWith(`${chapter}-`) && f.endsWith(".md"))
		: "README.md";
	if (!file || !existsSync(join(dir, file))) return send(res, 404, "text/plain", "guide not found");
	send(res, 200, "text/markdown; charset=utf-8", readFileSync(join(dir, file)));
}

/** Static files from visualiser/dist. Any other path gets index.html, so the page can read its own URL. */
function visualiser(res: ServerResponse, dir: string, pathname: string) {
	const index = join(dir, "index.html");
	if (!existsSync(index)) {
		return send(
			res,
			503,
			"text/html",
			"<h1>eduagent launcher</h1><p>The visualiser is not built. Run <code>pnpm build</code> at the repo root.</p>",
		);
	}
	const file = normalize(join(dir, decodeURIComponent(pathname)));
	const found = file.startsWith(dir + sep) && existsSync(file) && statSync(file).isFile();
	send(res, 200, (found && TYPES[extname(file)]) || TYPES[".html"], readFileSync(found ? file : index));
}

function send(res: ServerResponse, status: number, type: string, body: string | Buffer) {
	res.writeHead(status, { "content-type": type });
	res.end(body);
}
