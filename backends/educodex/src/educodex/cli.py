"""Command line: `educodex exec "task"` runs one turn and prints every step;
`educodex app-server` serves the JSON-RPC protocol over stdio for the launcher (web UI) and the TUI.
"""

import argparse
import asyncio
import json
import sys
from pathlib import Path

from rich.console import Console
from rich.markup import escape
from rich.prompt import Prompt

from educodex.core.config import Config, load_api_key
from educodex.core.events import Event, EventBus
from educodex.core.session import Session
from educodex.observe.tracer import Tracer

console = Console()

QUIET = {
    "item/agentMessage/delta",
    "item/reasoning/summaryTextDelta",
    "item/commandExecution/outputDelta",
    "trace/historyChanged",
    "trace/streamEvent",
    "thread/tokenUsage/updated",
}


def print_event(event: Event, verbose: bool) -> None:
    """Render one event as a line of the timeline."""
    m, p = event.method, event.params
    if m in QUIET and not verbose:
        return
    if m == "trace/promptAssembled":
        console.rule("[bold cyan]prompt assembly")
        b = p["baseInstructions"]
        console.print(f"  [cyan]developer[/] base instructions  {b['tokens']:>6} tok  [dim]{escape(b['source'])}[/]")
        for f in p["fragments"]:
            mark = "[green]+ appended[/]" if f["changed"] else "[dim]  unchanged[/]"
            console.print(
                f"  [cyan]{f['role']:9}[/] {f['kind']:20} {f['tokens']:>6} tok  {mark}  [dim]{escape(f['source'])}[/]"
            )
    elif m == "trace/toolsRegistered":
        names = [t.get("name") for t in p["tools"]]
        console.print(f"[magenta]tools[/] {names}")
        if p.get("codexToolModeNote"):
            console.print(f"  [dim]note: {escape(p['codexToolModeNote'])}[/]")
    elif m == "trace/modelRequest":
        body = p["body"]
        console.rule(f"[bold yellow]model request #{p['iteration']}")
        console.print(
            f"  POST {p['url']}  model={body['model']}  input items={len(body['input'])}  "
            f"tools={len(body['tools'])}  ~{p['inputTokensEstimate']} tok  store={body['store']}"
        )
        if verbose:
            console.print_json(json.dumps(body))
    elif m == "trace/modelResponse":
        types = [i.get("type") for i in p["outputItems"]]
        usage = p["usage"]
        console.print(
            f"  [yellow]response[/] {types} usage={usage and usage.get('total_tokens')} tok in {p['seconds']}s"
        )
    elif m == "trace/cost":
        last, total = p["last"], p["total"]
        t = last["tokens"]
        ours = last.get("usd", {}).get("total")
        console.print(
            f"  [green]cost[/] ${last.get('billedUsd') or ours or 0:.6f} (computed ${ours or 0:.6f})  "
            f"input {t['input']} = {t['cached']} cached + {t['cacheWrite']} cache write + {t['uncached']} uncached, "
            f"output {t['output']}  · session ${total.get('billedUsd') or total.get('usd', {}).get('total', 0):.6f}, "
            f"{total['cacheHitRate']:.0%} cached"
        )
    elif m == "trace/loopIteration":
        console.print(
            f"  [bold]loop[/] needs_follow_up={p['needsFollowUp']} → [bold]{p['decision']}[/]  "
            f"context {p['tokens']}/{p['contextWindow']} (compact at {p['autoCompactLimit']})"
        )
    elif m == "trace/toolDispatch":
        detail = p["arguments"] if p["arguments"] else (p["input"] or "")
        console.print(f"  [magenta]tool call[/] {p['tool']} {escape(str(detail))[:400]}")
    elif m == "trace/policyDecision":
        console.print(f"  [red]policy[/] {p['decision']} sandboxed={p['sandboxed']}  [dim]{escape(p['reason'])}[/]")
    elif m == "trace/sandboxCommand":
        console.print(f"  [red]sandbox[/] {escape(' '.join(p['argv'])[:300])}")
    elif m == "trace/toolOutput":
        console.print(f"  [magenta]tool output[/] ({p['tokens']} tok) [dim]{escape(p['output'][:600])}[/]")
    elif m == "item/completed" and p["item"]["type"] == "agentMessage":
        console.print(f"\n[bold green]assistant:[/] {escape(p['item']['text'])}\n")
    elif m == "item/completed" and p["item"]["type"] == "reasoning" and p["item"]["summary"]:
        console.print(f"  [dim italic]reasoning: {escape(' '.join(p['item']['summary'])[:500])}[/]")
    elif m == "turn/plan/updated":
        for step in p["plan"]:
            console.print(f"  [blue]plan[/] {escape('[' + step['status'] + ']')} {escape(step['step'])}")
    elif m == "turn/completed":
        console.rule(f"turn {p['turn']['status']} in {p['turn']['durationMs']} ms")
    elif m == "error":
        console.print(f"[bold red]error:[/] {escape(p['error']['message'])}")
    elif m.startswith("trace/") and verbose:
        console.print(f"  [dim]{m} {escape(json.dumps(p)[:300])}[/]")
    elif m == "trace/skillInjected":
        console.print(
            f"  [cyan]skill[/] ${escape(p['name'])} injected ({p['tokens']} tok)  [dim]{escape(p['path'])}[/]"
        )
    elif m in ("trace/compacted", "trace/hook", "trace/sandboxDenied", "trace/mcpToolExposed", "trace/mcpServerFailed"):
        console.print(f"  [bold]{m}[/] {escape(json.dumps(p)[:400])}")


