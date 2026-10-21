# 10 — Sandboxing

## Concept

### Two layers, two questions

Chapter 09 covered **approvals**: the harness decides *whether to ask you* before a command runs. That decision is made by reading the command text. Text can lie, though. `python build.py` looks harmless, but the script can delete your home directory.

A **sandbox** is the second layer. The operating system enforces it, so it does not care what the command looks like. It limits what the process can *actually do*, whatever the process turns out to be.

| Layer | Who enforces it | Question it answers | Fails how? |
|---|---|---|---|
| Approval policy | the harness | "Should I ask the user first?" | a harmless-looking command does harm |
| Sandbox | the OS kernel | "What can this process touch?" | the syscall fails: `Operation not permitted` |

Together they let an agent work without asking about every `ls`: most commands run straight away *inside* the sandbox, and only commands that need to leave it require a yes from you.

### Sandbox modes

Codex has three modes (`--sandbox` in educodex):

| Mode | Read | Write | Network |
|---|---|---|---|
| `read-only` | everything | nothing (except `/dev/null`) | off |
| `workspace-write` | everything | the working directory, `/tmp`, `$TMPDIR` | off unless enabled |
| `danger-full-access` | everything | everything | on (no sandbox at all) |

Two details matter in `workspace-write`:
- **Writable roots** include the temp directories. Compilers, test runners and package managers write there, and would break otherwise.
- **Protected subpaths** stay read-only even inside a writable root: `.git`, `.codex` and `.agents`. A model that can rewrite `.git/hooks` or its own config can escape the sandbox the next time you run `git commit`. If one root sits inside another (a project under `/tmp`), the outer root's rule must exclude the inner project's `.git` too, or the outer rule would let the write through.

### macOS: Seatbelt

macOS ships a sandbox called **Seatbelt** (the same one App Store apps use). You give `/usr/bin/sandbox-exec` a policy written in a small Lisp-like language (SBPL) and a command:

```
sandbox-exec -p '<policy>' -DWRITABLE_ROOT_0=/Users/me/proj -- /bin/zsh -lc 'npm test'
```

A policy starts from "deny everything" and adds allow rules:

```scheme
(version 1)
(deny default)                       ; closed by default
(allow process-exec) (allow process-fork)
(allow file-read*)                   ; read anything
(allow file-write*
  (require-all (subpath (param "WRITABLE_ROOT_0"))
               (require-not (subpath (param "WRITABLE_ROOT_0_EXCLUDED_0")))))  ; .git
```

Paths are not pasted into the policy text. They are passed as `-D` parameters and referenced with `(param "...")`, so a strange folder name cannot break or inject into the policy. Child processes inherit the sandbox, so `bash -c "..."` inside the sandbox is still sandboxed.

Network is off unless the policy allows `network-outbound`. The harness also sets two environment variables so tools can tell they are sandboxed: `CODEX_SANDBOX=seatbelt` and `CODEX_SANDBOX_NETWORK_DISABLED=1`.

### When the sandbox says no

A sandboxed command that writes outside its roots just fails:

```
Process exited with code 1
Output:
/bin/sh: /Users/me/notes.txt: Operation not permitted
```

The model sees this like any other output. The permissions prompt (chapter 05) tells it what to do next: rerun the command and ask to leave the sandbox. It does that with two extra arguments to `exec_command`:

```json
{
  "cmd": "npm install",
  "sandbox_permissions": "require_escalated",
  "justification": "Do you want to download and install dependencies for this project?",
  "prefix_rule": ["npm", "install"]
}
```

`require_escalated` in a restricted sandbox always triggers an approval prompt (chapter 09). Only if you accept does the command run **without** the sandbox. Approving a normal command does not remove the sandbox; only an approved escalation does.

### Other operating systems

