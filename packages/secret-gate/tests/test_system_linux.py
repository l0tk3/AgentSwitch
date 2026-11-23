"""`secret-gate system` on Linux (gate-simple-v0 §5, Linux column): the system user `agentswitch-gate`, two systemd
units, gate-public/ opened to the login user's group only, SO_PEERCRED.

The platform is injected (`SystemLayout(prefix, LINUX)`, `--platform linux`), so everything but the real peer check runs
on macOS too. Privileged commands go to a recording fake runner; nothing touches systemd or /etc.
"""

from __future__ import annotations

import json
import os
import socket
import stat
import sys
from dataclasses import replace
from datetime import datetime
from pathlib import Path
from types import SimpleNamespace

import pytest

from secret_gate import system_cli
from secret_gate.errors import GateError
from secret_gate.keyring import keypair_info
from secret_gate.platform import LINUX, MACOS, native
from secret_gate.platform.linux import Linux, LinuxAccount, units
from secret_gate.rpc_protocol import peer_uid
from secret_gate.service import CommandResult
from secret_gate.service_paths import SERVICE_REFUSAL, ServiceConfig, SystemLayout, read_service_config, service_refusal
from secret_gate.system_exec import SystemDeps, execute, local_status, systemd_not_loaded
from secret_gate.system_ops import SYSTEMD_NOT_LOADED_OK, EnsureFile, RemovePath, Run, StageRuntime, SwapRuntime
from secret_gate.system_plan import (
    InstallFacts,
    InstallOptions,
    install_plan,
    render,
    rotate_key_plan,
    uninstall_plan,
    update_plan,
)
from tests.test_system_install import make_runtime

UID, GID = os.getuid(), os.getgid()
USER = "agentswitch-gate"
NEW = LinuxAccount(exists=False, tool="useradd", shell="/usr/sbin/nologin")


def _ops(plan):
    return [op for step in plan.steps for op in step.ops]


def _argvs(plan):
    return [op.argv for op in _ops(plan) if isinstance(op, Run)]


class FakeRunner:
    def __init__(self, passwd: CommandResult | None = None, fail: str | None = None) -> None:
        self.calls: list[tuple[str, ...]] = []
        self.passwd = passwd
        self.fail = fail

    def __call__(self, argv):
        argv = tuple(argv)
        assert argv[0].startswith("/"), argv                               # root never looks tools up in PATH
        self.calls.append(argv)
        tool = Path(argv[0]).name
        if self.fail and tool == self.fail:
            return CommandResult(1, "", f"{tool}: simulated failure")
        if argv[1:] == ("passwd", USER):
            return self.passwd or CommandResult(0, f"{USER}:x:998:998:AgentSwitch Gate:/nonexistent:/usr/sbin/nologin\n")
        if tool == "systemctl" and argv[1] in ("stop", "disable", "kill"):
            return CommandResult(5, "", f"Failed to stop {argv[-1]}: Unit {argv[-1]} not loaded.")
        return CommandResult(0)


@pytest.fixture(autouse=True)
def no_real_commands(monkeypatch):
    def boom(*_a, **_k):
        raise AssertionError("a test reached a real privileged command")
    monkeypatch.setattr("secret_gate.system_cli.run_command", boom)
    monkeypatch.setattr("secret_gate.service.run_command", boom)
    monkeypatch.setattr("secret_gate.system_exec.CA_KEY_SIZE", 1024)


def _mode(path: Path) -> int:
    return stat.S_IMODE(path.lstat().st_mode)


def node_runtime(path: Path) -> Path:
    """A node's runtime as install.sh leaves it: the gate's part plus node/ and daemon/, which are not copied."""
    make_runtime(path)
    (path / "node" / "bin").mkdir(parents=True)
    (path / "node" / "bin" / "node").write_text("#!/bin/sh\n")
    (path / "daemon").mkdir()
    (path / "daemon" / "cli.js").write_text("//\n")
    return path


# -- layout ---------------------------------------------------------------------------------------

