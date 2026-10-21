"""Running commands for exec_command / write_stdin, with long-lived sessions.

Mirrors codex-rs/core/src/unified_exec/ in its `tty: false` mode (plain pipes, Codex's default):
  * wait up to `yield_time_ms` for the command to finish
  * if it is still running, return the output so far plus a session id
  * the model can then call write_stdin(session_id, chars) to type input or collect more output
Codex can also allocate a PTY (`tty: true`); educodex always uses pipes.
"""

import asyncio
import contextlib
import inspect
import os
import signal
import time
from collections.abc import Callable
from dataclasses import dataclass, field

MIN_YIELD_MS, DEFAULT_YIELD_MS, MAX_YIELD_MS = 250, 10_000, 30_000
DEFAULT_POLL_YIELD_MS, MAX_POLL_YIELD_MS = 5_000, 300_000  # empty write_stdin polls may wait longer
MAX_PROCESSES = 64
MAX_BUFFER_BYTES = 1024 * 1024  # 1 MiB of output kept per process


@dataclass
class Process:
    id: int
    proc: asyncio.subprocess.Process
    buffer: bytearray = field(default_factory=bytearray)
    read_offset: int = 0  # how much output the model has already seen
    reader: asyncio.Task | None = None
    on_output: Callable[[str], object] | None = None


@dataclass
class ExecResult:
    output: str
    exit_code: int | None  # None while still running
    session_id: int | None  # set while still running
    wall_time: float


class ProcessManager:
    def __init__(self) -> None:
        self._processes: dict[int, Process] = {}
        self._lingering: dict[asyncio.Task, Process] = {}  # readers can outlive their process (background children)
        self._next_id = 1000

    async def start(
        self,
        argv: list[str],
        cwd: str,
        env: dict[str, str] | None,
        yield_ms: int | None,
        on_output: Callable[[str], object] | None = None,
    ) -> ExecResult:
        if len(self._processes) >= MAX_PROCESSES:
            raise RuntimeError(f"too many running processes (max {MAX_PROCESSES}); finish some with write_stdin")
        started = time.monotonic()
        proc = await asyncio.create_subprocess_exec(
            *argv,
            cwd=cwd,
            env=env,
            stdin=asyncio.subprocess.PIPE,
            stdout=asyncio.subprocess.PIPE,
            stderr=asyncio.subprocess.STDOUT,
            start_new_session=True,
        )
        self._next_id += 1
        process = Process(self._next_id, proc, on_output=on_output)
        process.reader = asyncio.create_task(self._pump(process))
        self._lingering[process.reader] = process
        process.reader.add_done_callback(lambda task: self._lingering.pop(task, None))
        self._processes[process.id] = process
        return await self._collect(process, _clamp(yield_ms, DEFAULT_YIELD_MS), started)

    async def write(self, session_id: int, chars: str, yield_ms: int | None) -> ExecResult:
        process = self._processes.get(session_id)
        if process is None:
            raise KeyError(f"Unknown process id {session_id}")
        started = time.monotonic()
        if chars and process.proc.stdin and not process.proc.stdin.is_closing():
            process.proc.stdin.write(chars.encode())
            await process.proc.stdin.drain()
        if chars:
            wait = _clamp(yield_ms, MIN_YIELD_MS)
        else:
            wait = max(DEFAULT_POLL_YIELD_MS, min(MAX_POLL_YIELD_MS, int(yield_ms or DEFAULT_POLL_YIELD_MS)))
        return await self._collect(process, wait, started)

    async def _pump(self, process: Process) -> None:
        assert process.proc.stdout
        while chunk := await process.proc.stdout.read(4096):
            process.buffer += chunk
            if len(process.buffer) > MAX_BUFFER_BYTES:  # keep the newest output
                drop = len(process.buffer) - MAX_BUFFER_BYTES
                del process.buffer[:drop]
                process.read_offset = max(0, process.read_offset - drop)
            if process.on_output:
                result = process.on_output(chunk.decode(errors="replace"))
                if inspect.isawaitable(result):
                    await result

    async def _collect(self, process: Process, yield_ms: int, started: float) -> ExecResult:
        """Wait until the process exits or the yield time passes, then return new output."""
        with contextlib.suppress(TimeoutError):
            await asyncio.wait_for(asyncio.shield(process.proc.wait()), yield_ms / 1000)
        exited = process.proc.returncode is not None
        if exited and process.reader:
            # Drain what is left, but a background child (`npm run dev &`) may keep the pipe open:
            # wait at most 50 ms like Codex (unified_exec/process_manager.rs).
            await asyncio.wait([process.reader], timeout=0.05)
        output = process.buffer[process.read_offset :].decode(errors="replace")
        process.read_offset = len(process.buffer)
        if exited:
            del self._processes[process.id]
        return ExecResult(
            output=output,
            exit_code=process.proc.returncode if exited else None,
            session_id=None if exited else process.id,
            wall_time=time.monotonic() - started,
        )

    async def terminate_all(self) -> None:
        """Kill every process group we started (including background children), then wait for readers."""
        for process in list(self._lingering.values()):
            with contextlib.suppress(ProcessLookupError, PermissionError):
                os.killpg(process.proc.pid, signal.SIGKILL)
        for process in list(self._processes.values()):
            await process.proc.wait()
        self._processes.clear()
        if self._lingering:
            await asyncio.wait(list(self._lingering), timeout=1)


def _clamp(value: int | None, default: int) -> int:
    return max(MIN_YIELD_MS, min(MAX_YIELD_MS, int(value if value is not None else default)))
