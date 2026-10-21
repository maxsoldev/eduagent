# Each backend speaks its harness's native protocol

Each backend speaks the native protocol of the harness it re-implements: educodex speaks the Codex app-server protocol, and edupi speaks pi's RPC protocol. Each backend adds its own trace events on top. The visualiser has one adapter per protocol, which maps native messages into one neutral view model. We rejected the option where edupi pretends to speak the Codex protocol (bash as `commandExecution`, edit as `fileChange`). That would need no UI work, but it would show students Codex concepts that pi does not have, and they would not see how the two protocols differ, which is a lesson in itself.

## Consequences

- Trace events use the same names and payload shapes in both backends where the concept is the same (`modelRequest`, `compacted`, …). Each backend may add its own trace events.
- The visualiser hides panels for features a backend does not have (approvals, sandbox, memories), based on the capabilities listed in the launcher config.
