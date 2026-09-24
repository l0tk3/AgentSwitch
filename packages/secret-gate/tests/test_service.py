"""`secret-gate service`: launchd plist, launchctl command lines, verbs, CLI.

No test runs the real launchctl or touches ~/Library/LaunchAgents: every verb gets a fake runner and a tmp
LaunchAgents directory, and an autouse guard makes the real runner and the real deps explode if reached.
"""

from __future__ import annotations

import plistlib
import stat
import subprocess
import sys
from dataclasses import replace
from pathlib import Path

import pytest

from secret_gate import service as svc
from secret_gate.cli import build_parser, main, mitmdump_argv
from secret_gate.errors import KeyStoreError, ValidationError
from secret_gate.service import (
    SERVICE_LABEL,
    CommandResult,
    ServiceDeps,
    build_spec,
    install,
    installed_port,
    is_not_loaded,
    parse_print,
    reload,
    render_plist,
    status,
    uninstall,
)

UID = 4242
NOT_FOUND = CommandResult(113, "", "Could not find service \"com.agentswitch.secret-gate.proxy\" in domain for user gui: 4242")
PRINT_OUT = (
    "gui/4242/com.agentswitch.secret-gate.proxy = {\n"
    "\tactive count = 1\n"
    "\tpath = /Users/x/Library/LaunchAgents/com.agentswitch.secret-gate.proxy.plist\n"
    "\tstate = running\n"
    "\tpid = 777\n"
    "\tlast exit code = (never exited)\n"
    "\tendpoints = {\n"
    "\t\tstate = active\n"
    "\t}\n"
    "}\n"
)


class FakeRunner:
    """Scripted launchctl: `results[verb]` is a list consumed per call (last one repeats)."""

    def __init__(self, **results: list[CommandResult]) -> None:
        self.results = results
        self.calls: list[tuple[str, ...]] = []

    def __call__(self, argv):
        self.calls.append(tuple(argv))
        assert argv[0] == "launchctl"
        queue = self.results.get(argv[1], [CommandResult(0)])
        return queue.pop(0) if len(queue) > 1 else queue[0]


class FakeProbe:
    def __init__(self, answers: list[bool]) -> None:
        self.answers = answers
        self.ports: list[int] = []

    def __call__(self, port: int) -> bool:
        self.ports.append(port)
        return self.answers.pop(0) if len(self.answers) > 1 else self.answers[0]


@pytest.fixture(autouse=True)
def no_real_launchd(monkeypatch):
    def boom(*_a, **_k):
        raise AssertionError("a test reached the real launchctl / LaunchAgents")
    monkeypatch.setattr(svc, "run_command", boom)
    monkeypatch.setattr(svc, "system_deps", boom)


def _deps(tmp_path, runner=None, probe=None, **kw) -> ServiceDeps:
    return ServiceDeps(uid=UID, launch_agents=tmp_path / "LaunchAgents", runner=runner or FakeRunner(),
                       probe=probe or FakeProbe([True]), sleep=kw.pop("sleep", lambda _s: None), **kw)


def _spec(home: Path, deps: ServiceDeps, port: int = 8080):
    return build_spec(home, port, deps.launch_agents)


def _mode(path: Path) -> int:
    return stat.S_IMODE(path.stat().st_mode)


# -- spec and plist ------------------------------------------------------------------------------

def test_gate_command_prefers_the_console_script_of_this_interpreter(tmp_path):
    exe = tmp_path / "bin" / "python"
    exe.parent.mkdir()
    exe.write_text("")
    assert svc.gate_command(str(exe)) == (str(exe), "-m", "secret_gate.cli")
    (exe.parent / "secret-gate").write_text("")
    assert svc.gate_command(str(exe)) == (str(exe.parent / "secret-gate"),)


