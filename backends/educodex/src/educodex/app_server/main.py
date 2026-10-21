"""Run the App Server over stdio: JSONL, one JSON message per line on stdin/stdout.

This is Codex's default transport (`stdio://`), used by its IDE clients and TUI. The launcher
starts one such process per viewer. Codex also has `ws://` and `unix://` listeners; educodex does not.
Mirrors codex-rs/app-server-transport/src/transport/{mod.rs, stdio.rs}.
"""

import asyncio
import json
import sys

from educodex.app_server.connection import Connection
from educodex.app_server.processor import MessageProcessor
from educodex.cli import build_config

DEFAULT_LISTEN_URL = "stdio://"  # AppServerTransport::DEFAULT_LISTEN_URL in Codex


def make_processor(args) -> MessageProcessor:
    factory = None
    if args.fake_model:
        from educodex.testing.fake_model import FakeModel

        script_path = args.fake_model
        factory = lambda: FakeModel.from_file(script_path)  # noqa: E731
    return MessageProcessor(build_config(args), factory)


async def serve_stdio(processor: MessageProcessor) -> None:
    loop = asyncio.get_running_loop()
    reader = asyncio.StreamReader(limit=64 * 1024 * 1024)  # one line can hold a long pasted prompt
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
    if args.listen != DEFAULT_LISTEN_URL:
        # Codex's error text, with only the one URL that educodex accepts.
        sys.exit(f"unsupported --listen URL `{args.listen}`; expected `{DEFAULT_LISTEN_URL}`")
    asyncio.run(serve_stdio(make_processor(args)))
