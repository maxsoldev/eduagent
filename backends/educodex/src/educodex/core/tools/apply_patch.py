"""apply_patch: the model's file-editing tool.

The model writes a patch in Codex's own format (grammar: vendor/codex/apply_patch.lark):

    *** Begin Patch
    *** Add File: hello.txt
    +hi
    *** Update File: src/app.py
    @@ def main():
    -    print("old")
    +    print("new")
    *** Delete File: obsolete.txt
    *** End Patch

Mirrors codex-rs/apply-patch/src/{parser.rs, seek_sequence.rs, file_update.rs}, simplified:
we parse, locate each chunk with progressively looser matching, and rewrite the files.
"""

import difflib
from dataclasses import dataclass, field
from pathlib import Path


class PatchError(Exception):
    pass


@dataclass
class Chunk:
    """One `@@` section of an Update File hunk."""

    context: str | None = None  # the line after "@@ ", used to jump to the right place
    old_lines: list[str] = field(default_factory=list)
    new_lines: list[str] = field(default_factory=list)
    is_end_of_file: bool = False


@dataclass
class Hunk:
    kind: str  # "add" | "delete" | "update"
    path: str
    contents: str = ""  # for add
    move_to: str | None = None  # for update
    chunks: list[Chunk] = field(default_factory=list)  # for update


@dataclass
class FileChange:
    """What happened to one file. Shape matches Codex app-server `fileChange.changes[]`."""

    path: str
    kind: str  # "add" | "delete" | "update"
    diff: str
    move_path: str | None = None


def parse_patch(text: str) -> list[Hunk]:
    lines = text.strip().splitlines()
    if not lines or lines[0].strip() != "*** Begin Patch":
        raise PatchError("The first line of the patch must be '*** Begin Patch'")
    if lines[-1].strip() != "*** End Patch":
        raise PatchError("The last line of the patch must be '*** End Patch'")
    hunks: list[Hunk] = []
    i, body = 0, lines[1:-1]
    while i < len(body):
        line = body[i]
        if line.startswith("*** Add File: "):
            hunk = Hunk("add", line.removeprefix("*** Add File: ").strip())
            i += 1
            added = []
            while i < len(body) and body[i].startswith("+"):
                added.append(body[i][1:])
                i += 1
            hunk.contents = "".join(f"{a}\n" for a in added)
            hunks.append(hunk)
        elif line.startswith("*** Delete File: "):
            hunks.append(Hunk("delete", line.removeprefix("*** Delete File: ").strip()))
            i += 1
        elif line.startswith("*** Update File: "):
            hunk = Hunk("update", line.removeprefix("*** Update File: ").strip())
            i += 1
            if i < len(body) and body[i].startswith("*** Move to: "):
                hunk.move_to = body[i].removeprefix("*** Move to: ").strip()
                i += 1
            chunk: Chunk | None = None
            while i < len(body) and (body[i] == "*** End of File" or not body[i].startswith("*** ")):
                line = body[i]
                i += 1
                if line == "*** End of File":
                    if chunk:
                        chunk.is_end_of_file = True
                    continue
                if line.startswith("@@"):
                    chunk = Chunk(context=line[3:] if line.startswith("@@ ") else None)
                    hunk.chunks.append(chunk)
                    continue
                if chunk is None:  # the first chunk may omit "@@"
                    chunk = Chunk()
                    hunk.chunks.append(chunk)
                prefix, rest = (line[:1], line[1:]) if line else (" ", "")
                if prefix not in " -+":
                    raise PatchError(f"Unexpected line in update hunk for {hunk.path}: {line!r}")
                if prefix in " -":
                    chunk.old_lines.append(rest)
                if prefix in " +":
                    chunk.new_lines.append(rest)
            if not hunk.chunks:
                raise PatchError(f"Update file hunk for path '{hunk.path}' is empty")
            hunks.append(hunk)
        else:
            raise PatchError(f"'{line}' is not a valid hunk header")
    return hunks


_PUNCTUATION = str.maketrans(
    {
        **dict.fromkeys("‐‑‒–—―−", "-"),
        **dict.fromkeys("‘’‚‛", "'"),
        **dict.fromkeys("“”„‟", '"'),
        **dict.fromkeys("            　", " "),
    }
)