def test_plist_runs_this_installation_on_loopback_with_a_minimal_env(tmp_path):
    exe = tmp_path / "venv" / "bin" / "python"
    exe.parent.mkdir(parents=True)
    (exe.parent / "secret-gate").write_text("")
    spec = build_spec(tmp_path / "gate", 9001, tmp_path / "LaunchAgents", executable=str(exe))
    data = plistlib.loads(render_plist(spec))
    assert data["Label"] == SERVICE_LABEL
    assert data["ProgramArguments"] == [str(exe.parent / "secret-gate"), "proxy", "--port", "9001"]
    assert data["EnvironmentVariables"] == {
        "SECRET_GATE_HOME": str(tmp_path / "gate"),
        "PATH": f"{exe.parent}:/usr/bin:/bin:/usr/sbin:/sbin",
    }
    assert not any("proxy" in k.lower() for k in data["EnvironmentVariables"])
    assert data["RunAtLoad"] is True and data["KeepAlive"] is True and data["ProcessType"] == "Background"
    assert data["Umask"] == 0o077
    assert data["StandardOutPath"] == str(tmp_path / "gate" / "logs" / "proxy.out.log")
    assert data["StandardErrorPath"] == str(tmp_path / "gate" / "logs" / "proxy.err.log")
    assert spec.plist_path == tmp_path / "LaunchAgents" / f"{SERVICE_LABEL}.plist"


def test_the_service_command_line_binds_loopback_only(tmp_path):
    """The plist runs `secret-gate proxy --port N`; that command's mitmdump argv listens on 127.0.0.1."""
    spec = build_spec(tmp_path, 9002, tmp_path)
    args = build_parser().parse_args(list(spec.program_arguments[-3:]))
    assert args.cmd == "proxy" and args.port == 9002
    argv = mitmdump_argv("/x/mitmdump", tmp_path / "entry.py", args.port)
    assert argv[argv.index("--listen-host") + 1] == "127.0.0.1"


@pytest.mark.parametrize("port", [0, 65536, -1, True])
def test_bad_ports_are_refused(tmp_path, port):
    with pytest.raises(ValidationError):
        build_spec(tmp_path, port, tmp_path)


def test_installed_port(tmp_path):
    spec = build_spec(tmp_path, 9123, tmp_path)
    plist = tmp_path / "x.plist"
    assert installed_port(plist) is None                                   # missing
    plist.write_bytes(render_plist(spec))
    assert installed_port(plist) == 9123
    plist.write_bytes(b"<?xml version='1.0'?><plist><dict><key>")         # truncated XML
    assert installed_port(plist) is None
    plist.write_bytes(b"\x00garbage")
    assert installed_port(plist) is None
    plist.write_bytes(plistlib.dumps(["not", "a", "dict"]))
    assert installed_port(plist) is None
    plist.write_bytes(plistlib.dumps({"ProgramArguments": "proxy"}))
    assert installed_port(plist) is None
    plist.write_bytes(plistlib.dumps({"ProgramArguments": ["x", "proxy"]}))
    assert installed_port(plist) is None


def test_launchctl_helpers():
    assert svc.bootout_cmd(UID) == ("launchctl", "bootout", f"gui/{UID}/{SERVICE_LABEL}")
    assert svc.bootstrap_cmd(UID, Path("/p.plist")) == ("launchctl", "bootstrap", f"gui/{UID}", "/p.plist")
    assert svc.print_cmd(UID) == ("launchctl", "print", f"gui/{UID}/{SERVICE_LABEL}")
    assert svc.sighup_cmd(UID) == ("launchctl", "kill", "SIGHUP", f"gui/{UID}/{SERVICE_LABEL}")
    assert is_not_loaded(NOT_FOUND)
    assert is_not_loaded(CommandResult(3, "", "Boot-out failed: 3: No such process"))
    assert is_not_loaded(CommandResult(1, "", "service not loaded"))
    assert not is_not_loaded(CommandResult(5, "", "Input/output error"))
    assert parse_print(PRINT_OUT) == {"state": "running", "pid": "777", "last exit code": "(never exited)"}


# -- install -------------------------------------------------------------------------------------

def test_install_requires_a_keypair_and_changes_nothing_without_one(tmp_path):
    deps = _deps(tmp_path)
    spec = _spec(tmp_path / "empty-home", deps)
    for dry_run in (True, False):
        with pytest.raises(KeyStoreError):
            install(spec, deps, dry_run=dry_run)
    assert deps.runner.calls == [] and not deps.launch_agents.exists()


def test_install_dry_run_prints_plist_and_commands_only(gate_home, tmp_path):
    deps = _deps(tmp_path)
    spec = _spec(gate_home, deps)
    outcome = install(spec, deps, dry_run=True)
    text = "\n".join(outcome.lines)
    assert outcome.ok and deps.runner.calls == []
    assert not spec.plist_path.exists() and not spec.logs_dir.exists()
    assert "<key>Label</key>" in text and f"launchctl bootstrap gui/{UID}" in text
    assert "listening on 127.0.0.1:8080 only" in text and "no proxy variables" in text