def test_linux_layout_and_native_choice():
    layout = SystemLayout(Path("/p"), LINUX)
    assert layout.root == Path("/p/var/lib/agentswitch")
    assert layout.gate == Path("/p/var/lib/agentswitch/gate") and layout.public == Path("/p/var/lib/agentswitch/gate-public")
    assert layout.config == Path("/p/var/lib/agentswitch/gate-service.json")
    assert layout.runtime == Path("/p/opt/agentswitch/gate-runtime")
    assert layout.runtime_staging == Path("/p/opt/agentswitch/gate-runtime.new")
    assert layout.runtime_backup == Path("/p/opt/agentswitch/gate-runtime.old")
    assert layout.wrapper == Path("/p/opt/agentswitch/gate-runtime/bin/secret-gate")
    assert layout.service_file("agentswitch-gate-rpc") == Path("/p/etc/systemd/system/agentswitch-gate-rpc.service")
    assert native("linux") is LINUX and native("darwin") is MACOS
    assert SystemLayout().platform is MACOS                                # the default before the layer existed
    assert SystemLayout.native().platform is native()
    # The daemon's deny list already names this public directory (daemon src/executors/protected.ts).
    assert str(SystemLayout(Path("/"), LINUX).public) == "/var/lib/agentswitch/gate-public"


def test_refusal_names_where_the_service_is_managed():
    assert service_refusal(MACOS) == "凭据网关由系统服务管理，请在 Mac 应用里操作。"
    linux = service_refusal(LINUX)
    assert linux.startswith(SERVICE_REFUSAL) and "sudo secret-gate system" in linux


# -- the plan -------------------------------------------------------------------------------------

LAYOUT = SystemLayout(Path("/tmp/sg-linux"), LINUX)
OPTIONS = InstallOptions(owner_uid=1000, port=8080, runtime=Path("/home/u/.local/share/agentswitch/runtime/20261123-x"))
FACTS = InstallFacts(account=NEW, runtime_version="0.1.0+t", installed_at="2026-11-23T00:00:00Z", owner_gid=1000)


def test_account_is_a_system_user_nobody_logs_in_as():
    argvs = _argvs(install_plan(LAYOUT, OPTIONS, FACTS))
    assert argvs[0] == ("/usr/sbin/useradd", "--system", "--user-group", "--no-create-home", "--home-dir", "/nonexistent",
                        "--shell", "/usr/sbin/nologin", "--comment", "AgentSwitch Gate", USER)
    check = next(op for op in _ops(install_plan(LAYOUT, OPTIONS, FACTS)) if isinstance(op, Run)
                 and op.argv == ("/usr/bin/getent", "passwd", USER))
    assert check.expect == ":/usr/sbin/nologin\n"
    assert ("/usr/bin/getent", "group", USER) in argvs
    debian = replace(FACTS, account=LinuxAccount(False, "adduser", "/usr/sbin/nologin"))
    assert _argvs(install_plan(LAYOUT, OPTIONS, debian))[0][:3] == ("/usr/sbin/adduser", "--system", "--group")
    existing = replace(FACTS, account=LinuxAccount(True, "", "/bin/false"))
    plan = install_plan(LAYOUT, OPTIONS, existing)
    assert plan.steps[0].title == f"确认服务账户 {USER}"
    assert not any(Path(a[0]).name in ("useradd", "adduser") for a in _argvs(plan))


