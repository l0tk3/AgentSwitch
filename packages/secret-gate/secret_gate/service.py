"""`secret-gate service`: run the gate proxy as a launchd LaunchAgent of the current user.

Why a LaunchAgent: executors must not keep handling credentials while the gate they rely on is down
(gate-next-v0 §3). launchd restarts the proxy when it dies (`KeepAlive`), starts it at login
(`RunAtLoad`), and `service status` gives the daemon a health check with a meaningful exit code.

What runs, as whom, where:
* Process: `<this installation's secret-gate> proxy --port N`, i.e. the same `mitmdump` command line as
  `secret-gate proxy` (`cli.mitmdump_argv`), which binds **127.0.0.1 only** (`--listen-host 127.0.0.1`).
  Nothing here changes the listen address.
* Owner: the user who ran `install`, in the `gui/<uid>` domain (loaded while that user is logged in).
  Running the gate under a separate macOS user is the stronger isolation and is still a manual setup.
* Environment: only `SECRET_GATE_HOME` and a minimal `PATH`. Never proxy variables: the gate's own
  upstream traffic must not be routed into itself.
* Files: the plist in `~/Library/LaunchAgents` (mode 0644: it holds paths and a port, no secret; launchd
  only insists that it is not group/world writable), logs in `<gate home>/logs` (dir 0700, files 0600,
  process umask 077). `uninstall` stops the job (launchd sends SIGTERM) and removes the plist; logs stay.

Every `launchctl` call goes through an injectable runner, so tests never touch the real launchd.
"""

from __future__ import annotations

import argparse
import os
import plistlib
import re
import shlex
import subprocess
import sys
import tempfile
import time
from collections.abc import Callable, Sequence
from dataclasses import dataclass
from pathlib import Path
from xml.parsers.expat import ExpatError

from .constants import DEFAULT_PROXY_PORT
from .errors import ValidationError
from .keystore import gate_home, load_private_key
from .proxy_probe import LOOPBACK, tcp_reachable
from .upstream_tls import UPSTREAM_INSECURE_FILE

SERVICE_LABEL = "com.agentswitch.secret-gate.proxy"
PLIST_MODE = 0o644
LOGS_DIR = "logs"
LOGS_DIR_MODE = 0o700
LOG_FILE_MODE = 0o600
OUT_LOG = "proxy.out.log"
ERR_LOG = "proxy.err.log"
PROCESS_UMASK = 0o077
SYSTEM_PATH = ("/usr/bin", "/bin", "/usr/sbin", "/sbin")
LAUNCHCTL = "launchctl"
LAUNCHCTL_TIMEOUT_SECONDS = 30
# launchctl's "no such service" answers: 3 (ESRCH, older macOS) and 113 ("Could not find service").
NOT_LOADED_CODES = frozenset({3, 113})
_NOT_LOADED_TEXT = ("could not find service", "no such process", "not loaded")
# `bootstrap` right after `bootout` can race launchd and fail with 5 (EIO); a short retry absorbs it.
BOOTSTRAP_RETRIES = 3
BOOTSTRAP_RETRY_DELAY_SECONDS = 0.5
STARTUP_WAIT_TRIES = 10
STARTUP_WAIT_DELAY_SECONDS = 0.5
_PRINT_FIELDS = re.compile(r"^\t(state|pid|last exit code) = (.+)$", re.M)


@dataclass(frozen=True)
class CommandResult:
    returncode: int
    stdout: str = ""
    stderr: str = ""


Runner = Callable[[Sequence[str]], CommandResult]


def run_command(argv: Sequence[str]) -> CommandResult:
    """The real runner. Never used by tests (they inject a fake)."""
    try:
        proc = subprocess.run(list(argv), capture_output=True, text=True, check=False,
                              timeout=LAUNCHCTL_TIMEOUT_SECONDS)
    except FileNotFoundError:
        return CommandResult(127, "", f"{argv[0]} not found")
    except subprocess.TimeoutExpired:
        return CommandResult(124, "", f"{argv[0]} timed out after {LAUNCHCTL_TIMEOUT_SECONDS}s")
    return CommandResult(proc.returncode, proc.stdout, proc.stderr)