def test_install_writes_plist_logs_and_loads(gate_home, tmp_path):
    runner = FakeRunner(bootout=[NOT_FOUND])
    probe = FakeProbe([False, False, True])                               # free before, up on 2nd poll
    sleeps: list[float] = []
    deps = _deps(tmp_path, runner, probe, sleep=sleeps.append)
    spec = _spec(gate_home, deps, 9010)
    outcome = install(spec, deps)
    assert outcome.ok, outcome.lines
    assert runner.calls == [svc.bootout_cmd(UID), svc.bootstrap_cmd(UID, spec.plist_path)]
    assert plistlib.loads(spec.plist_path.read_bytes())["ProgramArguments"][-1] == "9010"
    assert _mode(spec.plist_path) == 0o644
    assert _mode(spec.logs_dir) == 0o700
    assert _mode(spec.out_log) == 0o600 and _mode(spec.err_log) == 0o600
    assert not any("warning" in line for line in outcome.lines)
    assert outcome.lines[-1] == "proxy is up on 127.0.0.1:9010" and len(sleeps) == 1
    assert set(probe.ports) == {9010}


def test_install_tightens_existing_logs_and_replaces_the_plist(gate_home, tmp_path):
    deps = _deps(tmp_path, probe=FakeProbe([False, True]))
    spec = _spec(gate_home, deps)
    spec.logs_dir.mkdir(mode=0o755)
    spec.err_log.write_text("old\n")
    spec.err_log.chmod(0o644)
    deps.launch_agents.mkdir()
    spec.plist_path.write_text("stale")
    assert install(spec, deps).ok
    assert _mode(spec.logs_dir) == 0o700 and _mode(spec.err_log) == 0o600
    assert spec.err_log.read_text() == "old\n"                            # appended to, never truncated
    assert plistlib.loads(spec.plist_path.read_bytes())["Label"] == SERVICE_LABEL


def test_install_warns_on_busy_port_and_unknown_bootout_error(gate_home, tmp_path):
    runner = FakeRunner(bootout=[CommandResult(5, "", "Input/output error")])
    probe = FakeProbe([True])                                             # somebody already listens
    deps = _deps(tmp_path, runner, probe)
    outcome = install(_spec(gate_home, deps), deps)
    text = "\n".join(outcome.lines)
    assert outcome.ok
    assert "warning: launchctl bootout" in text and "Input/output error" in text
    assert "already in use" in text and "does not stop it" in text
    assert probe.ports == [8080]                                          # no startup wait on a busy port


def test_install_retries_bootstrap_then_reports_failure(gate_home, tmp_path):
    runner = FakeRunner(bootstrap=[CommandResult(5, "", "Bootstrap failed: 5: Input/output error")])
    sleeps: list[float] = []
    deps = _deps(tmp_path, runner, FakeProbe([False]), sleep=sleeps.append)
    spec = _spec(gate_home, deps)
    outcome = install(spec, deps)
    assert not outcome.ok
    assert runner.calls.count(svc.bootstrap_cmd(UID, spec.plist_path)) == svc.BOOTSTRAP_RETRIES
    assert len(sleeps) == svc.BOOTSTRAP_RETRIES - 1
    assert spec.plist_path.exists() and "service uninstall" in outcome.lines[-1]


def test_install_bootstrap_race_recovers(gate_home, tmp_path):
    runner = FakeRunner(bootstrap=[CommandResult(5, "", "Input/output error"), CommandResult(0)])
    deps = _deps(tmp_path, runner, FakeProbe([False, True]))
    assert install(_spec(gate_home, deps), deps).ok


def test_install_warns_when_the_proxy_never_comes_up(gate_home, tmp_path):
    sleeps: list[float] = []
    deps = _deps(tmp_path, probe=FakeProbe([False]), sleep=sleeps.append)
    outcome = install(_spec(gate_home, deps), deps)
    assert outcome.ok and outcome.lines[-1].startswith("warning:") and "proxy.err.log" in outcome.lines[-1]
    assert len(sleeps) == svc.STARTUP_WAIT_TRIES


# -- uninstall / status / reload -----------------------------------------------------------------