def test_install_plan_paths_owners_and_order():
    plan = install_plan(LAYOUT, OPTIONS, FACTS)
    argvs, ops = _argvs(plan), _ops(plan)
    root = LAYOUT.root
    assert ("/bin/chown", "root:root", str(root)) in argvs
    assert ("/bin/chown", "root:root", str(LAYOUT.runtime.parent)) in argvs           # /opt/agentswitch
    assert ("/bin/chown", "-R", "root:root", str(LAYOUT.runtime_staging)) in argvs
    assert ("/bin/chown", "root:root", str(LAYOUT.config)) in argvs
    assert ("/bin/chmod", "-R", "go-rwx", str(LAYOUT.gate)) in argvs
    assert ("/bin/chown", "-R", f"{USER}:{USER}", str(LAYOUT.gate)) in argvs
    assert ("/bin/chown", "-R", f"{USER}:1000", str(LAYOUT.public)) in argvs          # the login user's group only
    public = next(op for op in ops if getattr(op, "path", None) == LAYOUT.public and hasattr(op, "mode"))
    assert public.mode == 0o750
    logs = [op.path.name for op in ops if isinstance(op, EnsureFile)]
    assert logs == ["proxy.log", "rpc.log"]
    units_written = [op.path for op in ops if getattr(op, "data", None) is not None and op.path.suffix == ".service"]
    assert units_written == [LAYOUT.service_file("agentswitch-gate-rpc"), LAYOUT.service_file("agentswitch-gate-proxy")]
    reload_ = argvs.index(("/bin/systemctl", "daemon-reload"))
    stops = [i for i, a in enumerate(argvs) if a[:2] == ("/bin/systemctl", "stop")]
    starts = [i for i, a in enumerate(argvs) if a[:3] == ("/bin/systemctl", "enable", "--now")]
    swap = next(i for i, op in enumerate(ops) if isinstance(op, SwapRuntime))
    assert reload_ < stops[0] and len(stops) == 2 and len(starts) == 2
    stop_ops = [op for op in ops if isinstance(op, Run) and op.argv[:2] == ("/bin/systemctl", "stop")]
    assert all(op.tolerate == SYSTEMD_NOT_LOADED_OK for op in stop_ops)
    assert ops.index(stop_ops[-1]) < swap
    assert [argvs[i][-1] for i in starts] == ["agentswitch-gate-rpc.service", "agentswitch-gate-proxy.service"]
    text = "\n".join(render(plan))
    for mac in ("/Library", "launchctl", "dscl", "sysadminctl", "root:wheel", "_agentswitchgate", "/usr/sbin/chown"):
        assert mac not in text, mac
    for gone in ("/home/u/.secret-gate", ".mitmproxy", "migrat", "迁移"):
        assert gone not in text, gone
    assert "写入 systemd 单元" in text


def test_units_run_the_root_owned_copy_hardened_as_the_service_user():
    files = units(LAYOUT, 8080)
    assert list(files) == ["agentswitch-gate-rpc", "agentswitch-gate-proxy"]
    rpc, proxy = files["agentswitch-gate-rpc"].decode(), files["agentswitch-gate-proxy"].decode()
    wrapper = LAYOUT.wrapper
    assert f"ExecStart={wrapper} rpc\n" in rpc
    assert f"ExecStart={wrapper} proxy --port 8080 --confdir {LAYOUT.mitmproxy}\n" in proxy
    for unit, log in ((rpc, "rpc"), (proxy, "proxy")):
        lines = set(unit.splitlines())
        assert {f"User={USER}", f"Group={USER}", "NoNewPrivileges=yes", "ProtectSystem=strict", "ProtectHome=yes",
                "PrivateTmp=yes", "UMask=0077", "Restart=always", "CapabilityBoundingSet=",
                f"ReadWritePaths={LAYOUT.gate} {LAYOUT.public}", f"WorkingDirectory={LAYOUT.gate}",
                f"StandardOutput=append:{LAYOUT.logs / f'{log}.log'}", "WantedBy=multi-user.target"} <= lines
        env = sorted(line.removeprefix("Environment=") for line in lines if line.startswith("Environment="))
        assert env == [f"HOME={LAYOUT.gate}", f"PATH={LAYOUT.runtime / 'python/bin'}:/usr/bin:/bin:/usr/sbin:/sbin",
                       f"SECRET_GATE_HOME={LAYOUT.gate}", f"SECRET_GATE_PUBLIC={LAYOUT.public}"]
        assert "proxy" not in " ".join(e for e in env if e.lower().startswith(("http", "https", "all")))
        assert "/home" not in unit and ".local/share" not in unit                      # never the user's runtime
    spaced = SystemLayout(Path("/tmp/a b"), LINUX)
    assert f'ExecStart="{spaced.wrapper}" rpc' in units(spaced, 1)["agentswitch-gate-rpc"].decode()


