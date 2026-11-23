"""`secret-gate system` on Windows (gate-simple-v0 §5, Windows column): the Windows service `AgentSwitchGate` under the
virtual account `NT SERVICE\\AgentSwitchGate`, ACLs instead of chown/chmod, a named pipe instead of gate.sock.

The platform is injected (`SystemLayout(prefix, WINDOWS)`, `--platform windows`), so the plans, the CLI, the runtime
copy, the service host's supervisor, the ACL decision and the pipe naming all run on macOS and Linux too. What needs
Windows itself (pywin32: setting ACLs, the pipe, the service control manager) is in test_windows_native.py and in the
Windows CI job's install smoke (.github/workflows/ci.yml).
"""

from __future__ import annotations

import json
import os
import subprocess
import threading
from pathlib import Path, PureWindowsPath

import pytest

from secret_gate import fsacl
from secret_gate.errors import GateError
from secret_gate.fsacl import (
    ADMINISTRATORS_SID,
    GATE_SERVICE_SID,
    SYSTEM_SID,
    TRUSTED_INSTALLER_SID,
    USERS_SID,
    Ace,
    acl_problem,
    service_sid,
)
from secret_gate.keyring import keypair_info
from secret_gate.platform import LINUX, MACOS, WINDOWS, native
from secret_gate.platform.windows import GATE_GRANTS, ROOT_GRANTS, SERVICE_ACCOUNT, Windows, host_command
from secret_gate.service import CommandResult
from secret_gate.service_paths import ServiceConfig, SystemLayout, read_service_config, service_refusal
from secret_gate.system_exec import (
    SystemDeps,
    execute,
    local_status,
    stage_runtime_windows,
    windows_exists,
    windows_no_service,
    windows_not_running,
)
from secret_gate.system_ops import (
    WINDOWS_EXISTS_OK,
    WINDOWS_NO_SERVICE_OK,
    WINDOWS_NOT_RUNNING_OK,
    CreateKey,
    MakeDir,
    Publish,
    RemovePath,
    Run,
    SetAcl,
    WaitForService,
    WriteFile,
)
from secret_gate.system_plan import (
    InstallFacts,
    InstallOptions,
    install_plan,
    render,
    rotate_key_plan,
    uninstall_plan,
    update_plan,
)
from secret_gate.win_service import Supervisor, child_commands, child_env
from secret_gate.winpipe import SERVICE_PIPE, expected_server_sid, pipe_name

OWNER = "S-1-5-21-1004336348-1177238915-682003330-1001"
SC = "C:\\Windows\\System32\\sc.exe"
NET = "C:\\Windows\\System32\\net.exe"


def _ops(plan):
    return [op for step in plan.steps for op in step.ops]


def _runs(plan):
    return [op for op in _ops(plan) if isinstance(op, Run)]


@pytest.fixture(autouse=True)
def no_real_commands(monkeypatch):
    def boom(*_a, **_k):
        raise AssertionError("a test reached a real privileged command")
    monkeypatch.setattr("secret_gate.system_cli.run_command", boom)
    monkeypatch.setattr("secret_gate.service.run_command", boom)
    monkeypatch.setattr("secret_gate.system_exec.CA_KEY_SIZE", 1024)
    monkeypatch.setattr("secret_gate.system_exec.fsacl.set_acl", boom)


# -- layout and accounts ---------------------------------------------------------------------------

def test_windows_layout_moves_under_the_prefix_without_its_drive():
    layout = SystemLayout(Path("/p"), WINDOWS)
    assert layout.root == Path("/p/ProgramData/AgentSwitch")
    assert layout.gate == Path("/p/ProgramData/AgentSwitch/gate")
    assert layout.public == Path("/p/ProgramData/AgentSwitch/gate-public")
    assert layout.config == Path("/p/ProgramData/AgentSwitch/gate-service.json")
    assert layout.runtime == Path("/p/Program Files/AgentSwitch/gate-runtime")
    assert layout.runtime_staging == Path("/p/Program Files/AgentSwitch/gate-runtime.new")
    assert layout.socket == Path("/p/ProgramData/AgentSwitch/gate-public/gate.sock")
    assert WINDOWS.system_root == PureWindowsPath("C:\\ProgramData\\AgentSwitch")      # off Windows: the defaults
    assert native("win32") is WINDOWS and native("linux") is LINUX and native("darwin") is MACOS
    assert WINDOWS.labels == ("AgentSwitchGate",)                                      # one service, one account
    assert "管理员身份" in service_refusal(WINDOWS)


