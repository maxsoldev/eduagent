from educodex.core.tools.output import approx_token_count, format_exec_output, format_legacy_output, truncate_middle


def test_truncate_middle_keeps_head_and_tail():
    text = "A" * 4000 + "B" * 4000
    out, original = truncate_middle(text, 100)  # 400 bytes budget
    assert out.startswith("A" * 200) and out.endswith("B" * 200)
    assert "…1900 tokens truncated…" in out
    assert original == 2000


def test_no_truncation_when_small():
    assert truncate_middle("hi", 10) == ("hi", None)
    assert approx_token_count("abcde") == 2


def test_exec_output_format():
    text = format_exec_output("5\n", 0.0982, 0, 10_000)
    lines = text.splitlines()
    assert lines[0].startswith("Chunk ID: ")
    assert lines[1:] == [
        "Wall time: 0.0982 seconds",
        "Process exited with code 0",
        "Original token count: 1",
        "Output:",
        "5",
    ]
    running = format_exec_output("", 10.0, None, 10_000, session_id=1001)
    assert "Process running with session ID 1001" in running


def test_legacy_format():
    assert format_legacy_output("ok", 0.5, 0) == "Exit code: 0\nWall time: 0.5 seconds\nOutput:\nok"