def test_rotate_update_uninstall_plans():
    rotate = rotate_key_plan(LAYOUT, 1000)
    hup = ("/bin/systemctl", "kill", "--signal=SIGHUP", "agentswitch-gate-proxy.service")
    assert hup in _argvs(rotate)
    assert ("/bin/chown", "-R", f"{USER}:1000", str(LAYOUT.public)) in _argvs(rotate)
    update = update_plan(LAYOUT, Path("/new"), ServiceConfig(1000, 8181, "v2", "t"))
    ops = _ops(update)
    assert next(i for i, op in enumerate(ops) if isinstance(op, StageRuntime)) < next(i for i, op in enumerate(ops) if isinstance(op, SwapRuntime))
    proxy_unit = next(op for op in ops if getattr(op, "path", None) == LAYOUT.service_file("agentswitch-gate-proxy"))
    assert b"--port 8181" in proxy_unit.data
    assert not any(Path(a[0]).name in ("useradd", "adduser", "getent") for a in _argvs(update))
    keep = uninstall_plan(LAYOUT, delete_keys=False)
    argvs = _argvs(keep)
    assert argvs[:2] == [("/bin/systemctl", "disable", "--now", "agentswitch-gate-rpc.service"),
                         ("/bin/systemctl", "disable", "--now", "agentswitch-gate-proxy.service")]
    assert argvs[-1] == ("/bin/systemctl", "daemon-reload")
    removed = {op.path for op in _ops(keep) if isinstance(op, RemovePath)}
    assert {LAYOUT.service_file("agentswitch-gate-rpc"), LAYOUT.runtime, LAYOUT.public, LAYOUT.config} <= removed
    assert LAYOUT.gate not in removed and keep.steps[1].title == "删除 systemd 单元"
    with pytest.raises(GateError, match="组"):
        rotate_key_plan(LAYOUT, None)                                        # never chown gate-public/ to a guess


# -- facts ----------------------------------------------------------------------------------------

def test_gather_account():
    found = LINUX.gather_account(FakeRunner(), simulate=False)
    assert found == LinuxAccount(True, "", "/usr/sbin/nologin")
    for line in (f"{USER}:x:998:998::/home/x:/bin/bash\n", f"{USER}:x:0:0::/root:/usr/sbin/nologin\n"):
        with pytest.raises(GateError, match="可以登录"):
            LINUX.gather_account(FakeRunner(passwd=CommandResult(0, line)), simulate=False)
    with pytest.raises(GateError, match="无法识别"):
        LINUX.gather_account(FakeRunner(passwd=CommandResult(0, "garbage\n")), simulate=False)
    missing = FakeRunner(passwd=CommandResult(2))
    assert Linux(exists=lambda p: True).gather_account(missing, simulate=False) == NEW
    debian = Linux(exists=lambda p: p in ("/usr/sbin/adduser", "/sbin/nologin"))
    assert debian.gather_account(missing, simulate=False) == LinuxAccount(False, "adduser", "/sbin/nologin")
    with pytest.raises(GateError, match="useradd"):
        Linux(exists=lambda p: False).gather_account(missing, simulate=False)
    with pytest.raises(GateError, match="失败"):
        LINUX.gather_account(FakeRunner(passwd=CommandResult(1)), simulate=False)
    sim = FakeRunner()
    assert LINUX.gather_account(sim, simulate=True) == NEW and sim.calls == []


def test_owner_gid():
    assert LINUX.owner_gid(5, simulate=False, getpwuid=lambda uid: SimpleNamespace(pw_gid=77)) == 77

    def nobody(_uid):
        raise KeyError(_uid)
    with pytest.raises(GateError, match="找不到 uid"):
        LINUX.owner_gid(5, simulate=False, getpwuid=nobody)
    assert LINUX.owner_gid(5, simulate=True, getpwuid=nobody) == GID
    assert MACOS.owner_gid(5, simulate=False) is None


def test_systemd_not_loaded():
    assert systemd_not_loaded(CommandResult(5, "", "Failed to stop x.service: Unit x.service not loaded."))
    assert systemd_not_loaded(CommandResult(1, "", "Failed to disable unit: Unit file x.service does not exist."))
    assert not systemd_not_loaded(CommandResult(1, "", "Access denied"))
    assert not systemd_not_loaded(CommandResult(0))


# -- carried out in a temporary root ----------------------------------------------------------------

