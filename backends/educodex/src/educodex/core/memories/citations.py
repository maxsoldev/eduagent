"""Memory citations: the read path asks the model to end a reply that used memories with

    <oai-mem-citation>
    <citation_entries>
    MEMORY.md:234-236|note=[why it helped]
    </citation_entries>
    <rollout_ids>
    019c6e27-...
    </rollout_ids>
    </oai-mem-citation>

The harness hides that block from the user and attaches it to the agentMessage item as
`memoryCitation`. History keeps the raw text. Mirrors codex-rs/utils/stream-parser/src/citation.rs
(`strip_citations`) and memories/read/src/citations.rs (`parse_memory_citation`).
Codex also counts each cited thread (usage_count) to rank memories in phase 2; we do not.
"""

import re

CITATION = re.compile(r"<oai-mem-citation>(.*?)(?:</oai-mem-citation>|\Z)", re.S)  # unclosed: up to the end
ENTRY = re.compile(r"^(.*):(\d+)-(\d+)\|note=\[(.*)\]$")


def _block(text: str, tag: str) -> str | None:
    match = re.search(rf"<{tag}>(.*?)</{tag}>", text, re.S)
    return match.group(1) if match else None


def strip_citations(text: str) -> tuple[str, list[str]]:
    return CITATION.sub("", text), CITATION.findall(text)


def parse_memory_citation(citations: list[str]) -> dict | None:
    """The v2 MemoryCitation shape: {entries: [{path, lineStart, lineEnd, note}], threadIds}."""
    entries, thread_ids = [], []
    for citation in citations:
        for line in (_block(citation, "citation_entries") or "").splitlines():
            if match := ENTRY.match(line.strip()):
                path, start, end, note = match.groups()
                entries.append({"path": path.strip(), "lineStart": int(start), "lineEnd": int(end), "note": note.strip()})
        ids = _block(citation, "rollout_ids") or _block(citation, "thread_ids") or ""
        thread_ids += [i.strip() for i in ids.splitlines() if i.strip() and i.strip() not in thread_ids]
    return {"entries": entries, "threadIds": thread_ids} if entries or thread_ids else None
