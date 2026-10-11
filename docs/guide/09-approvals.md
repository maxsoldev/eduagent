# 09 — Approvals

## Concept

### Who says "yes"?

The model asks for actions: "run `rm -rf build`", "write this patch". The harness must decide what happens to each request. There are three outcomes:

| Outcome | Meaning |
|---|---|
| **allow** | Run it now, without asking anyone |
| **prompt** | Pause and ask the user |
| **forbidden** | Refuse, and tell the model why |

Asking every time is safe but tiring: people stop reading and just click "yes". Never asking is fast but risky. The **approval policy** is the user's setting for where to draw the line.

### Approval policies

| Policy | What it means | In educodex? |
|---|---|---|
| `on-request` (default) | Run quietly inside the sandbox. Ask when a command looks dangerous, or when the model asks to leave the sandbox | yes |
| `never` | Never ask. Anything that would need a prompt is refused instead | yes |
| `untrusted` | Ask for every command that no rule explicitly allows | Codex only |
| `granular` | Per-category switches: sandbox escalations, rule prompts, MCP prompts, … | Codex only |

Approvals work together with the OS sandbox (chapter 10). With `on-request`, most commands are allowed *because* the sandbox limits what they can do. The prompt is for the cases the sandbox cannot cover:
- **Dangerous commands** such as `rm -rf`, even if the sandbox would allow them (chapter 11).
- **Escalation**: the model sets `sandbox_permissions: "require_escalated"` because it needs to do something the sandbox blocks, such as `npm install` with network access.

The model knows these rules because they are in its prompt. The `<permissions instructions>` fragment (chapter 05) includes text like "To request approval to execute a command that will require escalated privileges: Provide the `sandbox_permissions` parameter with the value `"require_escalated"`…".

### An approval is a request from the server to the client

The agent core runs in a server, and the user sits in a client (terminal, IDE, web page). Usually the client sends requests and the server answers. An approval goes the **other way**: the server sends a JSON-RPC request to the client and waits for the answer. The turn stays paused until then.

```json
{"id": "srv-7", "method": "item/commandExecution/requestApproval",
 "params": {"threadId": "…", "turnId": "…", "itemId": "call_abc",
            "command": "rm -rf build", "cwd": "/Users/me/demo",
            "reason": "Delete the build directory?",
            "proposedExecpolicyAmendment": null,
            "availableDecisions": ["accept", "acceptForSession", "decline", "cancel"]}}
```

The client shows a card with buttons, and answers with the same `id`:

```json
{"id": "srv-7", "result": {"decision": "accept"}}
```

### The decisions

| Decision | Effect |
|---|---|
| `accept` | Run it this once |
| `acceptForSession` | Run it, and don't ask again for the same thing in this session (same command, folder, shell and escalation) |
| `acceptWithExecpolicyAmendment` | Run it, and add an allow rule, e.g. `prefix_rule(pattern=["npm", "install"], decision="allow")`, so future matching commands run without asking |
| `decline` | Don't run it. The model gets "rejected by user" and the turn continues |
| `cancel` | Don't run it, and stop the whole turn |

`acceptWithExecpolicyAmendment` is the only decision that is an object rather than a string:

```json
{"decision": {"acceptWithExecpolicyAmendment": {"execpolicy_amendment": ["npm", "install"]}}}
```

The model proposes the rule by sending `prefix_rule` together with `require_escalated`. The user only confirms it. The harness checks the proposal first: it must be a list of words, must not be a catch-all such as `["bash"]` or `["python3", "-c"]`, and must be a prefix of *every* segment of the command (chapter 11). Otherwise the option is not offered.

### Patch approvals

`apply_patch` edits files directly, so there is no command to inspect. The question becomes: **are all the paths writable?**
- `workspace-write`: patches inside the writable roots (the workspace and temp dirs) are auto-approved. Anything outside them needs a prompt.
- `read-only`: every patch needs a prompt.
- `danger-full-access`: everything is allowed.