def test_the_service_account_is_the_virtual_account_of_the_service():
    assert service_sid("TrustedInstaller") == TRUSTED_INSTALLER_SID                    # the textbook example
    assert GATE_SERVICE_SID == service_sid("AgentSwitchGate") == service_sid("agentswitchgate")
    assert GATE_SERVICE_SID.startswith("S-1-5-80-") and SERVICE_ACCOUNT == "NT SERVICE\\AgentSwitchGate"


# -- the plan ----------------------------------------------------------------------------------------

LAYOUT = SystemLayout(Path("/tmp/sg-windows"), WINDOWS)
RUNTIME = Path("/tmp/runtime")
OPTIONS = InstallOptions(owner_uid=None, owner_sid=OWNER, port=8080, runtime=RUNTIME)
FACTS = InstallFacts(account=WINDOWS.gather_account(None, simulate=True), runtime_version="0.1.0+t",
                     installed_at="2026-11-23T00:00:00Z")


def test_install_uses_acls_sc_and_net_never_chown():
    plan = install_plan(LAYOUT, OPTIONS, FACTS)
    assert plan.steps[0].ops == () and SERVICE_ACCOUNT in plan.steps[0].title and GATE_SERVICE_SID in plan.steps[0].title
    for run in _runs(plan):
        assert run.argv[0] in (SC, NET), run.argv                       # absolute paths below the Windows directory
    assert not any("chown" in r.argv[0] or "chmod" in r.argv[0] for r in _runs(plan))


def test_the_gate_home_is_closed_before_anything_is_written_into_it():
    ops = _ops(install_plan(LAYOUT, OPTIONS, FACTS))
    made = ops.index(MakeDir(LAYOUT.gate, 0o700))
    assert ops[made + 1] == SetAcl(LAYOUT.gate, GATE_GRANTS, ADMINISTRATORS_SID, tree=True)
    first_write = min(i for i, op in enumerate(ops) if isinstance(op, (CreateKey, WriteFile, Publish)))
    assert made + 1 < first_write
    assert dict(GATE_GRANTS) == {SYSTEM_SID: "full", ADMINISTRATORS_SID: "full", GATE_SERVICE_SID: "full"}
    acls = {op.path: op for op in ops if isinstance(op, SetAcl)}
    assert USERS_SID not in dict(acls[LAYOUT.gate].grants) and OWNER not in dict(acls[LAYOUT.gate].grants)
    assert dict(acls[LAYOUT.public].grants) == {SYSTEM_SID: "full", ADMINISTRATORS_SID: "full",
                                                GATE_SERVICE_SID: "modify", OWNER: "read"}   # not Users: the owner only
    assert acls[LAYOUT.root].grants == ROOT_GRANTS and dict(ROOT_GRANTS)[USERS_SID] == "read"
    assert acls[LAYOUT.runtime.parent].grants == ROOT_GRANTS                  # gate-runtime inherits admin-only write
    assert all(op.owner == ADMINISTRATORS_SID for op in acls.values())


def test_the_service_is_registered_under_its_virtual_account_running_the_root_owned_copy():
    runs = _runs(install_plan(LAYOUT, OPTIONS, FACTS))
    create = next(r for r in runs if r.argv[1] == "create")
    settings = ("binPath=", f'"{LAYOUT.runtime / "python" / "python.exe"}" -I -X utf8 -m secret_gate.win_service',
                "obj=", "NT SERVICE\\AgentSwitchGate", "start=", "auto", "DisplayName=", "AgentSwitch Gate")
    assert create.argv == (SC, "create", "AgentSwitchGate", *settings) and create.tolerate == WINDOWS_EXISTS_OK
    assert host_command(LAYOUT) == settings[1]
    assert next(r for r in runs if r.argv[1] == "config").argv == (SC, "config", "AgentSwitchGate", *settings)
    failure = next(r for r in runs if r.argv[1] == "failure")
    assert failure.argv[-2:] == ("actions=", "restart/2000/restart/2000/restart/2000")
    assert [r.argv for r in runs if r.argv[0] == NET] == [(NET, "stop", "AgentSwitchGate"), (NET, "start", "AgentSwitchGate")]
    assert next(r for r in runs if r.argv[1] == "stop").tolerate == WINDOWS_NOT_RUNNING_OK


