"""One client connection speaking "JSON-RPC lite" (Codex app-server-protocol/src/rpc.rs).

Same message shapes as JSON-RPC 2.0 but without the "jsonrpc": "2.0" field:
  request       {"id": 1, "method": "turn/start", "params": {...}}
  response      {"id": 1, "result": {...}}   or   {"id": 1, "error": {"code": -32600, "message": "..."}}
  notification  {"method": "item/started", "params": {...}}            (no id, no reply)
Both sides can send requests: the server asks the client for approvals the same way.
"""

import asyncio
import itertools
import json
from collections.abc import Awaitable, Callable
from typing import Any

Send = Callable[[str], Awaitable[None]]


class RpcError(Exception):
    def __init__(self, code: int, message: str) -> None:
        super().__init__(message)
        self.code = code


INVALID_REQUEST, METHOD_NOT_FOUND, INVALID_PARAMS, INTERNAL_ERROR = -32600, -32601, -32602, -32603


class Connection:
    _ids = itertools.count(1)

    def __init__(self, send: Send) -> None:
        self._send = send
        self._pending: dict[Any, asyncio.Future] = {}
        self.initialized = False
        self.opt_out: set[str] = set()  # notification methods this client does not want
        self.id = next(self._ids)
        self._lock = asyncio.Lock()

    async def send(self, message: dict[str, Any]) -> None:
        async with self._lock:
            await self._send(json.dumps(message, ensure_ascii=False, default=str))

    async def notify(self, method: str, params: dict[str, Any]) -> None:
        if method not in self.opt_out:
            await self.send({"method": method, "params": params})

    async def request(self, method: str, params: dict[str, Any]) -> Any:
        """Server -> client request; waits for the client's response."""
        request_id = f"srv-{next(self._ids)}"
        future = asyncio.get_running_loop().create_future()
        self._pending[request_id] = future
        await self.send({"id": request_id, "method": method, "params": params})
        try:
            return await future
        finally:
            self._pending.pop(request_id, None)
            # Tell the client the request is settled (answered or abandoned), as Codex does.
            await self.notify("serverRequest/resolved", {"threadId": params.get("threadId"), "requestId": request_id})

    def resolve(self, message: dict[str, Any]) -> bool:
        """Handle a response to one of our requests. Returns False if it wasn't one."""
        future = self._pending.get(message.get("id"))
        if future is None or future.done():
            return False
        if "error" in message:
            future.set_exception(RpcError(message["error"].get("code", INTERNAL_ERROR), message["error"].get("message", "")))
        else:
            future.set_result(message.get("result"))
        return True

    def cancel_pending(self) -> None:
        for future in self._pending.values():
            if not future.done():
                future.set_result({"decision": "cancel", "action": "cancel"})
