# One launcher pipes WebSocket to stdio backends

One launcher process serves the visualiser and `GET /backends`. For each viewer, it starts a new backend process in the directory the viewer chose, and it passes messages unchanged between the viewer's WebSocket and the process's stdin/stdout (JSONL). Backends have no HTTP or WebSocket code. stdio is the default transport of `codex app-server` and the transport of `pi --mode rpc`, so the real harnesses can be launcher entries with no bridge. We rejected two options: each backend serving the UI itself (the same web-server code in Python and in TypeScript), and backends that each listen on their own WebSocket port (more moving parts, and the real harnesses would still need a bridge).

## Consequences

- A backend cannot run with the browser unless the launcher runs too.
- educodex loses its Starlette server. Serving the UI was never part of Codex.
- One process per viewer matches pi's model of one session per process, and Codex's single-client stdio mode.
