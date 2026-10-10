import pytest

from educodex.tools.apply_patch import PatchError, apply_planned, parse_patch, plan_changes, seek_sequence


def run(patch, cwd):
    return apply_planned(plan_changes(patch, cwd))


def test_add_update_delete(tmp_path):
    (tmp_path / "old.txt").write_text("bye\n")
    (tmp_path / "app.py").write_text("def main():\n    print('old')\n    return 1\n")
    out = run(
        "*** Begin Patch\n*** Add File: new.txt\n+hello\n"
        "*** Update File: app.py\n@@ def main():\n-    print('old')\n+    print('new')\n"
        "*** Delete File: old.txt\n*** End Patch",
        tmp_path,
    )
    assert out == "Success. Updated the following files:\nA new.txt\nM app.py\nD old.txt\n"
    assert (tmp_path / "new.txt").read_text() == "hello\n"
    assert (tmp_path / "app.py").read_text() == "def main():\n    print('new')\n    return 1\n"
    assert not (tmp_path / "old.txt").exists()


def test_move_file(tmp_path):
    (tmp_path / "a.txt").write_text("x\ny\n")
    out = run("*** Begin Patch\n*** Update File: a.txt\n*** Move to: sub/b.txt\n@@\n x\n-y\n+z\n*** End Patch", tmp_path)
    assert out.splitlines()[1] == "M a.txt"  # Codex lists the source path
    assert (tmp_path / "sub/b.txt").read_text() == "x\nz\n"
    assert not (tmp_path / "a.txt").exists()


def test_fuzzy_match_ignores_whitespace_and_unicode_dashes(tmp_path):
    (tmp_path / "f.txt").write_text("value = a – b   \n")
    run("*** Begin Patch\n*** Update File: f.txt\n@@\n-value = a - b\n+value = a + b\n*** End Patch", tmp_path)
    assert (tmp_path / "f.txt").read_text() == "value = a + b\n"


def test_seek_sequence_levels():
    assert seek_sequence(["foo", "bar", "baz"], ["bar", "baz"], 0, False) == 1
    assert seek_sequence(["foo   ", "bar\t"], ["foo", "bar"], 0, False) == 0
    assert seek_sequence(["  foo  "], ["foo"], 0, False) == 0
    assert seek_sequence(["a", "b"], ["c"], 0, False) is None


def test_errors(tmp_path):
    with pytest.raises(PatchError, match="Begin Patch"):
        parse_patch("hello")
    with pytest.raises(PatchError, match="file not found"):
        plan_changes("*** Begin Patch\n*** Update File: nope.txt\n@@\n-a\n+b\n*** End Patch", tmp_path)
    (tmp_path / "f.txt").write_text("a\n")
    with pytest.raises(PatchError, match="Failed to find expected lines"):
        plan_changes("*** Begin Patch\n*** Update File: f.txt\n@@\n-zzz\n+b\n*** End Patch", tmp_path)


def test_plan_does_not_touch_disk(tmp_path):
    plan_changes("*** Begin Patch\n*** Add File: x.txt\n+1\n*** End Patch", tmp_path)
    assert not (tmp_path / "x.txt").exists()