Each OS needs a different mechanism:
- **Linux**: Codex uses [bubblewrap](https://github.com/containers/bubblewrap) (`bwrap`, user namespaces and bind mounts) for the filesystem, plus seccomp filters for syscalls such as network sockets. Landlock is a legacy fallback.
- **Windows**: there is no `sandbox-exec`. Codex runs commands under a restricted token and dedicated sandbox users, with file ACLs to control writes. OpenAI wrote up why this is hard in [Building a safe, effective sandbox to enable Codex on Windows](https://openai.com/index/building-codex-windows-sandbox/).

## In educodex

[`sandbox/seatbelt.py`](../../../backends/educodex/src/educodex/core/sandbox/seatbelt.py) builds the `sandbox-exec` command. It reuses Codex's own `.sbpl` files, copied into [`vendor/codex/seatbelt/`](../../../backends/educodex/src/educodex/vendor/codex/seatbelt/):

```python
sections = [vendor.read("seatbelt/seatbelt_base_policy.sbpl"), "; allow read-only file operations\n(allow file-read*)"]

if sandbox_mode == "workspace-write":
    roots = writable_roots(cwd)
    for i, root in enumerate(roots):
        params[f"WRITABLE_ROOT_{i}"] = str(root)
        # .git/.codex/.agents of this root and of any root nested in it (cwd under /tmp)
        excluded = [r / name for r in roots if r.is_relative_to(root) for name in PROTECTED_SUBPATHS]
        ...
        rules.append(f"(require-all {' '.join(parts)})")
    sections.append("(allow file-write*\n" + "\n".join(rules) + "\n)")

if network_access:
    sections.append("(allow network-outbound)\n(allow network-inbound)\n" + vendor.read("seatbelt/seatbelt_network_policy.sbpl"))
```

`writable_roots()` returns `cwd`, `/tmp` and `tempfile.gettempdir()` (which reads `$TMPDIR`), all resolved. On macOS `/tmp` is really `/private/tmp`, and Seatbelt matches real paths, so resolving matters. In `read-only` mode there is no `file-write*` rule at all. The same list feeds the `<permissions instructions>` fragment ("The writable roots are …", chapter 05) and the patch check (chapter 09), so the model, the patch policy and the sandbox agree on what is writable.

[`tools/handlers.py`](../../../backends/educodex/src/educodex/core/tools/handlers.py) connects the layers in `ExecCommandHandler.handle`:
1. `decide_exec` (chapter 09) returns `allow`/`prompt`/`forbidden` **and** `sandboxed`. `sandboxed` is false only for `danger-full-access`, an approved `require_escalated` call, or a command where every segment matched an allow rule (chapter 11).
2. If sandboxed, it wraps the shell command with `seatbelt.build(...)`, sets the env from `seatbelt.sandbox_env(...)`, and emits `trace/sandboxCommand` with the argv, policy text and `-D` params.
3. After the run, `_is_likely_sandbox_denied` looks for a denial and emits `trace/sandboxDenied`:

```python
SANDBOX_DENIAL_HINTS = ("operation not permitted", "permission denied", "read-only file system", "seccomp",
                        "sandbox", "landlock", "failed to write file")

def _is_likely_sandbox_denied(output: str, exit_code: int | None) -> bool:
    return bool(exit_code) and any(hint in output.lower() for hint in SANDBOX_DENIAL_HINTS)
```

There is no reliable signal that the sandbox blocked something, so this is a guess: a non-zero exit plus a well-known denial message. The keyword list is Codex's. educodex does not retry by itself: the model reads the error and decides whether to ask for `require_escalated`.

Not on macOS? `seatbelt.available()` is false. Under `on-request` every command that would be sandboxed then asks for approval; under `never` it runs unsandboxed and the trace carries a warning.

## In Codex

| What | Where |
|---|---|
| Only trust `/usr/bin/sandbox-exec`, never `$PATH` | [`sandboxing/src/seatbelt.rs#L62`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/sandboxing/src/seatbelt.rs#L62) |
| Build the policy and `-D` args | [`create_seatbelt_command_args_with_profile`, seatbelt.rs#L878](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/sandboxing/src/seatbelt.rs#L878) |
| `WRITABLE_ROOT_n` / `_EXCLUDED_m` rules | [`build_seatbelt_access_policy`, seatbelt.rs#L486](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/sandboxing/src/seatbelt.rs#L486) |
| Network on: `(allow network-outbound)` + network policy | [seatbelt.rs#L370](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/sandboxing/src/seatbelt.rs#L370) |
| Order of policy sections | [seatbelt.rs#L1043](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/sandboxing/src/seatbelt.rs#L1043) |
| The `.sbpl` files | [`sandboxing/src/`](https://github.com/openai/codex/tree/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/sandboxing/src) (`seatbelt_base_policy.sbpl`, `seatbelt_network_policy.sbpl`, ...) |
| Protected names `.git`, `.agents`, `.codex`, `.aws` | [`protocol/src/permissions.rs#L46`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/protocol/src/permissions.rs#L46) |
| `/tmp` and `$TMPDIR` as writable roots | [permissions.rs#L2428](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/protocol/src/permissions.rs#L2428) |
| `SandboxMode` enum | [`protocol/src/config_types.rs#L104`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/protocol/src/config_types.rs#L104) |
| `CODEX_SANDBOX` / `CODEX_SANDBOX_NETWORK_DISABLED` | [`core/src/spawn.rs#L26`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/spawn.rs#L26), set in [`core/src/sandboxing/mod.rs#L179`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/sandboxing/mod.rs#L179) |
| Denial heuristic | [`sandboxing/src/denial.rs#L13`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/sandboxing/src/denial.rs#L13) |
| `sandbox_permissions` / `justification` / `prefix_rule` in the tool schema | [`core/src/tools/handlers/shell_spec.rs#L239`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/handlers/shell_spec.rs#L239) |
| Prompt telling the model to rerun with `require_escalated` | [`prompts/templates/permissions/approval_policy/on_request.md#L32`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/prompts/templates/permissions/approval_policy/on_request.md#L32) |
| Approval → sandbox → attempt → retry | [`core/src/tools/orchestrator.rs#L4`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/orchestrator.rs#L4), no auto-retry under `on-request`/`never` at [#L439](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/orchestrator.rs#L439) |
| Sandbox types (Seatbelt, Linux seccomp, Windows) | [`protocol/src/sandbox.rs#L29`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/protocol/src/sandbox.rs#L29) |
| Linux | [`linux-sandbox/README.md`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/linux-sandbox/README.md), [`sandboxing/src/bwrap.rs`](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/sandboxing/src/bwrap.rs) |
| Windows | [`windows-sandbox-rs/`](https://github.com/openai/codex/tree/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/windows-sandbox-rs) |

Things to notice:
- **Denial check order.** Codex first returns `false` for exit code 0, then checks the [keywords](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/sandboxing/src/denial.rs#L50) in stdout, stderr and the combined output. Only when no keyword matches does it look at exit codes: 2, 126 and 127 mean "not a denial" ([denial.rs#L25](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/sandboxing/src/denial.rs#L25)), and on Linux a `SIGSYS` exit means seccomp killed the process. educodex does the keyword part, without an exit-code filter in front of it.
- **Retry.** Under the `untrusted` policy, a denied command makes Codex itself ask "command failed; retry without sandbox?" ([orchestrator.rs#L625](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/core/src/tools/orchestrator.rs#L625)). Under `on-request` it leaves this to the model, as educodex does.
- **Extra hardening.** Codex's policy also blocks every XPC service lookup, denies renaming the writable roots and the parents of protected paths, and denies two `fcntl` calls that can change files through read-only handles ([seatbelt.rs#L1065](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/sandboxing/src/seatbelt.rs#L1065)). Each fixes a real escape.
- **Protected paths** get both `literal` and `subpath` exclusions, plus a regex on the name ([seatbelt.rs#L561](https://github.com/openai/codex/blob/1c7c43cd856a1ef451cb7ff9dc1b701ac7942c9d/codex-rs/sandboxing/src/seatbelt.rs#L561)).

## Where educodex is simpler

- **macOS only.** No bubblewrap, seccomp, Landlock or Windows sandbox. On other platforms educodex asks for approval instead (or warns under `never`).
- **Fixed modes.** Codex has full permission profiles: extra writable roots, unreadable paths and globs, and `with_additional_permissions` to widen the sandbox for one command without leaving it. educodex has three modes and a `--network` switch.
- **Protected subpaths** are `.git`, `.codex`, `.agents`. Codex also protects `.aws`.
- **No network proxy.** Codex can route sandboxed traffic through a proxy that allows only some domains. educodex is all on or all off.
- **Simpler policy.** No XPC, rename or `fcntl` hardening. Fine for learning, not for real untrusted code.
- **`apply_patch` is not sandboxed.** educodex writes patches from the harness process and protects them with `decide_patch` (chapter 09). Codex runs patches through the same sandbox runtime as commands.

## Try it

**1. Watch the sandbox block a write.** In a project folder (not under `/tmp`, which is itself a writable root):

```bash
uv run educodex exec --sandbox read-only "Run the shell command: echo hi > hello.txt. Then tell me what happened"
```

Look for the `sandbox` line with the `sandbox-exec` argv, then the `Operation not permitted` output and the `trace/sandboxDenied` line. A good model will then ask for `require_escalated`, and you get an approval prompt.

**2. Same task in `workspace-write`** (the default): the write succeeds, still sandboxed. Then try a protected path:

```bash
uv run educodex exec "Run: touch .git/educodex-test"
```

**3. Check the environment variables** a sandboxed process sees:

```bash
uv run educodex exec "Run: env | grep CODEX_SANDBOX"
```

**4. See the full policy in the visualiser.** [Start the launcher](README.md#the-visualiser), pick **educodex**, set the sandbox mode in the controls and run a command. The **Guardrails** tab shows each `trace/policyDecision`, the `trace/sandboxCommand` with its `-D` parameters and policy text, and any `trace/sandboxDenied`. Offline: add `--fake-model examples/fake/demo.json` to `exec`, or pick **educodex-demo**; the scripted `ls -la` and `python3 hello.py` run under Seatbelt.

**5. Run Seatbelt by hand** (macOS):

```bash
sandbox-exec -p '(version 1)(deny default)(allow process-exec)(allow process-fork)(allow file-read*)' -- /bin/sh -c 'echo hi > ~/x.txt'
# /bin/sh: /Users/you/x.txt: Operation not permitted
```

## Further reading
- [Sandboxing](https://developers.openai.com/codex/concepts/sandboxing) and [Agent approvals & security](https://learn.chatgpt.com/docs/agent-approvals-security): the user-facing view of modes and policies.
- [Building a safe, effective sandbox to enable Codex on Windows](https://openai.com/index/building-codex-windows-sandbox/): what an OS sandbox must enforce, and why Windows is hard.
- [The New Inner Loop of Software Engineering](https://turingpost.substack.com/p/the-new-inner-loop-of-software-engineering): Michael Bolin on sandboxing on each OS.
- [The lethal trifecta for AI agents](https://simonwillison.net/2025/Jun/16/the-lethal-trifecta/): why "network off" is a big deal (more in chapter 11).