Some folders are **protected** even inside a writable root: `.git`, `.codex` and `.agents` of *each* writable root. A patch that touches `.git/hooks/pre-commit` would let the agent run code later, outside any approval. So those paths always need a prompt. This also holds when the workspace itself sits inside another root, like a project under `/tmp`: its `.git` is still protected.

A **hard-linked** file (one with more than one name on disk) also needs a prompt. Its other name may be outside the workspace, so writing it could change a file the sandbox should protect. Patch prompts use their own method, `item/fileChange/requestApproval`, with the same decisions except `acceptWithExecpolicyAmendment`.

## In educodex

The decision logic is pure functions in [`policy/approval.py`](../../src/educodex/core/policy/approval.py). The core of it is the fallback for commands that no rule matched:

```python
def _heuristic(dangerous, approval_policy, restricted, escalate):
    """render_decision_for_unmatched_command (exec_policy.rs ~L770)."""
    if dangerous:
        if approval_policy == "never":
            return "forbidden", "dangerous command (forced rm) and approval_policy is never"
        return "prompt", "dangerous command (forced rm) always needs approval"
    if approval_policy == "never":
        if escalate:
            return "forbidden", "escalation requested but approval_policy is never"
        return "allow", "approval_policy is never: rely on the sandbox"
    if not restricted:
        return "allow", "danger-full-access: no sandbox, command not flagged as dangerous"
    if escalate:
        return "prompt", "model asked to run outside the sandbox (require_escalated)"
    return "allow", "run inside the sandbox; it enforces the limits"
```

`decide_exec` first refuses `require_escalated` under `never`, before looking at any rule (as Codex does). Then it runs the rules or this heuristic for each segment of the command and returns an `ExecDecision(decision, sandboxed, reason, matched_rules)`. Segments and rules are covered in chapter 11. `decide_patch` does the patch check. Its `is_writable` says no for paths outside the writable roots, inside any root's `.git`/`.codex`/`.agents`, or for hard-linked files:

```python
def is_writable(path, writable_roots):
    if not any(path.is_relative_to(root) for root in writable_roots):
        return False
    if any(path.is_relative_to(root / name) for root in writable_roots for name in PROTECTED_SUBPATHS):
        return False
    return not (path.is_file() and path.stat().st_nlink > 1)
```

The handlers in [`tools/handlers.py`](../../src/educodex/core/tools/handlers.py) act on the decision. For `exec_command`:
1. Call `decide_exec` and emit `trace/policyDecision`.
2. `forbidden`: return the reason to the model (`exec command rejected: …`).
3. `prompt`: send `item/commandExecution/requestApproval`. `availableDecisions` lists the buttons; `acceptWithExecpolicyAmendment` is only in it when the model proposed a valid `prefix_rule` (`valid_prefix_rule`).
4. Apply the answer: `acceptForSession` adds a key to `session.approved_commands`, and an amendment adds a `PrefixRule` to `session.rules`. The key is the working directory, the escalation flag, the shell and the command together, so approving `make` in one folder does not approve it in another, or approve an escalated run of it.
5. Run the command, sandboxed or not.

`ApplyPatchHandler` does the same with `decide_patch` and `item/fileChange/requestApproval`. `acceptForSession` there remembers the paths, and `TurnContext.patch_paths_approved_for_session` skips the prompt when every path of a later patch was approved before.

Note the comment in step 4: **approval does not remove the sandbox.** A user who approves `rm -rf build` lets it run, but still inside the sandbox. Only an approved `require_escalated` request runs outside it.

The pause itself is one `await`. [`turn.py`](../../src/educodex/core/turn.py) `TurnContext.request_approval` calls `session.request_client(...)`. In the app server, that is `Connection.request` in [`app_server/connection.py`](../../src/educodex/app_server/connection.py), which sends the request and waits on a future:

```python
async def request(self, method, params):
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
```

