"""SIGHUP reload of upstream-insecure.txt: strict parsing, keep-previous on bad files, handler install."""

from __future__ import annotations

import asyncio
import os
import signal

import pytest

from secret_gate.errors import ValidationError
from secret_gate.reload import (
    MAX_FILE_BYTES,
    MAX_LISTED_CHANGES,
    InsecureHostsReloader,
    check_insecure_hosts,
    read_insecure_hosts,
    reload_patterns,
    valid_pattern,
)
from secret_gate.upstream_tls import UPSTREAM_INSECURE_FILE, UpstreamTlsAddon, parse_insecure_hosts


class FakeLoop:
    def __init__(self, fail: Exception | None = None) -> None:
        self.fail = fail
        self.handlers: dict[int, object] = {}
        self.removed: list[int] = []

    def add_signal_handler(self, signum, callback):
        if self.fail:
            raise self.fail
        self.handlers[signum] = callback

    def remove_signal_handler(self, signum):
        self.removed.append(signum)
        return self.handlers.pop(signum, None) is not None


def _write(home, text: str, mode: int = 0o644):
    path = home / UPSTREAM_INSECURE_FILE
    path.write_text(text)
    path.chmod(mode)
    return path


@pytest.mark.parametrize("pattern,ok", [
    ("core.internal.example", True),
    ("core.internal.example:8600", True),
    ("*.lab.example", True),
    ("10.0.0.5", True),
    ("10.0.0.5:8443", True),
    ("::1", True),
    ("fe80::1", True),
    ("*", False),
    ("*.lab.example:8443", False),       # host_is_insecure never matches a wildcard with a port
    ("host:0", False),
    ("host:70000", False),
    ("host:https", False),
    ("not a host", False),
    ("http://core.internal.example", False),
    ("*.*.example", False),
])
def test_valid_pattern(pattern, ok):
    assert valid_pattern(pattern) is ok


def test_strict_parse_matches_startup_parse_on_valid_files():
    text = "# internal\ncore.internal.example:8600\nMail.internal.example  # mail\n*.lab.example\n\n"
    assert check_insecure_hosts(text) == parse_insecure_hosts(text)


def test_strict_parse_names_the_bad_line():
    with pytest.raises(ValidationError, match="line 3"):
        check_insecure_hosts("a.example\n# comment\nbad host\n")


def test_read_missing_file_means_no_exceptions(tmp_path):
    assert read_insecure_hosts(tmp_path / UPSTREAM_INSECURE_FILE) == frozenset()


@pytest.mark.parametrize("setup,match", [
    (lambda p: (p.mkdir(),), "not a regular file"),
    (lambda p: (p.write_text("a.example\n"), p.chmod(0o666)), "writable by group/others"),
    (lambda p: (p.write_text("a.example\n"), p.chmod(0o620)), "writable by group/others"),
    (lambda p: (p.write_bytes(b"a" * (MAX_FILE_BYTES + 1)), p.chmod(0o644)), "larger than"),
    (lambda p: (p.write_bytes(b"\xff\xfe host\n"), p.chmod(0o644)), "not UTF-8"),
    (lambda p: (p.write_text("a.example\n"), p.chmod(0o000)), "cannot read"),
])
def test_read_refuses_untrustworthy_files(tmp_path, setup, match):
    path = tmp_path / UPSTREAM_INSECURE_FILE
    setup(path)
    try:
        with pytest.raises(ValidationError, match=match):
            read_insecure_hosts(path)
    finally:
        if path.is_file():
            path.chmod(0o644)


def test_read_reports_stat_errors(tmp_path):
    blocker = tmp_path / "file"
    blocker.write_text("")
    with pytest.raises(ValidationError, match="cannot stat"):
        read_insecure_hosts(blocker / UPSTREAM_INSECURE_FILE)   # a path under a regular file


def test_reload_patterns_reports_the_diff(tmp_path):
    path = _write(tmp_path, "a.example\nc.example:8443\n")
    result = reload_patterns(path, frozenset({"a.example", "b.example"}))
    assert result.ok and result.patterns == {"a.example", "c.example:8443"}
    assert result.message.endswith("reloaded: 2 pattern(s) (added: c.example:8443; removed: b.example)")
    same = reload_patterns(path, result.patterns)
    assert same.ok and same.message.endswith("(unchanged)")


def test_reload_patterns_truncates_long_change_lists(tmp_path):
    hosts = [f"h{i:03d}.example" for i in range(MAX_LISTED_CHANGES + 5)]
    path = _write(tmp_path, "\n".join(hosts) + "\n")
    result = reload_patterns(path, frozenset())
    assert "(+5 more)" in result.message and hosts[-1] not in result.message