def seek_sequence(lines: list[str], pattern: list[str], start: int, eof: bool) -> int | None:
    """Find `pattern` in `lines`, trying exact, then trailing-space, then trimmed, then unicode-normalised."""
    if not pattern:
        return start
    if len(pattern) > len(lines):
        return None
    first = max(len(lines) - len(pattern), start) if eof else start
    for normalise in (lambda s: s, str.rstrip, str.strip, lambda s: s.strip().translate(_PUNCTUATION)):
        wanted = [normalise(p) for p in pattern]
        for i in range(first, len(lines) - len(pattern) + 1):
            if [normalise(l) for l in lines[i : i + len(pattern)]] == wanted:
                return i
    return None


def _apply_chunks(original: str, path: str, chunks: list[Chunk]) -> str:
    lines = original.split("\n")
    if lines and lines[-1] == "":
        lines.pop()  # the final newline is implied
    replacements: list[tuple[int, int, list[str]]] = []
    index = 0
    for chunk in chunks:
        if chunk.context is not None:
            found = seek_sequence(lines, [chunk.context], index, False)
            if found is None:
                raise PatchError(f"Failed to find context '{chunk.context}' in {path}")
            index = found + 1
        if not chunk.old_lines:
            replacements.append((len(lines), 0, chunk.new_lines))
            continue
        old, new = chunk.old_lines, chunk.new_lines
        found = seek_sequence(lines, old, index, chunk.is_end_of_file)
        if found is None and old and old[-1] == "":
            old, new = old[:-1], new[:-1] if new and new[-1] == "" else new
            found = seek_sequence(lines, old, index, chunk.is_end_of_file)
        if found is None:
            raise PatchError(f"Failed to find expected lines in {path}:\n" + "\n".join(chunk.old_lines))
        replacements.append((found, len(old), new))
        index = found + len(old)
    for start, length, new in sorted(replacements, reverse=True):
        lines[start : start + length] = new
    return "\n".join(lines) + "\n"


def _diff(path: str, before: str, after: str) -> str:
    return "".join(difflib.unified_diff(before.splitlines(True), after.splitlines(True), f"a/{path}", f"b/{path}"))


@dataclass
class PlannedWrite:
    path: Path
    contents: str | None  # None means delete


def plan_changes(patch: str, cwd: Path) -> list[tuple[FileChange, list[PlannedWrite]]]:
    """Work out every change without touching disk, so policy can inspect the paths first.

    Hunks apply in order against an in-memory view, so two hunks on one file (or Add then Update)
    see each other's changes, as when Codex applies them one by one.
    """
    hunks = parse_patch(patch)
    if not hunks:
        raise PatchError("No files were modified.")
    view: dict[Path, str | None] = {}  # path -> contents after earlier hunks (None = deleted)

    def read(path: Path, name: str, action: str) -> str:
        if path in view:
            if view[path] is None:
                raise PatchError(f"Failed to {action} {name}: file not found")
            return view[path]
        if not path.is_file():
            raise PatchError(f"Failed to {action} {name}: file not found")
        return path.read_text()

    planned = []
    for hunk in hunks:
        source = (cwd / hunk.path).resolve()
        if hunk.kind == "add":
            change = FileChange(hunk.path, "add", _diff(hunk.path, "", hunk.contents))
            writes = [PlannedWrite(source, hunk.contents)]
        elif hunk.kind == "delete":
            before = read(source, hunk.path, "delete file")
            change = FileChange(hunk.path, "delete", _diff(hunk.path, before, ""))
            writes = [PlannedWrite(source, None)]
        else:
            before = read(source, hunk.path, "read file to update")
            after = _apply_chunks(before, hunk.path, hunk.chunks)
            change = FileChange(hunk.path, "update", _diff(hunk.path, before, after), hunk.move_to)
            if hunk.move_to:
                writes = [PlannedWrite((cwd / hunk.move_to).resolve(), after), PlannedWrite(source, None)]
            else:
                writes = [PlannedWrite(source, after)]
        for write in writes:
            view[write.path] = write.contents
        planned.append((change, writes))
    return planned


def apply_planned(planned: list[tuple[FileChange, list[PlannedWrite]]]) -> str:
    """Write the changes and return Codex's summary text (apply-patch/src/lib.rs `print_summary`)."""
    for _, writes in planned:
        for write in writes:
            if write.contents is None:
                write.path.unlink(missing_ok=True)
            else:
                write.path.parent.mkdir(parents=True, exist_ok=True)
                write.path.write_text(write.contents)
    letter = {"add": "A", "update": "M", "delete": "D"}
    lines = ["Success. Updated the following files:"]
    for kind in ("add", "update", "delete"):
        lines += [f"{letter[kind]} {c.path}" for c, _ in planned if c.kind == kind]  # moves list the source path
    return "\n".join(lines) + "\n"
