"""The Windows service `AgentSwitchGate`: a small host that keeps the rpc server and the proxy running (gate-simple-v0 §5).

`secret-gate system install` registers `"<pf>\\gate-runtime\\python\\python.exe" -I -m secret_gate.win_service` under
the virtual account `NT SERVICE\\AgentSwitchGate` (platform/windows.py). Why a host instead of two services: a virtual
account belongs to exactly one service, and both processes need the one key.

The host is pywin32's servicemanager running in the runtime's own interpreter (no pythonservice.exe, no registry entry
for a Python class: the module is the service). On start it reads the proxy port from gate-service.json and starts

* `python -I -m secret_gate.cli rpc` (the named pipe, winpipe.py), and
* `python -I -m secret_gate.cli proxy --port <port> --confdir <gate>\\mitmproxy`,

each with the environment launchd and systemd give them elsewhere (`SECRET_GATE_HOME`, `HOME`, `SECRET_GATE_PUBLIC`, a
PATH of the runtime and the Windows directory, plus what Windows itself needs), stdout and stderr appended to
`<gate>\\logs\\<name>.log`. A child that exits is started again after RESTART_DELAY_SECONDS (KeepAlive / Restart=always);
the children are in a job object that kills them when the host goes, so a crashed host leaves no orphan holding the
port. Stopping the service ends both children. The SCM restarts the host itself when it dies (`sc failure`).

`Supervisor` is plain Python with an injectable process starter and clock, tested on every system.
"""

from __future__ import annotations

import os
import subprocess
import sys
import threading
import time
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any, BinaryIO

RESTART_DELAY_SECONDS = 2.0
STOP_WAIT_SECONDS = 10.0
POLL_SECONDS = 0.5
CHILD_NAMES = ("rpc", "proxy")
# What Windows itself needs in a child's environment, taken from the host's (which the SCM built from the system's).
SYSTEM_ENV = ("SystemRoot", "SystemDrive", "windir", "ProgramData", "ProgramFiles", "NUMBER_OF_PROCESSORS",
              "PROCESSOR_ARCHITECTURE", "OS")


def child_env(gate: Path, public: Path, python: Path, windows: str, base: Mapping[str, str]) -> dict[str, str]:
    """The environment of both children: the gate's variables, a PATH of the runtime and the Windows directory, the
    gate home as HOME, USERPROFILE and TEMP (the virtual account has no profile of its own to rely on), and nothing
    of the SCM's environment but SYSTEM_ENV. No proxy variables: the gate's own traffic must not go through itself."""
    env = {name: base[name] for name in SYSTEM_ENV if base.get(name)}
    tmp = str(gate / "tmp")
    env.update({
        "SECRET_GATE_HOME": str(gate), "HOME": str(gate), "USERPROFILE": str(gate), "SECRET_GATE_PUBLIC": str(public),
        "TEMP": tmp, "TMP": tmp, "SystemRoot": base.get("SystemRoot") or windows,
        "PATH": ";".join((str(python.parent), str(python.parent / "Scripts"), windows + "\\System32", windows)),
    })
    return env


def child_commands(python: Path, port: int, confdir: Path) -> dict[str, list[str]]:
    """-I: no PYTHON* variables, no user site-packages, no current directory on sys.path; -X utf8: the logs are UTF-8
    (Windows would write them in the ANSI code page)."""
    base = [str(python), "-I", "-X", "utf8", "-m", "secret_gate.cli"]
    return {"rpc": [*base, "rpc"], "proxy": [*base, "proxy", "--port", str(port), "--confdir", str(confdir)]}


@dataclass
class Child:
    name: str
    argv: list[str]
    process: Any = None
    restart_at: float = 0.0
    starts: int = 0