@dataclass(frozen=True)
class ServiceDeps:
    """Everything that touches the machine, injectable as a whole."""

    uid: int
    launch_agents: Path
    runner: Runner
    probe: Callable[[int], bool] = tcp_reachable
    sleep: Callable[[float], None] = time.sleep
    platform: str = sys.platform


def system_deps() -> ServiceDeps:
    return ServiceDeps(uid=os.getuid(), launch_agents=Path.home() / "Library" / "LaunchAgents",
                       runner=run_command)


@dataclass(frozen=True)
class ServiceSpec:
    label: str
    home: Path
    port: int
    plist_path: Path
    program_arguments: tuple[str, ...]
    path_env: str
    out_log: Path
    err_log: Path

    @property
    def logs_dir(self) -> Path:
        return self.out_log.parent


@dataclass(frozen=True)
class Outcome:
    ok: bool
    lines: tuple[str, ...] = ()


def gate_command(executable: str | None = None) -> tuple[str, ...]:
    """How to run *this* installation of secret-gate: the console script next to the interpreter, else `-m`."""
    exe = executable or sys.executable
    script = Path(exe).with_name("secret-gate")
    if script.exists():
        return (str(script),)
    return (exe, "-m", "secret_gate.cli")


def validate_port(port: int) -> int:
    if not isinstance(port, int) or isinstance(port, bool) or not 0 < port < 65536:
        raise ValidationError(f"port must be 1-65535, got {port!r}")
    return port


def build_spec(home: Path, port: int, launch_agents: Path, executable: str | None = None) -> ServiceSpec:
    exe = executable or sys.executable
    home = home.expanduser().absolute()
    logs = home / LOGS_DIR
    return ServiceSpec(
        label=SERVICE_LABEL,
        home=home,
        port=validate_port(port),
        plist_path=launch_agents / f"{SERVICE_LABEL}.plist",
        program_arguments=(*gate_command(exe), "proxy", "--port", str(port)),
        path_env=":".join((str(Path(exe).parent), *SYSTEM_PATH)),
        out_log=logs / OUT_LOG,
        err_log=logs / ERR_LOG,
    )


def plist_dict(spec: ServiceSpec) -> dict:
    return {
        "Label": spec.label,
        "ProgramArguments": list(spec.program_arguments),
        "EnvironmentVariables": {"SECRET_GATE_HOME": str(spec.home), "PATH": spec.path_env},
        "WorkingDirectory": str(spec.home),
        "RunAtLoad": True,
        "KeepAlive": True,
        "ProcessType": "Background",
        "Umask": PROCESS_UMASK,
        "StandardOutPath": str(spec.out_log),
        "StandardErrorPath": str(spec.err_log),
    }


def render_plist(spec: ServiceSpec) -> bytes:
    return plistlib.dumps(plist_dict(spec), fmt=plistlib.FMT_XML, sort_keys=True)


def installed_port(plist_path: Path) -> int | None:
    """The `--port` an installed plist runs the proxy with, or None when there is no readable plist."""
    try:
        data = plistlib.loads(plist_path.read_bytes())
    except (OSError, ValueError, ExpatError):  # missing or not a plist: caller falls back to the default port
        return None
    args = data.get("ProgramArguments") if isinstance(data, dict) else None
    if not isinstance(args, list):
        return None
    for flag, value in zip(args, args[1:]):
        if flag in ("--port", "-p") and str(value).isdigit():
            return int(value)
    return None


# -- launchctl command lines (pure) --------------------------------------------------------------

def domain_target(uid: int) -> str:
    return f"gui/{uid}"