def test_gate_service_json_names_the_owner_by_sid():
    config = next(op for op in _ops(install_plan(LAYOUT, OPTIONS, FACTS)) if isinstance(op, WriteFile)
                  and op.path == LAYOUT.config)
    assert json.loads(config.data) == {"ownerSid": OWNER, "proxyPort": 8080, "runtimeVersion": "0.1.0+t",
                                       "installedAt": "2026-11-23T00:00:00Z"}


def test_rotate_update_uninstall_plans():
    ops = _ops(rotate_key_plan(LAYOUT, OWNER))
    assert ops[0] == SetAcl(LAYOUT.gate, GATE_GRANTS, ADMINISTRATORS_SID, tree=True)   # the admin's way in, first
    assert ops[1] == CreateKey(LAYOUT.gate, replace=True)
    assert not any(isinstance(op, Run) for op in ops)                     # no SIGHUP: the proxy watches key.priv
    assert isinstance(ops[-1], WaitForService)
    assert any(isinstance(op, SetAcl) and op.path == LAYOUT.public and (OWNER, "read") in op.grants for op in ops)
    config = ServiceConfig(owner_uid=None, owner_sid=OWNER, proxy_port=8181, runtime_version="v2", installed_at="t")
    update = _runs(update_plan(LAYOUT, RUNTIME, config))
    assert [r.argv[1] for r in update] == ["create", "config", "description", "failure", "stop", "start"]
    uninstall = uninstall_plan(LAYOUT, delete_keys=True)
    runs = _runs(uninstall)
    assert runs[0].argv == (NET, "stop", "AgentSwitchGate")
    assert runs[1].argv == (SC, "delete", "AgentSwitchGate") and runs[1].tolerate == WINDOWS_NO_SERVICE_OK
    assert uninstall.steps[1].title == "删除 Windows 服务"
    last = uninstall.steps[-1].ops
    assert isinstance(last[0], SetAcl) and last[-1] == RemovePath(LAYOUT.gate)
    text = "\n".join(render(install_plan(LAYOUT, OPTIONS, FACTS)))
    assert "acl " in text and "sc.exe create AgentSwitchGate" in text.replace("'", "")


def test_sc_and_net_answers_that_count_as_done():
    assert windows_exists(CommandResult(1073, "[SC] CreateService FAILED 1073:\n\nThe specified service already exists."))
    assert not windows_exists(CommandResult(5, "[SC] OpenSCManager FAILED 5:\n\nAccess is denied."))
    assert windows_not_running(CommandResult(2, "", "The AgentSwitch Gate service is not started.\n\n"
                                                    "More help is available by typing NET HELPMSG 3521."))
    assert windows_not_running(CommandResult(2, "", "The service name is invalid.\n\nNET HELPMSG 2185."))
    assert not windows_not_running(CommandResult(2, "", "System error 5 has occurred.\n\nAccess is denied."))
    assert windows_no_service(CommandResult(1060, "[SC] OpenService FAILED 1060:"))
    assert not windows_no_service(CommandResult(1072, "[SC] DeleteService FAILED 1072: marked for deletion"))


# -- carried out in a temporary root (--root: commands and ACLs listed, files real) -----------------------

