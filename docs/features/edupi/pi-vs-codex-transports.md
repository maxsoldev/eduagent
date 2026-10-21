In our case, "transport" means the channel that carries messages between the web UI and the backend. It does not mean OSI layer 4. The transport only moves bytes. It does not know what the messages mean.

## 1. The layers in our stack

Each layer answers one question. No two layers answer the same one.

| #   | Layer                   | Question it answers                             | educodex                                                | pi                                                    |
| --- | ----------------------- | ----------------------------------------------- | ------------------------------------------------------- | ----------------------------------------------------- |
| 1   | **Semantics**           | What do the messages mean?                      | Codex app-server v2 (`thread/start`, `item/started`, …) | pi RPC (`prompt`, `abort`, `tool_execution_start`, …) |
| 2   | **Envelope**            | How is a request, reply or event shaped?        | JSON-RPC lite: `{id, method, params}`                   | `{type, id?, ...}`                                    |
| 3   | **Encoding**            | How does a message become bytes?                | JSON as UTF-8 text                                      | JSON as UTF-8 text                                    |
| 4   | **Framing**             | Where does one message stop and the next start? | One WebSocket frame per message                         | One message per line (JSONL)                          |
| 5   | **Channel (transport)** | Which pipe carries the bytes?                   | WebSocket                                               | stdin/stdout                                          |
| 6   | **Carrier**             | What is under the channel?                      | TCP/IP                                                  | An OS pipe in the kernel                              |

Notes:

- **When we say "transport", we mean layers 4 and 5.** Change these two, and layers 1–3 stay the same.
- **Layers 1 and 2 are the actual difference between Codex and pi.** That is why an adapter is necessary, but a different transport is not.
- **Framing is easy to forget.** A raw byte stream has no message boundaries, so something must add them:
  - A WebSocket adds them for you.
  - On stdio or raw TCP you add them yourself, usually with a newline (JSONL). This is why pi has its own `jsonl.ts`.

## 2. Where this sits in the OSI model

| OSI layer      | What it does                       | Our stack                                                                             |
| -------------- | ---------------------------------- | ------------------------------------------------------------------------------------- |
| 7 Application  | Protocols that programs use        | **Layers 1–4 above all live here.** WebSocket and HTTP are layer 7 protocols too.     |
| 6 Presentation | Data format, encryption            | JSON/UTF-8, and TLS if you use `wss://`                                               |
| 5 Session      | Opening and keeping a conversation | Not used as a separate layer in practice. The WebSocket handshake does a similar job. |
| 4 Transport    | Reliable byte stream between hosts | **TCP** (or UDP/QUIC)                                                                 |
| 3 Network      | Routing between machines           | IP                                                                                    |
| 2 Data link    | Moving frames on one local link    | Ethernet, Wi-Fi                                                                       |
| 1 Physical     | Signals on wire or radio           | Cable, radio                                                                          |

Key points:

1. **The word means two different things.** "Transport" in JSON-RPC and Codex documents is the channel (our layers 4–5). "Transport" in OSI is layer 4 (TCP/UDP).
2. **A WebSocket is a layer 7 protocol on top of TCP.** It starts as an HTTP request, then switches ("upgrades") to a two-way message stream.
3. **stdio is outside the OSI model.** A pipe between two processes on one machine goes through the OS kernel, not a network. OSI describes networks only.

## 3. Alternative transports

### 3.1 Same machine, no network

| Transport                                   | How it works                                                                     | Notes                                                                                                                                |
| ------------------------------------------- | -------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| **stdio pipes**                             | The parent starts the child process and writes to its stdin and reads its stdout | Used by pi `--mode rpc`, `codex app-server`, MCP servers and LSP servers. Simplest option. One client only. A browser cannot use it. |
| **Unix domain socket / Windows named pipe** | A socket that is a file path, not a network port                                 | Faster than TCP, and file permissions control access. Many clients can connect. A browser cannot use it.                             |
| **In-process call**                         | The backend is a library, and you call its functions directly                    | No serialization. pi's SDK mode works this way. No process boundary, so there is nothing to visualise on the wire.                   |

### 3.2 Over a network, long-lived two-way channel

| Transport               | How it works                                                            | Notes                                                                                                      |
| ----------------------- | ----------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| **Raw TCP socket**      | A byte stream to `host:port`, and you add framing yourself (e.g. JSONL) | Simple, but browsers cannot open raw TCP.                                                                  |
| **WebSocket**           | An HTTP connection upgraded to two-way messages                         | What educodex uses today. Works in browsers, frames messages for you, and both sides can send at any time. |
| **WebTransport**        | HTTP/3 over QUIC (UDP) with several streams                             | New. Browser support is still incomplete. More than we need.                                               |
| **WebRTC data channel** | Peer-to-peer channel over UDP                                           | Built for browser-to-browser use. Setup is complex. Not a good fit.                                        |

### 3.3 Over a network, based on HTTP requests

| Transport                                | How it works                                                                   | Notes                                                                                                                                                                        |
| ---------------------------------------- | ------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **HTTP request/response**                | One POST per message, one reply                                                | The server cannot push events, so streaming does not work by itself.                                                                                                         |
| **HTTP POST + Server-Sent Events (SSE)** | The client sends with POST. The server pushes events on one long GET response. | Works well for streaming tokens. The server cannot send a request to the client directly, so approvals need a second POST. MCP's "Streamable HTTP" transport works this way. |
| **Long polling**                         | The client asks "anything new?", and the server holds the reply until there is | Old fallback. Slow and complicated.                                                                                                                                          |

## 4. How to choose

Ask four questions:

1. **Does a browser connect?** If yes, you can only use HTTP, SSE, WebSocket, WebTransport or WebRTC. **This is why pi needs a bridge:** the browser cannot read pi's stdio.
2. **Must the server start messages?** Our UI needs streaming events and approval requests from the server. WebSocket does this in a clean way. HTTP + SSE can do it, but approvals then need extra work.
3. **Is it the same machine?** If yes, stdio or a Unix socket is the simplest choice.
4. **How many clients?** stdio supports one. Sockets and WebSockets support many.

## 5. What this means for edupi

```
browser ──WebSocket──► bridge/server ──stdio JSONL──► pi / edupi core
         (layers 4-5 change here)    (layers 1-3 do not change)
```

- edupi can use pi's stdio JSONL as it is, with a thin WebSocket server in front. That is the same setup as educodex's `app_server`, which already offers both WebSocket and stdio.
- The transport is a solved problem. The real work is in layers 1–2, which is the adapter from pi's events to the shared view model.