def service_target(uid: int, label: str = SERVICE_LABEL) -> str:
    return f"{domain_target(uid)}/{label}"


def bootout_cmd(uid: int) -> tuple[str, ...]:
    return (LAUNCHCTL, "bootout", service_target(uid))


def bootstrap_cmd(uid: int, plist_path: Path) -> tuple[str, ...]:
    return (LAUNCHCTL, "bootstrap", domain_target(uid), str(plist_path))


def print_cmd(uid: int) -> tuple[str, ...]:
    return (LAUNCHCTL, "print", service_target(uid))


def sighup_cmd(uid: int) -> tuple[str, ...]:
    return (LAUNCHCTL, "kill", "SIGHUP", service_target(uid))


def is_not_loaded(result: CommandResult) -> bool:
    text = f"{result.stdout}\n{result.stderr}".lower()
    return result.returncode in NOT_LOADED_CODES or any(t in text for t in _NOT_LOADED_TEXT)


def parse_print(output: str) -> dict[str, str]:
    """Top-level `state`, `pid`, `last exit code` of `launchctl print` (first occurrence of each)."""
    fields: dict[str, str] = {}
    for name, value in _PRINT_FIELDS.findall(output):
        fields.setdefault(name, value.strip())
    return fields


def _shown(cmd: Sequence[str]) -> str:
    return "$ " + shlex.join(cmd)


def _failure(cmd: Sequence[str], result: CommandResult) -> str:
    reason = (result.stderr or result.stdout).strip() or "no output"
    return f"{shlex.join(cmd)} failed ({result.returncode}): {reason}"


# -- files ---------------------------------------------------------------------------------------

def atomic_write(path: Path, data: bytes, mode: int) -> None:
    """Write via a temp file in the same directory and rename: readers never see half a file."""
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def prepare_logs(spec: ServiceSpec) -> None:
    spec.logs_dir.mkdir(mode=LOGS_DIR_MODE, parents=True, exist_ok=True)
    spec.logs_dir.chmod(LOGS_DIR_MODE)
    for log in (spec.out_log, spec.err_log):
        os.close(os.open(log, os.O_WRONLY | os.O_CREAT | os.O_APPEND, LOG_FILE_MODE))
        log.chmod(LOG_FILE_MODE)


def _describe(spec: ServiceSpec, uid: int) -> tuple[str, ...]:
    return (
        f"plist: {spec.plist_path} (mode {PLIST_MODE:o}; paths and a port only, no secret)",
        f"runs: {shlex.join(spec.program_arguments)} as uid {uid} ({domain_target(uid)}), "
        f"listening on {LOOPBACK}:{spec.port} only",
        f"env: SECRET_GATE_HOME={spec.home}, PATH={spec.path_env} (no proxy variables)",
        f"logs: {spec.out_log}, {spec.err_log} (dir {LOGS_DIR_MODE:o}, files {LOG_FILE_MODE:o})",
    )


# -- verbs ---------------------------------------------------------------------------------------

def install(spec: ServiceSpec, deps: ServiceDeps, *, dry_run: bool = False) -> Outcome:
    load_private_key(spec.home)  # no keypair: fail with keystore's clear message before touching anything
    if dry_run:
        return Outcome(True, (
            "dry run: nothing is written or loaded",
            *_describe(spec, deps.uid),
            f"would write {spec.plist_path}:",
            render_plist(spec).decode().rstrip(),
            f"would create {spec.logs_dir} ({LOGS_DIR_MODE:o})",
            "would run: " + shlex.join(bootout_cmd(deps.uid)) + "   (not-loaded is fine)",
            "would run: " + shlex.join(bootstrap_cmd(deps.uid, spec.plist_path)),
        ))
    prepare_logs(spec)
    deps.launch_agents.mkdir(parents=True, exist_ok=True)
    atomic_write(spec.plist_path, render_plist(spec), PLIST_MODE)
    lines = [*_describe(spec, deps.uid), _shown(bootout_cmd(deps.uid))]
    out = deps.runner(bootout_cmd(deps.uid))
    if out.returncode != 0 and not is_not_loaded(out):
        lines.append("warning: " + _failure(bootout_cmd(deps.uid), out))
    port_busy = _port_still_busy(spec, deps, stopped_ours=out.returncode == 0)
    if port_busy:
        lines.append(f"warning: {LOOPBACK}:{spec.port} is already in use (a proxy started by hand?). The service "
                     "cannot bind until that process exits; this command does not stop it.")
    ok, bootstrap_lines = _bootstrap(spec, deps)
    lines.extend(bootstrap_lines)
    if not ok:
        lines.append(f"the plist stays at {spec.plist_path}; fix the cause and rerun, or `secret-gate service uninstall`")
        return Outcome(False, tuple(lines))
    if not port_busy:
        lines.append(_wait_for_port(spec, deps))
    return Outcome(True, tuple(lines))