class World:
    def __init__(self, tmp: Path) -> None:
        self.prefix = tmp / "prefix"
        self.prefix.mkdir()
        self.layout = SystemLayout(self.prefix, LINUX)
        self.runtime = node_runtime(tmp / "home" / ".local" / "share" / "agentswitch" / "runtime" / "20261123-abc")

    def deps(self, runner=None, **kw) -> SystemDeps:
        return SystemDeps(runner=runner or FakeRunner(), status=local_status(self.layout.gate), sleep=lambda _s: None, **kw)

    def install(self, runner=None):
        options = InstallOptions(owner_uid=UID, port=8080, runtime=self.runtime)
        facts = InstallFacts(account=NEW, runtime_version="0.1.0+2026-09-27T00:00:00Z", installed_at="t", owner_gid=GID)
        return execute(install_plan(self.layout, options, facts), self.deps(runner))


@pytest.fixture
def world(tmp_path) -> World:
    return World(tmp_path)


def test_install_lays_out_the_service(world):
    runner = FakeRunner()
    outcome = world.install(runner)
    assert outcome.ok, outcome.lines
    layout = world.layout
    for path, mode in ((layout.root, 0o755), (layout.runtime.parent, 0o755), (layout.gate, 0o700), (layout.logs, 0o700),
                       (layout.mitmproxy, 0o700), (layout.public, 0o750), (layout.runtime, 0o755)):
        assert _mode(path) == mode, path
    assert _mode(layout.logs / "proxy.log") == 0o600 and _mode(layout.logs / "rpc.log") == 0o600
    assert _mode(layout.gate / "key.priv") == 0o600
    assert json.loads((layout.public / "keys.json").read_text())[0]["publicKey"] == keypair_info(layout.gate).public
    # only the gate's part of the node's runtime is copied, and the units run that copy
    assert sorted(p.name for p in layout.runtime.iterdir()) == ["VERSIONS", "bin", "python", "secret-gate"]
    assert f"exec {layout.runtime / 'python/bin/secret-gate'} " in (layout.runtime / "bin" / "secret-gate").read_text()
    unit = layout.service_file("agentswitch-gate-rpc")
    assert _mode(unit) == 0o644 and f"ExecStart={layout.wrapper} rpc" in unit.read_text()
    assert read_service_config(layout.config) == ServiceConfig(UID, 8080, "0.1.0+2026-09-27T00:00:00Z", "t")
    assert runner.calls[0][0] == "/usr/sbin/useradd"
    assert ("/bin/chown", "-R", f"{USER}:{GID}", str(layout.public)) in runner.calls
    assert runner.calls[-1] == ("/bin/systemctl", "enable", "--now", "agentswitch-gate-proxy.service")
    assert any("未加载，跳过" in line for line in outcome.lines)                    # stop before the first start
    assert not any(str(world.runtime.parents[3]) in " ".join(c) for c in runner.calls)  # the user's home: never named


def test_reinstall_keeps_the_key_and_the_logs(world):
    assert world.install().ok
    key = keypair_info(world.layout.gate).public
    (world.layout.logs / "proxy.log").write_text("earlier\n")
    assert world.install().ok
    assert keypair_info(world.layout.gate).public == key
    assert (world.layout.logs / "proxy.log").read_text() == "earlier\n"


def test_a_log_that_is_a_link_is_refused(world, tmp_path):
    victim = tmp_path / "victim"
    victim.write_text("keep")
    victim.chmod(0o644)
    world.layout.logs.mkdir(parents=True)
    (world.layout.logs / "proxy.log").symlink_to(victim)
    outcome = world.install()
    assert not outcome.ok and any("不是普通文件" in line for line in outcome.lines)
    assert victim.read_text() == "keep" and _mode(victim) == 0o644


def test_the_users_runtime_is_copied_with_the_same_hardening(world, tmp_path):
    secret = tmp_path / "root-only"
    (secret / "python" / "bin").mkdir(parents=True)
    (secret / "key.priv").write_text("PRIVATE")
    (world.runtime / "python").rename(world.runtime / "python.real")
    (world.runtime / "python").symlink_to(secret / "python")
    outcome = world.install()
    assert not outcome.ok and any("运行时中的 python 不是目录" in line for line in outcome.lines)
    assert not world.layout.runtime.exists()


