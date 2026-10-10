"""A terminal UI on the same protocol as the web UI.

It starts `educodex app-server --listen stdio://` as a child process and speaks JSON-RPC lite
over its stdin/stdout, one JSON message per line. This is how Codex's own TUI and IDE
extensions talk to the Codex harness. Left: the conversation. Right: the trace of hidden steps.
"""

import asyncio
import json
import sys
from typing import Any

from rich.markup import escape
from textual.app import App, ComposeResult
from textual.containers import Horizontal, Vertical
from textual.screen import ModalScreen
from textual.widgets import Button, Footer, Header, Input, Label, RichLog

TRACE_SUMMARY = {
    "trace/promptAssembled": lambda p: "prompt: " + " · ".join(f"{f['kind']}{'+' if f['changed'] else ''}" for f in p["fragments"]),
    "trace/modelRequest": lambda p: f"→ model request #{p['iteration']}: {len(p['body']['input'])} items, {len(p['body']['tools'])} tools",
    "trace/modelResponse": lambda p: f"← response: {[i['type'] for i in p['outputItems']]}",
    "trace/loopIteration": lambda p: f"loop: needs_follow_up={p['needsFollowUp']} → {p['decision']}",
    "trace/toolDispatch": lambda p: f"tool call: {p['tool']}",
    "trace/policyDecision": lambda p: f"policy: {p['tool']} → {p['decision']}{' (sandboxed)' if p['sandboxed'] else ''}",
    "trace/sandboxCommand": lambda p: "sandbox: " + " ".join(p["argv"])[:120],
    "trace/compacted": lambda p: f"compacted: {p['itemsBefore']} → {p['itemsAfter']} items",
}


class ApprovalScreen(ModalScreen[str]):
    """Shown when the server sends an approval request; returns the chosen decision."""

    def __init__(self, method: str, params: dict[str, Any], request_id: Any = None) -> None:
        super().__init__()
        self.method, self.params, self.request_id = method, params, request_id

    def compose(self) -> ComposeResult:
        p = self.params
        what = p.get("command") or p.get("message") or "file changes"
        choices = ["accept", "decline", "cancel"] if self.method == "mcpServer/elicitation/request" else (
            [c for c in p.get("availableDecisions", ["accept", "acceptForSession", "decline", "cancel"])
             if c != "acceptWithExecpolicyAmendment"])
        with Vertical(id="approval"):
            yield Label(f"[b red]Approval needed[/] ({self.method})")
            yield Label(escape(str(what)))
            yield Label(f"[dim]{escape(str(p.get('reason', '')))}[/]")
            with Horizontal():
                for choice in choices:
                    yield Button(choice, id=choice, variant="primary" if choice == "accept" else "default")

    def on_button_pressed(self, event: Button.Pressed) -> None:
        self.dismiss(event.button.id)