def _bootstrap(spec: ServiceSpec, deps: ServiceDeps) -> tuple[bool, list[str]]:
    cmd = bootstrap_cmd(deps.uid, spec.plist_path)
    lines = [_shown(cmd)]
    for attempt in range(BOOTSTRAP_RETRIES):
        result = deps.runner(cmd)
        if result.returncode == 0:
            lines.append(f"loaded {spec.label}")
            return True, lines
        if attempt + 1 < BOOTSTRAP_RETRIES:
            deps.sleep(BOOTSTRAP_RETRY_DELAY_SECONDS)
    lines.append("error: " + _failure(cmd, result))
    return False, lines


def _port_still_busy(spec: ServiceSpec, deps: ServiceDeps, *, stopped_ours: bool) -> bool:
    """After stopping our own instance, give its port a moment to close before blaming someone else."""
    for _ in range(STARTUP_WAIT_TRIES if stopped_ours else 1):
        if not deps.probe(spec.port):
            return False
        if stopped_ours:
            deps.sleep(STARTUP_WAIT_DELAY_SECONDS)
    return True


def _wait_for_port(spec: ServiceSpec, deps: ServiceDeps) -> str:
    for _ in range(STARTUP_WAIT_TRIES):
        if deps.probe(spec.port):
            return f"proxy is up on {LOOPBACK}:{spec.port}"
        deps.sleep(STARTUP_WAIT_DELAY_SECONDS)
    return (f"warning: {LOOPBACK}:{spec.port} not reachable yet; see `secret-gate service status` "
            f"and {spec.err_log}")


def uninstall(spec: ServiceSpec, deps: ServiceDeps, *, dry_run: bool = False) -> Outcome:
    cmd = bootout_cmd(deps.uid)
    if dry_run:
        return Outcome(True, ("dry run: nothing is stopped or removed", "would run: " + shlex.join(cmd),
                              f"would remove {spec.plist_path}", f"logs would stay in {spec.logs_dir}"))
    lines = [_shown(cmd)]
    result = deps.runner(cmd)
    if result.returncode == 0:
        lines.append(f"stopped {spec.label}")
    elif is_not_loaded(result):
        lines.append(f"{spec.label} was not loaded")
    else:
        lines.append("error: " + _failure(cmd, result) + f"; {spec.plist_path} kept")
        return Outcome(False, tuple(lines))
    if spec.plist_path.exists():
        spec.plist_path.unlink()
        lines.append(f"removed {spec.plist_path}")
    else:
        lines.append(f"no plist at {spec.plist_path}")
    lines.append(f"logs kept in {spec.logs_dir}")
    return Outcome(True, tuple(lines))