When the client's answer arrives, `MessageProcessor.handle` sees a message without `method` and resolves the future. Either way, the server then sends a `serverRequest/resolved` notification, and the web UI removes the approval card. The turn never hangs:
- If the user interrupts the turn, the turn's task is cancelled, which also cancels the `await future`. Other threads' approvals are not touched.
- If the client disconnects, `cancel_pending` answers its open requests with `cancel`.
- A `cancel` answer raises `TurnAborted`, which ends the turn as `interrupted`.

Without a client (tests), `Session` uses `_deny_all`, which declines everything.

## In Codex

**The policy enum.** [`AskForApproval`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/protocol/src/protocol.rs#L1028) has four variants: `UnlessTrusted` (serialized as `untrusted`), `OnRequest`, `Granular(GranularApprovalConfig)` and `Never`.

**Command decisions.** [`render_decision_for_unmatched_command_for_platform`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/exec_policy.rs#L770) is the function `_heuristic` mirrors. The [dangerous branch](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/exec_policy.rs#L799) returns `Forbidden` under `Never` and `Prompt` otherwise. Codex adds one more case here: on Windows with the sandbox backend disabled, it treats every command like a dangerous one. When a prompt is needed but the policy forbids prompts, [`prompt_is_rejected_by_policy`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/exec_policy.rs#L216) turns it into a refusal with the reason ["approval required by policy, but AskForApproval is set to Never"](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/exec_policy.rs#L48).

Escalation under `never` is refused even earlier, in the [`exec_command` handler](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/handlers/unified_exec/exec_command.rs#L337): "you cannot ask for escalated permissions if the approval policy is Never".

**The orchestrator** ([`tools/orchestrator.rs`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/orchestrator.rs#L142)) runs every tool call in the same order: **1) approval**, then **[2) first attempt in the selected sandbox](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/orchestrator.rs#L228)**, then, if the sandbox blocked it, maybe a retry without the sandbox. Under `never` and `on-request`, [it does not retry](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/orchestrator.rs#L439); the model sees the denial and can ask for escalation itself (chapter 10). The default requirement when a tool has no special rule is in [`default_exec_approval_requirement`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/sandboxing.rs#L196).

**Asking.** [`Session::request_approval`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/approvals.rs#L479) decides who answers: first permission-request hooks, then the auto-review "guardian" model if it is enabled, else the user. User answers go through [`with_cached_approval`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/sandboxing.rs#L72), which implements `acceptForSession`. The [cache keys](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/approvals.rs#L239) are the canonical command plus `cwd`, `tty` and sandbox permissions for commands, and one key per file for patches.

**Amendments** are written to disk: [`exec_approval`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/session/handlers.rs#L177) calls `persist_execpolicy_amendment`, which appends the rule to `~/.codex/rules/default.rules` ([`blocking_append_allow_prefix_rule`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/execpolicy/src/amend.rs#L65)). The same function shows `cancel`: `ReviewDecision::Abort` interrupts the task.

**Patches.** [`assess_patch_safety`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/safety.rs#L67) returns `AutoApprove`, `AskUser` or `Reject`. Note [the hard-link comment](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/safety.rs#L102): even an auto-approved patch runs inside the sandbox, because a path inside the workspace can be a hard link to a file outside it. The protected names are [`.git`, `.agents`, `.codex`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/protocol/src/permissions.rs#L40).

**On the wire.** The server requests are declared in [`common.rs`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/app-server-protocol/src/protocol/common.rs#L1784): `item/commandExecution/requestApproval` and `item/fileChange/requestApproval`. The decision enums are [`CommandExecutionApprovalDecision`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/app-server-protocol/src/protocol/v2/item.rs#L66) (which also has `applyNetworkPolicyAmendment`) and [`FileChangeApprovalDecision`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/app-server-protocol/src/protocol/v2/item.rs#L115); the params are [`CommandExecutionRequestApprovalParams`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/app-server-protocol/src/protocol/v2/item.rs#L1555). The app server turns the core's `ExecApprovalRequest` event into that request in [`bespoke_event_handling.rs`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/app-server/src/bespoke_event_handling.rs#L668).

**The prompt text** the model reads is [`approval_policy/on_request.md`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/prompts/templates/permissions/approval_policy/on_request.md), vendored as-is in educodex.

## Where educodex is simpler

- **Two policies.** No `untrusted` and no `granular`.
- **No hooks or guardian in the approval path.** Codex can let a `PermissionRequest` hook or an auto-review model answer before the user. educodex always asks the client.
- **Simpler session key.** educodex keys `acceptForSession` on the raw command text plus folder, shell and escalation. Codex uses the canonical (parsed) command plus `cwd`, `tty` and sandbox permissions.
- **Amendments live in memory.** `acceptWithExecpolicyAmendment` adds a rule for this session only. Codex appends it to `default.rules` so it lasts.
- **Patches run in-process.** An auto-approved patch is written by Python directly, not inside the sandbox. To cover the hard-link case Codex guards against, educodex asks before writing a hard-linked file instead.
- **No network approvals** (`applyNetworkPolicyAmendment`) and no `startedAtMs` in the request params.
- **No OS sandbox on Linux/Windows.** If a command should be sandboxed but Seatbelt isn't available, educodex asks under `on-request` instead of running it unprotected.

## Try it

**Offline, in the web UI.** The fake model script ends with a `rm -rf build` that always needs approval. Use a scratch folder, since the script also writes `hello.py`:

```bash
mkdir -p /tmp/approval-demo
uv run educodex app-server --fake-model examples/fake/demo.json --cwd /tmp/approval-demo
```

Open http://127.0.0.1:8765 and send any message. When the approval card appears:
- open the **Protocol** tab and find the `item/commandExecution/requestApproval` request with an `id` like `srv-…`. The turn is paused;
- open the **Guardrails** tab: `trace/policyDecision` says `prompt` with the reason "dangerous command (forced rm) always needs approval";
- click `decline`. The model receives "exec command rejected by user" and the turn goes on. The Protocol tab shows the response and then a `serverRequest/resolved` notification. Run it again and click `cancel`: the turn ends as `interrupted`.

Switch the approval selector to `never` and start a new thread. The same command is now `forbidden` without any prompt.

**With a real model** (needs `OPENROUTER_API_KEY`):

```bash
uv run educodex exec --cwd /tmp/approval-demo "Create a folder build with a file in it, then delete it with rm -rf"
uv run educodex exec --cwd /tmp/approval-demo --sandbox read-only "Create notes.txt containing hi"
```

The first one prompts in the terminal for the `rm -rf`. In the second one, the patch prompts because the sandbox is read-only. (The terminal prompt offers `accept`, `acceptForSession`, `decline` and `cancel`. The web UI draws its buttons from `availableDecisions`, so it also shows `acceptWithExecpolicyAmendment` when the model proposed a valid `prefix_rule`.)

The same offline demo works in the terminal: `uv run educodex exec --cwd /tmp/approval-demo --fake-model examples/fake/demo.json "go"` stops at the `rm -rf` and asks you.

**Read the tests:** `tests/test_policy.py` has short tests for each branch: sandboxed default, dangerous commands, escalation, rules, session approvals and patches.

## Further reading
- [Agent approvals & security](https://learn.chatgpt.com/docs/agent-approvals-security): the user's view of sandbox modes and approval policies.
- [Unlocking the Codex harness: how we built the App Server](https://openai.com/index/unlocking-the-codex-harness/): why approvals are server-initiated requests.
- [Auto-review](https://developers.openai.com/codex/concepts/sandboxing/auto-review): letting a second model answer approvals.
- [JSON-RPC 2.0 specification](https://www.jsonrpc.org/specification): requests, responses and ids.