def test_reload_patterns_keeps_previous_on_a_bad_file(tmp_path):
    previous = frozenset({"a.example"})
    path = _write(tmp_path, "a.example\nb.example\nnot a host\n")
    result = reload_patterns(path, previous)
    assert not result.ok and result.patterns is previous
    assert "FAILED, keeping the previous 1 pattern(s): line 3" in result.message


def test_reloader_swaps_the_addon_set_and_reports(tmp_path):
    addon = UpstreamTlsAddon(frozenset({"old.example"}))
    lines: list[str] = []
    reloader = InsecureHostsReloader(addon, tmp_path, emit=lines.append, get_loop=FakeLoop)
    _write(tmp_path, "new.example\n")
    assert reloader.reload().ok
    assert addon.patterns == {"new.example"}
    _write(tmp_path, "new.example\nbad host\n")
    assert not reloader.reload().ok
    assert addon.patterns == {"new.example"}                              # untouched on failure
    assert "reloaded" in lines[0] and "FAILED" in lines[1]


def test_running_installs_sighup_handler_and_done_removes_it(tmp_path):
    addon = UpstreamTlsAddon(frozenset())
    loop = FakeLoop()
    lines: list[str] = []
    reloader = InsecureHostsReloader(addon, tmp_path, emit=lines.append, get_loop=lambda: loop)
    reloader.running()
    assert list(loop.handlers) == [signal.SIGHUP]
    _write(tmp_path, "a.example\n")
    loop.handlers[signal.SIGHUP]()                                        # what the loop does on SIGHUP
    assert addon.patterns == {"a.example"}
    reloader.done()
    reloader.done()                                                       # idempotent
    assert loop.removed == [signal.SIGHUP] and not loop.handlers


@pytest.mark.parametrize("error", [NotImplementedError(), RuntimeError("not the main thread")])
def test_running_without_signal_support_reports_and_keeps_going(tmp_path, error):
    loop = FakeLoop(fail=error)
    lines: list[str] = []
    reloader = InsecureHostsReloader(UpstreamTlsAddon(frozenset()), tmp_path, emit=lines.append,
                                     get_loop=lambda: loop)
    reloader.running()
    reloader.done()
    assert "SIGHUP reload unavailable" in lines[0] and loop.removed == []


def test_platform_without_sighup(tmp_path):
    lines: list[str] = []
    reloader = InsecureHostsReloader(UpstreamTlsAddon(frozenset()), tmp_path, emit=lines.append,
                                     get_loop=FakeLoop, signum=None)
    reloader.running()
    reloader.done()
    assert "no SIGHUP" in lines[0]


def test_default_emit_writes_one_line_to_stderr(tmp_path, capsys):
    reloader = InsecureHostsReloader(UpstreamTlsAddon(frozenset()), tmp_path, get_loop=FakeLoop)
    reloader.reload()
    captured = capsys.readouterr()
    assert captured.out == "" and captured.err.count("\n") == 1 and "reloaded: 0 pattern(s)" in captured.err


@pytest.mark.skipif(not hasattr(signal, "SIGHUP"), reason="POSIX only")
def test_real_sighup_through_an_asyncio_loop(tmp_path):
    """One real signal to this process, sent only after the loop's handler is verifiably in place."""
    previous = signal.getsignal(signal.SIGHUP)
    addon = UpstreamTlsAddon(frozenset())
    lines: list[str] = []
    loop = asyncio.new_event_loop()
    reloaded = loop.create_future()

    def emit(line: str) -> None:  # the reload reports after it has replaced the patterns
        lines.append(line)
        if not reloaded.done():
            reloaded.set_result(None)

    try:
        reloader = InsecureHostsReloader(addon, tmp_path, emit=emit, get_loop=lambda: loop)
        reloader.running()
        assert signal.getsignal(signal.SIGHUP) not in (signal.SIG_DFL, signal.SIG_IGN, previous)
        _write(tmp_path, "signalled.example\n")
        os.kill(os.getpid(), signal.SIGHUP)
        # Returns as soon as the loop has run the handler; the timeout only bounds a failure.
        loop.run_until_complete(asyncio.wait_for(reloaded, timeout=10))
        assert addon.patterns == {"signalled.example"} and len(lines) == 1
        reloader.done()
    finally:
        loop.close()
        signal.signal(signal.SIGHUP, previous)


def test_start_up_uses_the_strict_rules(tmp_path, capsys):
    from secret_gate.reload import initial_patterns

    listed = tmp_path / "upstream-insecure.txt"
    listed.write_text("intranet.example.com:8443\n")
    listed.chmod(0o644)
    assert initial_patterns(tmp_path) == frozenset({"intranet.example.com:8443"})
    listed.chmod(0o666)  # writable by others: nothing from it is trusted
    assert initial_patterns(tmp_path) == frozenset()
    assert "not loaded at start-up" in capsys.readouterr().err
