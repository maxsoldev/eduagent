"""Session log ("rollout"): an append-only JSONL file per thread.

Mirrors codex-rs/rollout/src/recorder.rs. Path and line format match Codex:
  <home>/sessions/YYYY/MM/DD/rollout-<YYYY-MM-DDTHH-MM-SS>-<thread id>.jsonl
  {"timestamp": "...", "type": "session_meta|turn_context|response_item|event_msg|compacted", "payload": {...}}
Replaying the response_item lines rebuilds the exact history the model saw.
"""

import datetime
import json
from pathlib import Path
from typing import Any

from educodex import __version__


class RolloutRecorder:
    def __init__(self, home: Path, thread_id: str, path: Path | None = None, enabled: bool = True) -> None:
        now = datetime.datetime.now()
        self.path = path or home / "sessions" / now.strftime("%Y/%m/%d") / (
            f"rollout-{now.strftime('%Y-%m-%dT%H-%M-%S')}-{thread_id}.jsonl"
        )
        self.thread_id = thread_id
        self.enabled = enabled  # False for ephemeral threads: nothing is written
        self._file = None

    def _write(self, kind: str, payload: dict[str, Any]) -> None:
        if not self.enabled:
            return
        if self._file is None:
            self.path.parent.mkdir(parents=True, exist_ok=True)
            self._file = self.path.open("a")
        line = {
            "timestamp": datetime.datetime.now(datetime.UTC).isoformat(timespec="milliseconds"),
            "type": kind,
            "payload": payload,
        }
        self._file.write(json.dumps(line, ensure_ascii=False) + "\n")
        self._file.flush()

    def session_meta(self, config, base_instructions: str) -> None:
        self._write(
            "session_meta",
            {
                "id": self.thread_id,
                "timestamp": datetime.datetime.now(datetime.UTC).isoformat(),
                "cwd": str(config.cwd),
                "originator": "educodex",
                "cli_version": __version__,
                "source": "educodex",
                "model_provider": "openrouter",
                "base_instructions": {"text": base_instructions},
            },
        )

    def turn_context(self, turn_id: str, config) -> None:
        self._write(
            "turn_context",
            {
                "turn_id": turn_id,
                "cwd": str(config.cwd),
                "approval_policy": config.approval_policy,
                "sandbox_policy": {"type": config.sandbox_mode},
                "model": config.model,
                "current_date": datetime.date.today().isoformat(),
            },
        )

    def response_item(self, item: dict[str, Any]) -> None:
        self._write("response_item", item)

    def event(self, kind: str, **payload: Any) -> None:
        self._write("event_msg", {"type": kind, **payload})

    def compacted(self, summary: str, replacement_history: list[dict]) -> None:
        self._write("compacted", {"message": summary, "replacement_history": replacement_history})

    def close(self) -> None:
        if self._file:
            self._file.close()
            self._file = None


def read_rollout(path: Path) -> list[dict[str, Any]]:
    return [json.loads(line) for line in path.read_text().splitlines() if line.strip()]


def history_from_rollout(lines: list[dict[str, Any]]) -> list[dict[str, Any]]:
    """Rebuild model-visible history: response items, with compactions replacing what came before."""
    history: list[dict[str, Any]] = []
    for line in lines:
        if line["type"] == "response_item":
            history.append(line["payload"])
        elif line["type"] == "compacted" and line["payload"].get("replacement_history") is not None:
            history = list(line["payload"]["replacement_history"])
    return history