def test_rotate_update_uninstall_carried_out(world, tmp_path):
    assert world.install().ok
    key = keypair_info(world.layout.gate).public
    runner = FakeRunner()
    outcome = execute(rotate_key_plan(world.layout, GID), world.deps(runner))
    assert outcome.ok, outcome.lines
    assert keypair_info(world.layout.gate).public != key
    assert ("/bin/systemctl", "kill", "--signal=SIGHUP", "agentswitch-gate-proxy.service") in runner.calls
    new = node_runtime(tmp_path / "rt2" / "runtime")
    config = replace(read_service_config(world.layout.config), proxy_port=8181)
    assert execute(update_plan(world.layout, new, config), world.deps()).ok
    assert "--port 8181" in world.layout.service_file("agentswitch-gate-proxy").read_text()
    assert execute(uninstall_plan(world.layout, delete_keys=False), world.deps()).ok
    assert world.layout.gate.is_dir() and not world.layout.runtime.exists() and not world.layout.config.exists()
    assert not world.layout.service_file("agentswitch-gate-rpc").exists()


# -- the CLI --------------------------------------------------------------------------------------

def _main(argv: list[str]) -> int:
    from secret_gate.cli import main

    return main(argv)


def test_cli_with_platform_linux(world, capsys):
    root = ["--root", str(world.prefix), "--platform", "linux"]
    assert _main(["system", "install", "--owner-uid", str(UID), "--runtime", str(world.runtime), "--dry-run", *root]) == 0
    out = capsys.readouterr().out
    assert "$ /usr/sbin/useradd --system" in out and "/opt/agentswitch/gate-runtime" in out and "launchctl" not in out
    assert list(world.prefix.iterdir()) == []
    assert _main(["system", "install", "--owner-uid", str(UID), "--runtime", str(world.runtime), *root]) == 0
    assert "$ /bin/systemctl enable --now agentswitch-gate-rpc.service（--root：未执行）" in capsys.readouterr().out
    assert _mode(world.layout.public) == 0o750
    assert _main(["system", "status", "--json", *root]) == 0
    report = json.loads(capsys.readouterr().out)
    assert report["installed"] and report["ownerUid"] == UID and report["publicDir"] == str(world.layout.public)
    assert _main(["system", "rotate-key", *root]) == 0
    assert "kill --signal=SIGHUP agentswitch-gate-proxy.service" in capsys.readouterr().out
    assert _main(["system", "uninstall", *root]) == 0
    assert not world.layout.config.exists()


def test_cli_owner_from_sudo_and_platform_only_with_root(world, capsys, monkeypatch):
    monkeypatch.setenv("SUDO_UID", str(UID))
    assert _main(["system", "install", "--runtime", str(world.runtime), "--root", str(world.prefix),
                  "--platform", "linux"]) == 0
    assert read_service_config(world.layout.config).owner_uid == UID
    capsys.readouterr()
    monkeypatch.delenv("SUDO_UID")
    assert _main(["system", "install", "--runtime", str(world.runtime), "--root", str(world.prefix)]) == 2
    assert "--owner-uid" in capsys.readouterr().err
    assert _main(["system", "status", "--platform", "linux"]) == 2
    assert "--root" in capsys.readouterr().err


def test_gather_facts_on_linux(world):
    options = InstallOptions(owner_uid=UID, port=8080, runtime=world.runtime)
    facts = system_cli.gather_install_facts(options, FakeRunner(passwd=CommandResult(2)), simulate=False,
                                            now=datetime(2026, 11, 23), platform=Linux(exists=lambda p: True))
    assert facts.account == NEW and facts.owner_gid == os.getgid() and facts.runtime_version == "0.1.0+2026-09-27T00:00:00Z"


# -- the peer check -------------------------------------------------------------------------------

@pytest.mark.skipif(not sys.platform.startswith("linux"), reason="SO_PEERCRED is Linux's")
def test_so_peercred_gives_the_kernels_uid():
    a, b = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
    with a, b:
        assert LINUX.peer_uid(a) == UID == peer_uid(b, "linux")


@pytest.mark.skipif(sys.platform != "darwin", reason="LOCAL_PEERCRED is macOS's")
def test_local_peercred_and_no_so_peercred_on_macos():
    a, b = socket.socketpair(socket.AF_UNIX, socket.SOCK_STREAM)
    with a, b:
        assert MACOS.peer_uid(a) == UID
        with pytest.raises(OSError):
            peer_uid(a, "linux")