def windows_runtime(path: Path, built: str = "2026-09-27T00:00:00Z") -> Path:
    """A Windows runtime: python\\ is a complete Python (python.exe, Lib\\site-packages) with secret-gate in it."""
    (path / "python" / "Lib" / "site-packages" / "secret_gate").mkdir(parents=True)
    (path / "python" / "python.exe").write_bytes(b"MZ")
    (path / "python" / "Lib" / "site-packages" / "secret_gate" / "__init__.py").write_text("")
    (path / "secret-gate").mkdir()
    (path / "secret-gate" / "AGENTS.md").write_text("guidance\n")
    (path / "VERSIONS").write_text(f"secret-gate=0.1.0\nbuilt={built}\n")
    return path


class World:
    def __init__(self, tmp: Path) -> None:
        self.prefix = tmp / "prefix"
        self.prefix.mkdir()
        self.layout = SystemLayout(self.prefix, WINDOWS)
        self.runtime = windows_runtime(tmp / "Users" / "u" / "runtime")

    def deps(self) -> SystemDeps:
        return SystemDeps(runner=lambda argv: CommandResult(0), status=local_status(self.layout.gate),
                          sleep=lambda _s: None, simulate=True)

    def install(self):
        options = InstallOptions(owner_uid=None, owner_sid=OWNER, port=8080, runtime=self.runtime)
        facts = InstallFacts(account=WINDOWS.gather_account(None, simulate=True),
                             runtime_version="0.1.0+2026-09-27T00:00:00Z", installed_at="t")
        return execute(install_plan(self.layout, options, facts), self.deps())


@pytest.fixture
def world(tmp_path) -> World:
    return World(tmp_path)


def test_install_lays_out_the_service(world):
    outcome = world.install()
    assert outcome.ok, outcome.lines
    layout = world.layout
    assert sorted(p.name for p in layout.runtime.iterdir()) == ["VERSIONS", "python", "secret-gate"]  # no sh wrapper
    assert (layout.runtime / "python" / "python.exe").read_bytes() == b"MZ"
    assert read_service_config(layout.config) == ServiceConfig(None, 8080, "0.1.0+2026-09-27T00:00:00Z", "t",
                                                               owner_sid=OWNER)
    assert json.loads((layout.public / "keys.json").read_text())[0]["publicKey"] == keypair_info(layout.gate).public
    listed = "\n".join(outcome.lines)
    assert f"acl {layout.gate}" in listed.replace("'", "") and "（--root：未执行）" in listed
    assert "sc.exe create AgentSwitchGate" in listed.replace("'", "")


def test_reinstall_keeps_the_key_rotate_replaces_it_uninstall_keeps_it(world, tmp_path):
    assert world.install().ok
    key = keypair_info(world.layout.gate).public
    assert world.install().ok and keypair_info(world.layout.gate).public == key
    assert execute(rotate_key_plan(world.layout, OWNER), world.deps()).ok
    assert keypair_info(world.layout.gate).public != key
    config = read_service_config(world.layout.config)
    assert execute(update_plan(world.layout, windows_runtime(tmp_path / "rt2"), config), world.deps()).ok
    assert execute(uninstall_plan(world.layout, delete_keys=False), world.deps()).ok
    assert world.layout.gate.is_dir() and not world.layout.runtime.exists() and not world.layout.config.exists()


def test_the_runtime_copy_follows_nothing(world, tmp_path):
    world.layout.runtime.parent.mkdir(parents=True)
    secret = tmp_path / "admin-only"
    secret.mkdir()
    (secret / "key.priv").write_text("PRIVATE")
    lib = world.runtime / "python" / "Lib"
    (lib / "planted.txt").symlink_to(secret / "key.priv")
    with pytest.raises(GateError, match="符号链接或联接点"):
        stage_runtime_windows(world.runtime, world.layout)
    (lib / "planted.txt").unlink()
    os.link(secret / "key.priv", lib / "linked.txt")                     # a hard link to a file elsewhere
    with pytest.raises(GateError, match="多个硬链接"):
        stage_runtime_windows(world.runtime, world.layout)
    (lib / "linked.txt").unlink()
    (world.runtime / "python" / "python.exe").unlink()
    with pytest.raises(GateError, match="python.exe"):
        stage_runtime_windows(world.runtime, world.layout)
    (world.runtime / "python").rename(world.runtime / "python.real")
    (world.runtime / "python").symlink_to(world.runtime / "python.real")
    with pytest.raises(GateError, match="python"):
        stage_runtime_windows(world.runtime, world.layout)
    assert "PRIVATE" not in "".join(p.read_text(errors="ignore") for p in world.layout.runtime_staging.rglob("*")
                                    if p.is_file())