def test_uninstall_stops_and_removes_plist_keeps_logs(gate_home, tmp_path):
    deps = _deps(tmp_path)
    spec = _spec(gate_home, deps)
    deps.launch_agents.mkdir()
    spec.plist_path.write_bytes(render_plist(spec))
    spec.logs_dir.mkdir()
    outcome = uninstall(spec, deps)
    assert outcome.ok and not spec.plist_path.exists() and spec.logs_dir.exists()
    assert deps.runner.calls == [svc.bootout_cmd(UID)]
    assert f"stopped {SERVICE_LABEL}" in outcome.lines


def test_uninstall_when_not_loaded_or_not_installed(gate_home, tmp_path):
    deps = _deps(tmp_path, FakeRunner(bootout=[NOT_FOUND]))
    outcome = uninstall(_spec(gate_home, deps), deps)
    assert outcome.ok and any("was not loaded" in line for line in outcome.lines)
    assert any(line.startswith("no plist at") for line in outcome.lines)


def test_uninstall_unknown_error_keeps_plist(gate_home, tmp_path):
    deps = _deps(tmp_path, FakeRunner(bootout=[CommandResult(1, "", "Operation not permitted")]))
    spec = _spec(gate_home, deps)
    deps.launch_agents.mkdir()
    spec.plist_path.write_text("x")
    outcome = uninstall(spec, deps)
    assert not outcome.ok and spec.plist_path.exists() and "Operation not permitted" in outcome.lines[-1]


def test_uninstall_dry_run(gate_home, tmp_path):
    deps = _deps(tmp_path)
    spec = _spec(gate_home, deps)
    deps.launch_agents.mkdir()
    spec.plist_path.write_text("x")
    assert uninstall(spec, deps, dry_run=True).ok
    assert spec.plist_path.exists() and deps.runner.calls == []


def test_status_healthy(gate_home, tmp_path):
    deps = _deps(tmp_path, FakeRunner(print=[CommandResult(0, PRINT_OUT)]), FakeProbe([True]))
    outcome = status(_spec(gate_home, deps), deps)
    assert outcome.ok and outcome.lines[-1] == "healthy"
    assert "launchd: loaded (state = running, pid = 777, last exit code = (never exited))" in outcome.lines
    assert any("plist:" in line and "missing" in line for line in outcome.lines)


@pytest.mark.parametrize("printed,reachable,expect", [
    (NOT_FOUND, True, "launchd: not loaded"),
    (CommandResult(0, ""), False, "proxy: 127.0.0.1:8080 NOT reachable"),
])
def test_status_unhealthy(gate_home, tmp_path, printed, reachable, expect):
    deps = _deps(tmp_path, FakeRunner(print=[printed]), FakeProbe([reachable]))
    outcome = status(_spec(gate_home, deps), deps)
    assert not outcome.ok and expect in outcome.lines and outcome.lines[-1] == "NOT healthy"


def test_reload_variants(gate_home, tmp_path):
    ok = _deps(tmp_path)
    spec = _spec(gate_home, ok)
    sent = reload(spec, ok)
    assert sent.ok and ok.runner.calls == [svc.sighup_cmd(UID)] and "upstream-insecure.txt" in sent.lines[-1]
    not_loaded = _deps(tmp_path, FakeRunner(kill=[NOT_FOUND]))
    assert not reload(spec, not_loaded).ok
    broken = _deps(tmp_path, FakeRunner(kill=[CommandResult(1, "", "boom")]))
    assert "boom" in reload(spec, broken).lines[-1]
    dry = _deps(tmp_path)
    assert reload(spec, dry, dry_run=True).ok and dry.runner.calls == []


# -- plumbing ------------------------------------------------------------------------------------

def test_atomic_write_cleans_up_on_failure(tmp_path, monkeypatch):
    target = tmp_path / "f.plist"
    svc.atomic_write(target, b"one", 0o644)
    assert target.read_bytes() == b"one" and _mode(target) == 0o644

    def fail(*_a):
        raise OSError("disk full")
    monkeypatch.setattr(svc.os, "replace", fail)
    with pytest.raises(OSError):
        svc.atomic_write(target, b"two", 0o644)
    assert target.read_bytes() == b"one" and [p.name for p in tmp_path.iterdir()] == ["f.plist"]


