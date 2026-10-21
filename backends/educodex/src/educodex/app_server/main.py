"""Run the App Server over WebSocket (also serving the built web UI) or stdio.

  ws://HOST:PORT   one JSON message per WebSocket text frame; the web UI is served at http://HOST:PORT/
  stdio://         JSONL: one JSON message per line on stdin/stdout (what Codex's IDE clients use)
Mirrors codex-rs/app-server-transport/src/transport/{websocket.rs, stdio.rs}.
"""

import asyncio
import contextlib
import json
import sys
from pathlib import Path
from urllib.parse import urlparse

from educodex.app_server.connection import Connection
from educodex.app_server.processor import MessageProcessor
from educodex.cli import build_config

REPO = Path(__file__).resolve().parents[5]  # the eduagent repo root, above backends/educodex/
WEB_DIST = REPO / "visualiser" / "dist"
GUIDE = REPO / "docs" / "guide" / "educodex"


def make_processor(args) -> MessageProcessor:
    factory = None
    if args.fake_model:
        from educodex.testing.fake_model import FakeModel

        script_path = args.fake_model
        factory = lambda: FakeModel.from_file(script_path)  # noqa: E731
    return MessageProcessor(build_config(args), factory)


def build_app(processor: MessageProcessor):
    from starlette.applications import Starlette
    from starlette.responses import HTMLResponse, PlainTextResponse
    from starlette.routing import Mount, Route, WebSocketRoute
    from starlette.staticfiles import StaticFiles
    from starlette.websockets import WebSocket, WebSocketDisconnect

    async def rpc(ws: WebSocket) -> None:
        # A web page on another site must not drive the agent (and answer its own approvals).
        # Codex rejects any Origin header; we must allow our own UI, so allow only loopback origins.
        origin = ws.headers.get("origin")
        if origin and urlparse(origin).hostname not in ("127.0.0.1", "localhost", "::1"):
            await ws.close(code=1008)
            return
        await ws.accept()
        conn = Connection(ws.send_text)
        processor.connect(conn)
        tasks: set[asyncio.Task] = set()
        try:
            while True:
                try:
                    message = json.loads(await ws.receive_text())
                except json.JSONDecodeError:
                    continue  # like Codex, drop malformed messages instead of closing
                # Handle each message concurrently: a turn can wait on an approval response
                # that arrives on this same socket.
                task = asyncio.create_task(processor.handle(conn, message))
                tasks.add(task)
                task.add_done_callback(tasks.discard)
        except WebSocketDisconnect:
            pass
        finally:
            processor.disconnect(conn)

    async def no_ui(request):
        return HTMLResponse("<h1>educodex app server</h1><p>Web UI not built. Run <code>pnpm install && pnpm build</code> at the repo root.</p>")

    async def guide(request):
        """/guide/05 -> docs/guide/educodex/05-*.md as plain text (linked from the UI's explanations)."""
        chapter = request.path_params["chapter"]
        matches = sorted(GUIDE.glob(f"{chapter}-*.md")) or ([GUIDE / "README.md"] if (GUIDE / "README.md").exists() else [])
        if not matches:
            return PlainTextResponse("guide not found", status_code=404)
        return PlainTextResponse(matches[0].read_text(), media_type="text/markdown; charset=utf-8")

    routes = [WebSocketRoute("/", rpc), WebSocketRoute("/rpc", rpc), Route("/guide/{chapter}", guide)]
    if WEB_DIST.is_dir():
        routes.append(Mount("/", StaticFiles(directory=WEB_DIST, html=True)))
    else:
        routes.append(Route("/", no_ui))
    @contextlib.asynccontextmanager
    async def lifespan(app):
        yield
        await processor.shutdown()

    return Starlette(routes=routes, lifespan=lifespan)


async def serve_stdio(processor: MessageProcessor) -> None:
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader()
    await loop.connect_read_pipe(lambda: asyncio.StreamReaderProtocol(reader), sys.stdin)

    async def write_line(text: str) -> None:
        sys.stdout.write(text + "\n")
        sys.stdout.flush()

    conn = Connection(write_line)
    processor.connect(conn)
    tasks: set[asyncio.Task] = set()
    while line := await reader.readline():
        try:
            message = json.loads(line) if line.strip() else None
        except json.JSONDecodeError:
            message = None
        if message is not None:
            task = asyncio.create_task(processor.handle(conn, message))
            tasks.add(task)
            task.add_done_callback(tasks.discard)
    processor.disconnect(conn)
    await processor.shutdown()


def serve(args) -> None:
    processor = make_processor(args)
    url = urlparse(args.listen)
    if url.scheme == "stdio":
        asyncio.run(serve_stdio(processor))
        return
    import uvicorn

    print(f"educodex app server on ws://{url.hostname}:{url.port}  (web UI: http://{url.hostname}:{url.port}/)", file=sys.stderr)
    uvicorn.run(build_app(processor), host=url.hostname or "127.0.0.1", port=url.port or 8765, log_level="warning")