def status(spec: ServiceSpec, deps: ServiceDeps) -> Outcome:
    result = deps.runner(print_cmd(deps.uid))
    loaded = result.returncode == 0
    fields = parse_print(result.stdout) if loaded else {}
    detail = ", ".join(f"{k} = {v}" for k, v in fields.items())
    reachable = deps.probe(spec.port)
    healthy = loaded and reachable
    launchd = ("loaded" + (f" ({detail})" if detail else "")) if loaded else "not loaded"
    return Outcome(healthy, (
        f"service: {spec.label} ({service_target(deps.uid)})",
        f"plist: {spec.plist_path} ({'present' if spec.plist_path.exists() else 'missing'})",
        f"launchd: {launchd}",
        f"proxy: {LOOPBACK}:{spec.port} " + ("reachable" if reachable else "NOT reachable"),
        f"logs: {spec.out_log}, {spec.err_log}",
        "healthy" if healthy else "NOT healthy",
    ))


def reload(spec: ServiceSpec, deps: ServiceDeps, *, dry_run: bool = False) -> Outcome:
    cmd = sighup_cmd(deps.uid)
    target = spec.home / UPSTREAM_INSECURE_FILE
    if dry_run:
        return Outcome(True, ("dry run: no signal is sent", "would run: " + shlex.join(cmd)))
    result = deps.runner(cmd)
    if result.returncode == 0:
        return Outcome(True, (_shown(cmd), f"sent SIGHUP: the proxy re-reads {target}; the result is in {spec.err_log}"))
    if is_not_loaded(result):
        return Outcome(False, (_shown(cmd), f"{spec.label} is not loaded; nothing to reload"))
    return Outcome(False, (_shown(cmd), "error: " + _failure(cmd, result)))


# -- CLI -----------------------------------------------------------------------------------------

def port_arg(text: str) -> int:
    """argparse `type=` for a port option."""
    try:
        return validate_port(int(text))
    except (ValueError, ValidationError):
        raise argparse.ArgumentTypeError(f"invalid port {text!r} (1-65535)") from None


def _cmd_service(args: argparse.Namespace) -> int:
    deps = system_deps()
    dry_run = getattr(args, "dry_run", False)
    if deps.platform != "darwin" and not dry_run:
        raise ValidationError("launchd services are macOS-only (use --dry-run to see the plist)")
    agents_plist = deps.launch_agents / f"{SERVICE_LABEL}.plist"
    port = getattr(args, "port", None) or installed_port(agents_plist) or DEFAULT_PROXY_PORT
    spec = build_spec(gate_home(), port, deps.launch_agents)
    verbs = {"install": lambda: install(spec, deps, dry_run=dry_run),
             "uninstall": lambda: uninstall(spec, deps, dry_run=dry_run),
             "status": lambda: status(spec, deps),
             "reload": lambda: reload(spec, deps, dry_run=dry_run)}
    outcome = verbs[args.service_cmd]()
    for line in outcome.lines:
        print(line)
    return 0 if outcome.ok else 1


def add_service_parser(sub: argparse._SubParsersAction) -> None:
    s = sub.add_parser("service", help="run the proxy as a launchd LaunchAgent (install|uninstall|status|reload)")
    ss = s.add_subparsers(dest="service_cmd", required=True)
    i = ss.add_parser("install", help="write the LaunchAgent plist and load it")
    i.add_argument("--port", type=port_arg, help=f"proxy port (default: the installed one, else {DEFAULT_PROXY_PORT})")
    i.add_argument("--dry-run", action="store_true", help="print the plist and commands, change nothing")
    u = ss.add_parser("uninstall", help="stop the service and remove the plist (logs stay)")
    u.add_argument("--dry-run", action="store_true", help="print the commands, change nothing")
    st = ss.add_parser("status", help="loaded? reachable? exit 1 when not healthy")
    st.add_argument("--port", type=port_arg, help="port to check (default: the installed one)")
    r = ss.add_parser("reload", help=f"SIGHUP the proxy: re-read {UPSTREAM_INSECURE_FILE}")
    r.add_argument("--dry-run", action="store_true", help="print the command, send nothing")
    s.set_defaults(fn=_cmd_service)