class EducodexTui(App):
    CSS = """
    #chat { width: 55%; border: round $accent; }
    #trace { width: 45%; border: round $panel; }
    #approval { padding: 1 2; border: thick $error; background: $surface; width: 80%; height: auto; }
    """
    BINDINGS = [("ctrl+c", "quit", "Quit"), ("escape", "interrupt", "Interrupt turn")]

    def __init__(self, server_args: list[str]) -> None:
        super().__init__()
        self.server_args = server_args
        self.proc: asyncio.subprocess.Process | None = None
        self.pending: dict[int, asyncio.Future] = {}
        self.next_id = 1
        self.thread_id: str | None = None
        self.turn_id: str | None = None

    def compose(self) -> ComposeResult:
        yield Header(show_clock=False)
        with Horizontal():
            yield RichLog(id="chat", wrap=True, markup=True)
            yield RichLog(id="trace", wrap=True, markup=True)
        yield Input(placeholder="Ask the agent… (Enter to send, Esc to interrupt)")
        yield Footer()

    async def on_mount(self) -> None:
        self.title = "educodex"
        self.sub_title = "the same JSON-RPC protocol as the web UI, over stdio"
        self.proc = await asyncio.create_subprocess_exec(
            sys.executable, "-m", "educodex.cli", "app-server", "--listen", "stdio://", *self.server_args,
            stdin=asyncio.subprocess.PIPE, stdout=asyncio.subprocess.PIPE, stderr=asyncio.subprocess.DEVNULL,
            limit=64 * 1024 * 1024)
        self.run_worker(self.read_loop(), exclusive=False)
        await self.request("initialize", {"clientInfo": {"name": "educodex-tui", "version": "0.1.0"}})
        await self.send({"method": "initialized"})
        thread = await self.request("thread/start", {})
        self.thread_id = thread["thread"]["id"]
        self.query_one("#chat", RichLog).write(f"[dim]thread {self.thread_id} · model {thread['model']} · cwd {thread['cwd']}[/]")

    async def send(self, message: dict) -> None:
        assert self.proc and self.proc.stdin
        self.proc.stdin.write((json.dumps(message) + "\n").encode())
        await self.proc.stdin.drain()

    async def request(self, method: str, params: dict) -> Any:
        rid = self.next_id
        self.next_id += 1
        future = asyncio.get_running_loop().create_future()
        self.pending[rid] = future
        await self.send({"id": rid, "method": method, "params": params})
        return await future

    async def read_loop(self) -> None:
        assert self.proc and self.proc.stdout
        while line := await self.proc.stdout.readline():
            message = json.loads(line)
            if "method" in message and "id" in message:  # server -> client request (approval)
                screen = ApprovalScreen(message["method"], message["params"], message["id"])
                self.push_screen(screen, lambda choice, m=message: choice and self.answer(m, choice))
            elif message.get("method") == "serverRequest/resolved":  # e.g. the turn was interrupted
                if isinstance(self.screen, ApprovalScreen) and self.screen.request_id == message["params"]["requestId"]:
                    self.screen.dismiss(None)
            elif "method" in message:
                self.on_notification(message["method"], message.get("params", {}))
            elif (future := self.pending.pop(message.get("id"), None)) is not None:
                if "error" in message:
                    future.set_exception(RuntimeError(message["error"]["message"]))
                else:
                    future.set_result(message.get("result"))

    def answer(self, message: dict, choice: str) -> None:
        result = {"action": choice} if message["method"] == "mcpServer/elicitation/request" else {"decision": choice}
        self.run_worker(self.send({"id": message["id"], "result": result}))

    def on_notification(self, method: str, p: dict) -> None:
        chat, trace = self.query_one("#chat", RichLog), self.query_one("#trace", RichLog)
        if method in TRACE_SUMMARY:
            trace.write(f"[cyan]{escape(TRACE_SUMMARY[method](p))}[/]")
        if method == "turn/started":
            self.turn_id = p["turn"]["id"]
        elif method == "item/completed":
            item = p["item"]
            if item["type"] == "agentMessage":
                chat.write(f"[b green]agent[/] {escape(item['text'])}")
            elif item["type"] == "commandExecution":
                chat.write(f"[magenta]$ {escape(item['command'])}[/] [dim]({item['status']}, exit {item['exitCode']})[/]")
                if item.get("aggregatedOutput"):
                    chat.write(f"[dim]{escape(item['aggregatedOutput'][-1500:])}[/]")
            elif item["type"] == "fileChange":
                for change in item["changes"]:
                    chat.write(f"[blue]patch[/] {change['kind']['type']} {escape(change['path'])} [dim]({item['status']})[/]")
            elif item["type"] == "mcpToolCall":
                chat.write(f"[green]mcp[/] {item['server']}.{item['tool']} [dim]({item['status']})[/]")
            elif item["type"] == "reasoning" and item["summary"]:
                chat.write(f"[dim i]{escape(' '.join(item['summary']))}[/]")
        elif method == "turn/plan/updated":
            chat.write("[yellow]plan[/] " + escape(" · ".join(f"{s['step']} [{s['status']}]" for s in p["plan"])))
        elif method == "turn/completed":
            chat.write(f"[dim]── turn {p['turn']['status']} ──[/]")
        elif method == "error":
            chat.write(f"[b red]error[/] {escape(p['error']['message'])}")

    async def on_input_submitted(self, event: Input.Submitted) -> None:
        text = event.value.strip()
        event.input.value = ""
        if not text or not self.thread_id:
            return
        self.query_one("#chat", RichLog).write(f"[b]you[/] {escape(text)}")
        try:
            await self.request("turn/start", {"threadId": self.thread_id, "input": [{"type": "text", "text": text}]})
        except RuntimeError as err:
            self.query_one("#chat", RichLog).write(f"[red]{escape(str(err))}[/]")

    async def action_interrupt(self) -> None:
        if self.thread_id and self.turn_id:
            await self.request("turn/interrupt", {"threadId": self.thread_id, "turnId": self.turn_id})

    async def on_unmount(self) -> None:
        if self.proc and self.proc.returncode is None:
            self.proc.stdin.close()  # EOF: the stdio server shuts down cleanly
            try:
                await asyncio.wait_for(self.proc.wait(), timeout=5)
            except TimeoutError:
                self.proc.kill()
                await self.proc.wait()


def run_tui(args) -> None:
    server_args = ["--cwd", args.cwd, "--model", args.model, "--approval", args.approval, "--sandbox", args.sandbox]
    if args.effort:
        server_args += ["--effort", args.effort]
    for spec in args.mcp or []:
        server_args += ["--mcp", spec]
    if getattr(args, "fake_model", None):
        server_args += ["--fake-model", args.fake_model]
    EducodexTui(server_args).run()