def test_a_root_someone_else_made_is_refused(tmp_path):
    layout = SystemLayout(tmp_path, WINDOWS)
    platform = Windows()
    platform.preflight(layout, simulate=False, owner_of=lambda _p: OWNER)            # not there yet: fine
    layout.root.mkdir(parents=True)
    with pytest.raises(GateError, match="不是管理员创建的"):
        platform.preflight(layout, simulate=False, owner_of=lambda _p: OWNER)
    for owner in (ADMINISTRATORS_SID, SYSTEM_SID, TRUSTED_INSTALLER_SID):
        platform.preflight(layout, simulate=False, owner_of=lambda _p, o=owner: o)
    platform.preflight(layout, simulate=True, owner_of=lambda _p: OWNER)


# -- the CLI -------------------------------------------------------------------------------------------

def _main(argv: list[str]) -> int:
    from secret_gate.cli import main

    return main(argv)


def test_cli_with_platform_windows(world, capsys):
    root = ["--root", str(world.prefix), "--platform", "windows"]
    install = ["system", "install", "--owner-sid", OWNER, "--runtime", str(world.runtime), *root]
    assert _main([*install, "--dry-run"]) == 0
    out = capsys.readouterr().out
    assert "sc.exe create AgentSwitchGate" in out.replace("'", "") and "launchctl" not in out and "chown" not in out
    assert list(world.prefix.iterdir()) == []
    assert _main(install) == 0
    assert "net.exe start AgentSwitchGate（--root：未执行）" in capsys.readouterr().out.replace("'", "")
    assert _main(["system", "status", "--json", *root]) == 0
    report = json.loads(capsys.readouterr().out)
    assert report["installed"] and report["ownerSid"] == OWNER and report["ownerUid"] is None
    assert _main(["system", "rotate-key", *root]) == 0
    assert "SIGHUP" not in capsys.readouterr().out
    assert _main(["system", "uninstall", "--delete-keys", *root]) == 0
    assert not world.layout.config.exists() and not world.layout.gate.exists()


@pytest.mark.parametrize("argv,message", [
    (["--platform", "windows"], "--owner-sid"),
    (["--platform", "windows", "--owner-sid", "S-1-5-18"], "登录用户的 SID"),
    (["--platform", "windows", "--owner-sid", "not a sid"], "登录用户的 SID"),
    (["--platform", "linux", "--owner-uid", "1000", "--owner-sid", OWNER], "只用于 Windows"),
])
def test_cli_owner_sid_is_checked(world, capsys, argv, message):
    assert _main(["system", "install", "--runtime", str(world.runtime), "--root", str(world.prefix), *argv]) == 2
    assert message in capsys.readouterr().err


def test_gate_service_json_with_a_sid(tmp_path):
    config = ServiceConfig(owner_uid=None, owner_sid=OWNER, proxy_port=8080, runtime_version="v", installed_at="t")
    assert ServiceConfig.from_json(config.to_json()) == config and "ownerUid" not in config.to_json()
    for bad in ({"ownerSid": "S-1-5-18", "proxyPort": 1, "runtimeVersion": "v", "installedAt": "t"},
                {"ownerSid": OWNER, "ownerUid": 1, "proxyPort": 1, "runtimeVersion": "v", "installedAt": "t"},
                {"ownerSid": 501, "proxyPort": 1, "runtimeVersion": "v", "installedAt": "t"}):
        with pytest.raises(GateError):
            ServiceConfig.from_json(bad)
    entra = "S-1-12-1-1234567890-1234567890-1234567890-1234567890"
    assert ServiceConfig.from_json({**config.to_json(), "ownerSid": entra}).owner_sid == entra


# -- the ACL rule, the pipe's name, the service host ------------------------------------------------------