async def ask_user(method: str, params: dict) -> dict:
    """Approval prompt in the terminal."""
    what = params.get("command") or params.get("request", {}).get("message") or params.get("reason")
    console.print(
        f"\n[bold red]approval needed[/] ({method}): {escape(str(what))}"
        f"\n  reason: {escape(str(params.get('reason', '')))}"
    )
    if method == "mcpServer/elicitation/request":
        return {"action": Prompt.ask("allow?", choices=["accept", "decline", "cancel"], default="decline")}
    return {
        "decision": Prompt.ask(
            "decision", choices=["accept", "acceptForSession", "decline", "cancel"], default="decline"
        )
    }


def build_config(args) -> Config:
    cwd = Path(args.cwd).resolve()
    servers = {}
    for spec in args.mcp or []:
        name, _, command = spec.partition("=")
        parts = command.split()
        servers[name] = {"command": parts[0], "args": parts[1:]}
    return Config(
        cwd=cwd,
        model=args.model,
        approval_policy=args.approval,
        sandbox_mode=args.sandbox,
        api_key=load_api_key(cwd) or load_api_key(Path.cwd()),
        reasoning_effort=args.effort,
        network_access=args.network,
        mcp_servers=servers,
        memories=args.memories,
    )


async def run_exec(args) -> int:
    bus = EventBus()
    bus.subscribe(lambda e: print_event(e, args.verbose))
    transport = None
    if args.fake_model:
        from educodex.testing.fake_model import FakeModel

        transport = FakeModel.from_file(args.fake_model)
    session = Session(build_config(args), bus, ask_user, transport=transport, probe=Tracer())
    try:
        await session.start()
        turn = await session.run(args.prompt)
        console.print(f"[dim]session log: {session.rollout.path}[/]")
        return 0 if turn["status"] == "completed" else 1
    finally:
        await session.close()


def main(argv: list[str] | None = None) -> None:
    parser = argparse.ArgumentParser(prog="educodex", description=__doc__)
    sub = parser.add_subparsers(dest="command", required=True)

    def common(p):
        p.add_argument("--cwd", default=".")
        p.add_argument("--model", default="openai/gpt-6-luna")
        p.add_argument("--approval", default="on-request", choices=["on-request", "never"])
        p.add_argument(
            "--sandbox", default="workspace-write", choices=["read-only", "workspace-write", "danger-full-access"]
        )
        p.add_argument("--effort", default=None, choices=["low", "medium", "high"])
        p.add_argument("--network", action="store_true", help="allow network access inside the sandbox")
        p.add_argument("--mcp", action="append", metavar="NAME=COMMAND", help="add a stdio MCP server")
        p.add_argument(
            "--memories",
            action="store_true",
            help="use memories from earlier threads and allow /memory-update (Codex: [features] memories)",
        )
        p.add_argument("--fake-model", default=None, help="replay scripted model responses from a JSON file (offline)")

    p_exec = sub.add_parser("exec", help="run one task and print every step")
    p_exec.add_argument("prompt")
    p_exec.add_argument("-v", "--verbose", action="store_true", help="also print raw JSON and deltas")
    common(p_exec)

    p_srv = sub.add_parser("app-server", help="serve JSON-RPC lite over stdio (JSONL on stdin/stdout)")
    p_srv.add_argument("--listen", default="stdio://", help="transport URL; only stdio:// (the Codex default)")
    common(p_srv)

    p_tui = sub.add_parser("tui", help="terminal UI that talks to an app server over stdio")
    common(p_tui)

    args = parser.parse_args(argv)
    if args.command == "exec":
        sys.exit(asyncio.run(run_exec(args)))
    elif args.command == "app-server":
        from educodex.app_server.main import serve

        serve(args)
    else:
        from educodex.tui import run_tui

        run_tui(args)


if __name__ == "__main__":
    main()