def test_run_command_real_runner_without_launchctl(monkeypatch):
    monkeypatch.undo()                                                    # the guard replaced run_command
    ok = svc.run_command([sys.executable, "-c", "import sys; print('out'); print('err', file=sys.stderr)"])
    assert ok == CommandResult(0, "out\n", "err\n")
    assert svc.run_command(["/nonexistent/launchctl-x"]).returncode == 127

    def slow(*_a, **_k):
        raise subprocess.TimeoutExpired("x", 1)
    monkeypatch.setattr(svc.subprocess, "run", slow)
    assert svc.run_command(["x"]).returncode == 124


def test_system_deps_points_at_the_user_domain(monkeypatch):
    monkeypatch.undo()
    deps = svc.system_deps()                                              # constructing touches nothing
    assert deps.uid == svc.os.getuid() and deps.runner is svc.run_command
    assert deps.launch_agents == Path.home() / "Library" / "LaunchAgents"


# -- CLI -----------------------------------------------------------------------------------------

@pytest.fixture
def cli_deps(tmp_path, monkeypatch):
    holder = {"deps": _deps(tmp_path, platform="darwin")}
    monkeypatch.setattr(svc, "system_deps", lambda: holder["deps"])
    return holder


def test_cli_install_dry_run_and_status(gate_home, cli_deps, capsys):
    assert main(["service", "install", "--dry-run", "--port", "9444"]) == 0
    out = capsys.readouterr().out
    assert "<string>9444</string>" in out and "dry run" in out
    cli_deps["deps"] = replace(cli_deps["deps"], runner=FakeRunner(print=[NOT_FOUND]))
    assert main(["service", "status"]) == 1
    assert "NOT healthy" in capsys.readouterr().out


def test_cli_status_uses_the_installed_port(gate_home, cli_deps, tmp_path, capsys):
    deps = cli_deps["deps"]
    deps.launch_agents.mkdir()
    spec = build_spec(gate_home, 9123, deps.launch_agents)
    spec.plist_path.write_bytes(render_plist(spec))
    assert main(["service", "status"]) == 0
    assert deps.probe.ports == [9123]
    assert main(["service", "status", "--port", "9555"]) == 0
    assert deps.probe.ports[-1] == 9555


def test_cli_install_uninstall_reload(gate_home, cli_deps, capsys):
    cli_deps["deps"] = replace(cli_deps["deps"], probe=FakeProbe([False, True]))
    assert main(["service", "install", "--port", "9333"]) == 0
    assert cli_deps["deps"].launch_agents.joinpath(f"{SERVICE_LABEL}.plist").exists()
    assert main(["service", "reload"]) == 0
    assert main(["service", "uninstall"]) == 0
    assert not cli_deps["deps"].launch_agents.joinpath(f"{SERVICE_LABEL}.plist").exists()
    assert main(["service", "reload", "--dry-run"]) == 0
    assert main(["service", "uninstall", "--dry-run"]) == 0


def test_cli_refuses_non_macos_unless_dry_run(gate_home, cli_deps, capsys):
    cli_deps["deps"] = replace(cli_deps["deps"], platform="linux")
    assert main(["service", "status"]) == 2
    assert "macOS-only" in capsys.readouterr().err
    assert main(["service", "install", "--dry-run"]) == 0


def test_cli_rejects_bad_port(gate_home, cli_deps):
    with pytest.raises(SystemExit):
        main(["service", "install", "--port", "70000"])
    with pytest.raises(SystemExit):
        main(["service"])


def test_reinstall_waits_for_the_old_instance_to_release_the_port(gate_home, tmp_path):
    probe = FakeProbe([True, True, False, True])                          # old one exits, new one comes up
    sleeps: list[float] = []
    deps = _deps(tmp_path, FakeRunner(bootout=[CommandResult(0)]), probe, sleep=sleeps.append)
    outcome = install(_spec(gate_home, deps), deps)
    assert outcome.ok and not any("already in use" in line for line in outcome.lines)
    assert outcome.lines[-1] == "proxy is up on 127.0.0.1:8080" and len(sleeps) == 2


def test_reinstall_reports_a_port_that_stays_busy(gate_home, tmp_path):
    sleeps: list[float] = []
    deps = _deps(tmp_path, FakeRunner(bootout=[CommandResult(0)]), FakeProbe([True]), sleep=sleeps.append)
    outcome = install(_spec(gate_home, deps), deps)
    assert outcome.ok and any("already in use" in line for line in outcome.lines)
    assert len(sleeps) == svc.STARTUP_WAIT_TRIES