def test_acl_problem_names_whoever_should_not_be_there():
    trusted = fsacl.trusted_sids(OWNER)
    mine = [Ace("allow", OWNER, fsacl.FILE_ALL_ACCESS), Ace("allow", SYSTEM_SID, fsacl.FILE_ALL_ACCESS),
            Ace("allow", ADMINISTRATORS_SID, fsacl.FILE_ALL_ACCESS)]
    assert acl_problem(mine, trusted) is None and acl_problem(mine, trusted, write=True) is None
    assert acl_problem([Ace("allow", GATE_SERVICE_SID, fsacl.FILE_ALL_ACCESS)], trusted) is None
    assert acl_problem(None, trusted) == "no access control list (everyone has access)"
    assert acl_problem([*mine, Ace("allow", USERS_SID, fsacl.FILE_READ_EXECUTE)], trusted) == f"readable by {USERS_SID}"
    assert acl_problem([Ace("allow", "S-1-1-0", fsacl.WRITE_DAC)], trusted) == "readable by S-1-1-0"  # can grant itself
    assert acl_problem([Ace("allow", USERS_SID, fsacl.FILE_READ_EXECUTE)], trusted, write=True) is None
    assert acl_problem([Ace("allow", USERS_SID, fsacl.FILE_APPEND_DATA)], trusted, write=True) == f"writable by {USERS_SID}"
    assert acl_problem([Ace("deny", USERS_SID, fsacl.FILE_ALL_ACCESS)], trusted) is None
    assert acl_problem([Ace("allow", "S-1-3-0", fsacl.FILE_ALL_ACCESS, inherit_only=True)], trusted) is None
    owner_rights = [Ace("allow", fsacl.OWNER_RIGHTS_SID, fsacl.FILE_ALL_ACCESS)]     # whoever owns the object
    assert acl_problem(owner_rights, trusted, owner=OWNER) is None
    assert acl_problem(owner_rights, trusted, owner=USERS_SID, write=True) == f"writable by {fsacl.OWNER_RIGHTS_SID}"
    assert acl_problem(owner_rights, trusted) == f"readable by {fsacl.OWNER_RIGHTS_SID}"     # owner unknown


def test_the_pipe_of_a_path():
    service_socket = Path("C:/ProgramData/AgentSwitch/gate-public/gate.sock")
    assert pipe_name(service_socket, service_socket) == SERVICE_PIPE == "\\\\.\\pipe\\agentswitch-gate"
    other = pipe_name(Path("/tmp/sg-x/pub/gate.sock"), service_socket)
    assert other.startswith(SERVICE_PIPE + "-") and len(other) == len(SERVICE_PIPE) + 17
    assert other == pipe_name(Path("/TMP/sg-x/pub/gate.sock"), service_socket)   # Windows paths ignore case
    assert other != pipe_name(Path("/tmp/sg-y/pub/gate.sock"), service_socket)


def test_whom_the_client_expects_at_the_other_end(tmp_path):
    socket_path = tmp_path / "gate-public" / "gate.sock"
    assert expected_server_sid(socket_path, own_sid=lambda: OWNER) == OWNER      # no service: our own gate (tests)
    (tmp_path / "gate-service.json").write_text("{}")
    assert expected_server_sid(socket_path, own_sid=lambda: OWNER) == GATE_SERVICE_SID


def test_service_host_children_and_their_environment():
    python = Path("C:/Program Files/AgentSwitch/gate-runtime/python/python.exe")
    gate, public = Path("C:/ProgramData/AgentSwitch/gate"), Path("C:/ProgramData/AgentSwitch/gate-public")
    commands = child_commands(python, 8080, gate / "mitmproxy")
    assert commands == {"rpc": [str(python), "-I", "-X", "utf8", "-m", "secret_gate.cli", "rpc"],
                        "proxy": [str(python), "-I", "-X", "utf8", "-m", "secret_gate.cli", "proxy", "--port", "8080",
                                  "--confdir", str(gate / "mitmproxy")]}
    base = {"SystemRoot": "C:\\Windows", "PATH": "C:\\evil", "HTTPS_PROXY": "http://x", "PYTHONPATH": "C:\\evil",
            "USERPROFILE": "C:\\Users\\someone", "SystemDrive": "C:"}
    env = child_env(gate, public, python, "C:\\Windows", base)
    assert env["SECRET_GATE_HOME"] == env["HOME"] == env["USERPROFILE"] == str(gate)
    assert env["SECRET_GATE_PUBLIC"] == str(public) and env["TEMP"] == str(gate / "tmp")
    assert "HTTPS_PROXY" not in env and "PYTHONPATH" not in env and "evil" not in env["PATH"]
    assert env["PATH"].split(";")[0] == str(python.parent) and env["SystemDrive"] == "C:"