@dataclass
class Supervisor:
    """Start every child, start again whatever exits (after a delay), stop them all on request."""

    commands: dict[str, list[str]]
    env: dict[str, str]
    logs: Path
    start_process: Callable[..., Any] = subprocess.Popen
    clock: Callable[[], float] = time.monotonic
    on_start: Callable[[Any], None] = lambda _process: None
    log: Callable[[str], None] = lambda line: print(f"secret-gate service: {line}", file=sys.stderr, flush=True)
    children: list[Child] = field(default_factory=list)

    def __post_init__(self) -> None:
        self.children = [Child(name, argv) for name, argv in self.commands.items()]

    def _open_log(self, name: str) -> BinaryIO:
        self.logs.mkdir(parents=True, exist_ok=True)
        return open(self.logs / f"{name}.log", "ab")  # noqa: SIM115 - handed to the child, closed below

    def _start(self, child: Child) -> None:
        log = self._open_log(child.name)
        try:
            child.process = self.start_process(
                child.argv, env=self.env, stdin=subprocess.DEVNULL, stdout=log, stderr=subprocess.STDOUT,
                cwd=str(self.logs.parent), creationflags=getattr(subprocess, "CREATE_NO_WINDOW", 0))
        except OSError as exc:
            child.process = None
            child.restart_at = self.clock() + RESTART_DELAY_SECONDS
            self.log(f"{child.name}: could not start ({exc.strerror or exc}); trying again")
            return
        finally:
            log.close()
        child.starts += 1
        self.on_start(child.process)
        self.log(f"{child.name}: started (pid {child.process.pid})")

    def tick(self) -> None:
        """One look: start what is not running and due."""
        now = self.clock()
        for child in self.children:
            if child.process is not None:
                code = child.process.poll()
                if code is None:
                    continue
                self.log(f"{child.name}: exited with {code}; starting again in {RESTART_DELAY_SECONDS:g} s")
                child.process = None
                child.restart_at = now + RESTART_DELAY_SECONDS
            if now >= child.restart_at:
                self._start(child)

    def run(self, stopping: threading.Event, poll: float = POLL_SECONDS) -> None:
        while not stopping.is_set():
            self.tick()
            stopping.wait(poll)
        self.stop()

    def stop(self) -> None:
        for child in self.children:
            if child.process is not None and child.process.poll() is None:
                child.process.terminate()
        deadline = self.clock() + STOP_WAIT_SECONDS
        for child in self.children:
            if child.process is None:
                continue
            try:
                child.process.wait(timeout=max(0.1, deadline - self.clock()))
            except subprocess.TimeoutExpired:
                child.process.kill()
            child.process = None


def build_supervisor(env: Mapping[str, str] | None = None) -> Supervisor:
    """The installed service's children, from this machine's layout and gate-service.json."""
    from .fsacl import windows_dir
    from .service_paths import SystemLayout, read_service_config

    layout = SystemLayout.native()
    config = read_service_config(layout.config)
    python = Path(sys.executable)
    (layout.gate / "tmp").mkdir(exist_ok=True)
    return Supervisor(child_commands(python, config.proxy_port, layout.mitmproxy),
                      child_env(layout.gate, layout.public, python, windows_dir(), os.environ if env is None else env),
                      layout.logs, on_start=_kill_on_close_job())


def _kill_on_close_job() -> Callable[[Any], None]:
    """A job object that ends every child when the host's last handle to it goes (the host exits or crashes)."""
    try:
        import win32api
        import win32con
        import win32job
    except ImportError:
        return lambda _process: None
    job = win32job.CreateJobObject(None, "")
    limits = win32job.QueryInformationJobObject(job, win32job.JobObjectExtendedLimitInformation)
    limits["BasicLimitInformation"]["LimitFlags"] |= win32job.JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE
    win32job.SetInformationJobObject(job, win32job.JobObjectExtendedLimitInformation, limits)

    def assign(process: Any) -> None:
        handle = win32api.OpenProcess(win32con.PROCESS_SET_QUOTA | win32con.PROCESS_TERMINATE, False, process.pid)
        try:
            win32job.AssignProcessToJobObject(job, handle)
        except Exception:  # noqa: BLE001 - best effort: stopping the service still ends the child
            pass
        finally:
            win32api.CloseHandle(handle)

    assign.job = job  # type: ignore[attr-defined]  # keep the job open as long as the host lives
    return assign


def _file_log(path: Path) -> Callable[[str], None]:
    """The host's own lines (children started, exited) in `<gate>\\logs\\service.log`."""
    def log(line: str) -> None:
        try:
            with open(path, "a", encoding="utf-8") as fh:
                fh.write(f"{time.strftime('%Y-%m-%dT%H:%M:%S')} {line}\n")
        except OSError:
            pass
    return log


def main() -> None:  # pragma: no cover - needs the Windows service control manager
    import servicemanager
    import win32service
    import win32serviceutil

    from .platform.windows import DISPLAY_NAME, SERVICE_NAME

    class GateService(win32serviceutil.ServiceFramework):
        _svc_name_ = SERVICE_NAME
        _svc_display_name_ = DISPLAY_NAME

        def __init__(self, args: Any) -> None:
            super().__init__(args)
            self.stopping = threading.Event()

        def SvcStop(self) -> None:  # noqa: N802 - pywin32's name
            self.ReportServiceStatus(win32service.SERVICE_STOP_PENDING, waitHint=int(STOP_WAIT_SECONDS * 1000) + 5000)
            self.stopping.set()

        def SvcDoRun(self) -> None:  # noqa: N802
            try:
                supervisor = build_supervisor()
            except Exception as exc:  # noqa: BLE001 - say why in the event log, then stop
                servicemanager.LogErrorMsg(f"{SERVICE_NAME}: cannot start: {exc}")
                return
            supervisor.log = _file_log(supervisor.logs / "service.log")
            supervisor.run(self.stopping)

    servicemanager.Initialize()
    servicemanager.PrepareToHostSingle(GateService)
    servicemanager.StartServiceCtrlDispatcher()


if __name__ == "__main__":  # pragma: no cover
    main()
