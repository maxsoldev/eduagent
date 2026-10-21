# eduagent

Readable re-implementations of real coding-agent harnesses, with one web UI that shows every hidden step, so students can learn and compare how the harnesses work.

## Language

**Harness**:
The original coding-agent product that we study, for example Codex or pi.
_Avoid_: original, upstream, agent

**Backend**:
Our re-implementation of one harness, for example educodex (Codex) or edupi (pi).
_Avoid_: server, port, clone

**Visualiser**:
The shared web UI that connects to one backend at a time and shows what it does.
_Avoid_: client, frontend, web client

**Viewer**:
One open visualiser page that is connected to one backend.
_Avoid_: tab, window, session

**Launcher**:
The one program that serves the visualiser, lists the available backends and starts a backend for each viewer.
_Avoid_: server, host, orchestrator

**Adapter**:
The part of the visualiser that turns one backend's native protocol into the shared view.
_Avoid_: translation layer, bridge

**Trace event**:
A teaching-only message that a backend sends in addition to its harness's native protocol.
_Avoid_: debug event, telemetry