class FakeProcess:
    pids = iter(range(100, 200))

    def __init__(self, argv, **kwargs) -> None:
        self.argv, self.kwargs, self.pid = argv, kwargs, next(self.pids)
        self.code: int | None = None
        self.terminated = False

    def poll(self):
        return self.code

    def terminate(self):
        self.terminated, self.code = True, 1

    def wait(self, timeout=None):
        if self.code is None:
            raise subprocess.TimeoutExpired(self.argv, timeout)
        return self.code

    def kill(self):
        self.code = -9


def test_supervisor_starts_both_restarts_what_exits_and_stops_them(tmp_path):
    now = [0.0]
    started: list[FakeProcess] = []

    def start(argv, **kwargs):
        process = FakeProcess(argv, **kwargs)
        started.append(process)
        return process

    supervisor = Supervisor({"rpc": ["py", "rpc"], "proxy": ["py", "proxy"]}, {"SECRET_GATE_HOME": "g"},
                            tmp_path / "logs", start_process=start, clock=lambda: now[0], log=lambda _line: None)
    supervisor.tick()
    assert [p.argv for p in started] == [["py", "rpc"], ["py", "proxy"]]
    assert started[0].kwargs["env"] == {"SECRET_GATE_HOME": "g"} and started[0].kwargs["stdin"] == subprocess.DEVNULL
    assert (tmp_path / "logs" / "rpc.log").exists() and (tmp_path / "logs" / "proxy.log").exists()
    started[1].code = 3                                                    # the proxy died
    supervisor.tick()
    assert len(started) == 2                                               # not at once: after the delay
    now[0] += 2.5
    supervisor.tick()
    assert len(started) == 3 and started[2].argv == ["py", "proxy"]
    stopping = threading.Event()
    stopping.set()
    supervisor.run(stopping)
    assert started[0].terminated and started[2].terminated
    assert all(child.process is None for child in supervisor.children)


def test_supervisor_retries_a_child_that_cannot_start(tmp_path):
    now = [0.0]
    attempts: list[list[str]] = []

    def start(argv, **_kwargs):
        attempts.append(argv)
        raise FileNotFoundError(2, "not found")

    supervisor = Supervisor({"rpc": ["py", "rpc"]}, {}, tmp_path / "logs", start_process=start,
                            clock=lambda: now[0], log=lambda _line: None)
    supervisor.tick()
    supervisor.tick()
    assert len(attempts) == 1
    now[0] += 3
    supervisor.tick()
    assert len(attempts) == 2


# -- the user-mode key on Windows (the ACL glue itself runs in test_windows_native.py) --------------------

def test_on_windows_the_home_gets_an_acl_and_a_readable_key_is_refused(tmp_path, monkeypatch):
    from secret_gate.errors import KeyStoreError
    from secret_gate.keyring import create_keypair
    from secret_gate.keystore import load_private_key

    restricted: list[Path] = []
    monkeypatch.setattr(fsacl, "IS_WINDOWS", True)
    monkeypatch.setattr(fsacl, "restrict_to_current_user", restricted.append)
    monkeypatch.setattr(fsacl, "private_problem", lambda _p: None)
    home = tmp_path / "a" / "home"
    create_keypair(home)
    assert restricted == [tmp_path / "a", home]                           # every directory made here, nothing else
    assert len(load_private_key(home)) == 32
    monkeypatch.setattr(fsacl, "private_problem", lambda _p: f"readable by {USERS_SID}")
    with pytest.raises(KeyStoreError, match="is not private"):
        load_private_key(home)
