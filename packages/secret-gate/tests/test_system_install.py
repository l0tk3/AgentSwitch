"""`secret-gate system install|update|uninstall` carried out in a temporary root (gate-service-v0 §5, §6).

Privileged commands go to a recording fake runner; the "running service" is a fake status that reads the gate
home. The login user's old home is a temp dir owned by this test user; nothing under the real ~ is touched.
"""

from __future__ import annotations

import json
import os
import stat
from dataclasses import replace
from datetime import datetime
from pathlib import Path

import pytest

from secret_gate import system_cli
from secret_gate.constants import USE_HTTP
from secret_gate.crypto import generate_keypair
from secret_gate.errors import GateError
from secret_gate.keyring import current_name, list_keypairs, set_current
from secret_gate.keystore import save_keypair
from secret_gate.policy import SecretPayload
from secret_gate.refs import RefRegistry
from secret_gate.resolver import Resolver
from secret_gate.rpc_client import ServiceUnavailable
from secret_gate.service import CommandResult
from secret_gate.service_paths import (
    SERVICE_USER,
    ServiceConfig,
    SystemLayout,
    read_service_config,
)
from secret_gate.system_exec import SystemDeps, execute, local_status
from secret_gate.system_plan import (
    Account,
    InstallFacts,
    InstallOptions,
    install_plan,
    uninstall_plan,
    update_plan,
)
from secret_gate.tokens import make_token

UID = os.getuid()
SCOPE = "install-scope-0123456789abcd"


class FakeRunner:
    def __init__(self, fail: str | None = None) -> None:
        self.calls: list[tuple[str, ...]] = []
        self.fail = fail

    def __call__(self, argv):
        argv = tuple(argv)
        assert argv[0].startswith("/"), argv                               # root never looks tools up in PATH
        self.calls.append(argv)
        tool = Path(argv[0]).name
        if self.fail and tool == self.fail:
            return CommandResult(1, "", f"{self.fail}: simulated failure")
        if (tool, *argv[1:3]) == ("dscl", ".", "-read"):
            return CommandResult(0, "UserShell: /usr/bin/false\n")
        if (tool, argv[1]) == ("launchctl", "bootout"):
            return CommandResult(113, "", "Could not find service")
        return CommandResult(0)


@pytest.fixture(autouse=True)
def no_real_commands(monkeypatch):
    def boom(*_a, **_k):
        raise AssertionError("a test reached a real privileged command")
    monkeypatch.setattr("secret_gate.system_cli.run_command", boom)
    monkeypatch.setattr("secret_gate.service.run_command", boom)
    monkeypatch.setattr("secret_gate.system_exec.CA_KEY_SIZE", 1024)       # speed; the size is not under test


def _mode(path: Path) -> int:
    return stat.S_IMODE(path.lstat().st_mode)


def make_runtime(path: Path, built: str = "2026-09-27T00:00:00Z") -> Path:
    bin_dir = path / "python" / "bin"
    bin_dir.mkdir(parents=True)
    (bin_dir / "python3.12").write_text("#!/bin/sh\n")
    (bin_dir / "secret-gate").write_text("#!/bin/sh\nexec python3.12 -m secret_gate.cli \"$@\"\n")
    for exe in ("python3.12", "secret-gate"):
        (bin_dir / exe).chmod(0o775)
    (bin_dir / "python3").symlink_to("python3.12")
    (path / "python" / "lib").mkdir()
    (path / "python" / "lib" / "x.py").write_text("x = 1\n")
    (path / "python" / "lib" / "x.py").chmod(0o664)
    (path / "secret-gate").mkdir()
    (path / "secret-gate" / "AGENTS.md").write_text("guidance\n")
    (path / "VERSIONS").write_text(f"node=24\nsecret-gate=0.1.0\nbuilt={built}\n")
    return path


def _token(public: bytes, label: str) -> str:
    return make_token(public, SecretPayload.create(value=f"pw-{label}", hosts=["a.example"], uses=[USE_HTTP], label=label))


class World:
    """An old gate home, a user home with ~/.mitmproxy and the old LaunchAgent, a runtime, a temp root."""

    def __init__(self, tmp: Path) -> None:
        self.prefix = tmp / "prefix"
        self.prefix.mkdir()
        self.layout = SystemLayout(self.prefix)
        self.user_home = tmp / "user"
        self.old = self.user_home / ".secret-gate"
        default, work = generate_keypair(), generate_keypair()
        save_keypair(self.old, default)
        save_keypair(self.old / "keys" / "work", work)
        set_current(self.old, "work")
        self.tokens = {"default": _token(default.public, "old/default"), "work": _token(work.public, "old/work")}
        RefRegistry.from_home(self.old).register(SCOPE, self.tokens["work"], "old/work")
        (self.old / "exec_templates.json").write_text('{"x": {"argv": ["/bin/echo", "{SECRET}"]}}')
        (self.old / "upstream-insecure.txt").write_text("intranet.example\n")
        (self.old / "logs").mkdir()
        (self.old / "logs" / "browser-audit.jsonl").write_text('{"event": "fill"}\n')
        (self.old / "ca.pem").write_text("old ca")
        (self.old / "browser-out").mkdir()
        (self.old / "browser-out" / "page.yml").write_text("snapshot")
        (self.old / "notes.txt").write_text("mine")
        mitm = self.user_home / ".mitmproxy"
        mitm.mkdir()
        (mitm / "mitmproxy-ca.pem").write_text("OLD CA KEY")
        (mitm / "mitmproxy-ca-cert.pem").write_text("OLD CA CERT")
        self.agent = self.user_home / "Library" / "LaunchAgents" / "com.agentswitch.secret-gate.proxy.plist"
        self.agent.parent.mkdir(parents=True)
        self.agent.write_text("<plist/>")
        self.runtime = make_runtime(tmp / "bundle" / "runtime")

    def options(self, **changes) -> InstallOptions:
        return replace(InstallOptions(owner_uid=UID, port=9090, runtime=self.runtime, migrate_from=self.old,
                                      user_home=self.user_home), **changes)

    def facts(self, **changes) -> InstallFacts:
        return replace(InstallFacts(account=Account(450, 450, True, True), runtime_version="0.1.0+2026-09-27T00:00:00Z",
                                    installed_at="2026-09-27T01:02:03Z", old_agent_plist=self.agent), **changes)

    def deps(self, runner=None, status=None, **kw) -> SystemDeps:
        return SystemDeps(runner=runner or FakeRunner(), status=status or local_status(self.layout.gate),
                          sleep=lambda _s: None, **kw)

    def install(self, runner=None, status=None, **kw):
        return execute(install_plan(self.layout, self.options(), self.facts()), self.deps(runner, status, **kw))


@pytest.fixture
def world(tmp_path) -> World:
    return World(tmp_path)


def test_install_migrates_everything_and_leaves_moved_txt(world):
    runner = FakeRunner()
    outcome = world.install(runner)
    assert outcome.ok, outcome.lines
    layout = world.layout
    assert all(not line.startswith(("[失败]", "[未执行]")) for line in outcome.lines)
    # directories and modes (§2)
    for path, mode in ((layout.root, 0o755), (layout.gate, 0o700), (layout.gate / "keys", 0o700),
                       (layout.gate / "keys" / "legacy", 0o700), (layout.logs, 0o700), (layout.mitmproxy, 0o700),
                       (layout.public, 0o755), (layout.runtime, 0o755)):
        assert _mode(path) == mode, path
    # keys: old ones decrypt only, a new current one
    rows = {k.name: k for k in list_keypairs(layout.gate)}
    assert current_name(layout.gate) == "main" and rows["default"].legacy and rows["work"].legacy
    resolver = Resolver.from_home(layout.gate)
    for name, token in world.tokens.items():
        assert resolver.resolve(token, use=USE_HTTP, host="a.example:443").value == f"pw-old/{name}"
    assert _mode(layout.gate / "keys" / "legacy" / "work" / "key.priv") == 0o600
    # public files
    published = json.loads((layout.public / "keys.json").read_text())
    assert [(r["name"], r["current"], r["legacy"]) for r in published] == [("main", True, False), ("default", False, True),
                                                                          ("work", False, True)]
    assert (layout.public / "ca.pem").read_text().startswith("-----BEGIN CERTIFICATE-----")
    assert b"PRIVATE KEY" not in (layout.public / "ca.pem").read_bytes()
    assert _mode(layout.mitmproxy / "mitmproxy-ca.pem") == 0o600
    # data and trusted config
    assert RefRegistry.from_home(layout.gate).lookup(SCOPE, RefRegistry.from_home(layout.gate).register(SCOPE, world.tokens["work"], "old/work")).token
    assert (layout.gate / "upstream-insecure.txt").read_text() == "intranet.example\n"
    assert _mode(layout.gate / "exec_templates.json") == 0o600
    assert (layout.gate / "logs" / "before-service" / "browser-audit.jsonl").exists()
    # runtime copy
    wrapper = (layout.runtime / "bin" / "secret-gate").read_text()
    assert f"'{layout.runtime / 'python/bin/secret-gate'}'" in wrapper and _mode(layout.runtime / "bin" / "secret-gate") == 0o755
    assert os.readlink(layout.runtime / "python/bin/python3") == "python3.12"
    assert _mode(layout.runtime / "python/lib/x.py") == 0o644 and _mode(layout.runtime / "python/bin/python3.12") == 0o755
    assert not layout.runtime_staging.exists() and not layout.runtime_backup.exists()
    config = read_service_config(layout.config)
    assert config == ServiceConfig(UID, 9090, "0.1.0+2026-09-27T00:00:00Z", "2026-09-27T01:02:03Z")
    assert _mode(layout.config) == 0o644 and _mode(layout.plist("com.agentswitch.gate.rpc")) == 0o644
    # privileged commands, in order
    assert runner.calls[0][0] == "/usr/sbin/dseditgroup" and runner.calls[1][0] == "/usr/sbin/sysadminctl"
    assert ("/usr/sbin/chown", "-R", f"{SERVICE_USER}:{SERVICE_USER}", str(layout.gate)) in runner.calls
    assert ("/bin/launchctl", "bootout", f"gui/{UID}/com.agentswitch.secret-gate.proxy") in runner.calls
    assert runner.calls[-1] == ("/bin/launchctl", "bootstrap", "system", str(layout.plist("com.agentswitch.gate.proxy")))
    # the login user's side
    assert sorted(p.name for p in world.old.iterdir()) == ["MOVED.txt", "notes.txt"]
    moved = (world.old / "MOVED.txt").read_text()
    assert str(layout.gate) in moved and SERVICE_USER in moved
    assert sorted(p.name for p in (world.user_home / ".mitmproxy").iterdir()) == ["mitmproxy-ca-cert.pem"]
    assert not world.agent.exists()
    assert any("保留" in line and "notes.txt" in line for line in outcome.lines)


def test_a_failing_command_stops_the_install_and_says_what_was_not_done(world):
    outcome = world.install(FakeRunner(fail="dseditgroup"))
    assert not outcome.ok
    failed = [line for line in outcome.lines if line.startswith("[失败]")]
    assert failed == ["[失败] 1. 创建服务账户 _agentswitchgate：/usr/sbin/dseditgroup -o create -i 450 "
                      "-r 'AgentSwitch Gate' _agentswitchgate 失败（1）：dseditgroup: simulated failure"]
    assert sum(line.startswith("[未执行]") for line in outcome.lines) == len(install_plan(world.layout, world.options(), world.facts()).steps) - 1
    assert not world.layout.root.exists() and (world.old / "key.priv").exists()


def test_originals_stay_when_the_service_never_answers(world):
    def silent(_socket):
        raise ServiceUnavailable("凭据网关服务无响应（连接被关闭）")

    outcome = world.install(status=silent, wait_tries=3)
    assert not outcome.ok
    assert any(line.startswith("[失败]") and "等待服务响应" in line and "无响应" in line for line in outcome.lines)
    assert (world.old / "key.priv").exists() and (world.old / "keys" / "work" / "key.priv").exists()
    assert (world.user_home / ".mitmproxy" / "mitmproxy-ca.pem").exists()
    assert (world.layout.gate / "keys" / "legacy" / "work" / "key.priv").exists()     # copies are in place


def test_a_proxy_that_did_not_start_fails_the_wait(world):
    def no_proxy(_socket):
        return {**local_status(world.layout.gate)(_socket), "proxyRunning": False}

    outcome = world.install(status=no_proxy, wait_tries=2)
    assert not outcome.ok and any("代理未运行" in line for line in outcome.lines)


def test_install_again_is_harmless(world):
    assert world.install().ok
    again = execute(install_plan(world.layout, world.options(), world.facts(account=Account(450, 450, False, False),
                                                                                  old_agent_plist=None)), world.deps())
    assert again.ok, again.lines
    assert [k.name for k in list_keypairs(world.layout.gate)] == ["main", "default", "work"]
    assert any("已有当前密钥 main" in line for line in again.lines)


def test_symlinks_in_the_users_home_are_never_followed(world, tmp_path):
    victim = tmp_path / "victim"
    save_keypair(victim, generate_keypair())                                # a valid keypair behind the link
    (victim / "precious.txt").write_text("keep me")
    (world.old / "keys" / "evil").symlink_to(victim)
    (world.old / "MOVED.txt").symlink_to(victim / "precious.txt")
    os.link(world.old / "notes.txt", tmp_path / "hardlink")                # notes.txt now has two links
    (world.old / "exec_templates.json").unlink()
    os.link(tmp_path / "hardlink", world.old / "exec_templates.json")
    assert world.install().ok
    assert (victim / "precious.txt").read_text() == "keep me" and (victim / "key.priv").exists()
    assert "evil" not in {k.name for k in list_keypairs(world.layout.gate)}   # never read through the link
    assert not (world.old / "MOVED.txt").is_symlink() and "系统服务" in (world.old / "MOVED.txt").read_text()
    assert not (world.layout.gate / "exec_templates.json").exists()        # a hard link is not read as root


def test_unusable_old_keys_are_reported_and_kept(world):
    (world.old / "keys" / "broken").mkdir()
    (world.old / "keys" / "broken" / "key.priv").write_text("not a key")
    (world.old / "keys" / "broken" / "key.priv").chmod(0o600)
    outcome = world.install()
    assert outcome.ok
    assert any("无法迁移" in line and "broken" in line for line in outcome.lines)
    assert (world.old / "keys" / "broken" / "key.priv").exists()


def test_a_runtime_symlink_leaving_the_copy_is_refused(world, tmp_path):
    (world.runtime / "python" / "lib" / "escape").symlink_to(tmp_path)
    outcome = world.install()
    assert not outcome.ok and any("符号链接指向副本之外" in line for line in outcome.lines)


def test_update_replaces_the_runtime_and_restarts(world, tmp_path):
    assert world.install().ok
    new_runtime = make_runtime(tmp_path / "bundle2" / "runtime", built="2026-10-01T00:00:00Z")
    config = replace(read_service_config(world.layout.config), runtime_version="0.1.0+2026-10-01T00:00:00Z", proxy_port=9191)
    runner = FakeRunner()
    outcome = execute(update_plan(world.layout, new_runtime, config), world.deps(runner))
    assert outcome.ok, outcome.lines
    assert "built=2026-10-01" in (world.layout.runtime / "VERSIONS").read_text()
    assert read_service_config(world.layout.config).proxy_port == 9191
    assert b"9191" in world.layout.plist("com.agentswitch.gate.proxy").read_bytes()
    assert [c[1] for c in runner.calls if c[0] == "/bin/launchctl"] == ["bootout", "bootout", "bootstrap", "bootstrap"]
    assert current_name(world.layout.gate) == "main"


def test_uninstall_keeps_keys_unless_asked(world):
    assert world.install().ok
    assert execute(uninstall_plan(world.layout, delete_keys=False), world.deps()).ok
    assert world.layout.gate.is_dir() and not world.layout.runtime.exists() and not world.layout.public.exists()
    assert not world.layout.config.exists() and not world.layout.plist("com.agentswitch.gate.rpc").exists()
    assert execute(uninstall_plan(world.layout, delete_keys=True), world.deps()).ok
    assert not world.layout.gate.exists()


# -- the CLI --------------------------------------------------------------------------------------

def _cli(world, *extra) -> list[str]:
    return ["system", "install", "--owner-uid", str(UID), "--port", "9090", "--runtime", str(world.runtime),
            "--migrate-from", str(world.old), "--user-home", str(world.user_home), "--root", str(world.prefix), *extra]


def test_cli_dry_run_prints_the_plan_and_changes_nothing(world, capsys):
    assert system_cli_main(_cli(world, "--dry-run")) == 0
    out = capsys.readouterr().out
    assert "安装凭据网关服务：计划（未执行）" in out and "$ /usr/sbin/sysadminctl -addUser _agentswitchgate" in out
    assert list(world.prefix.iterdir()) == [] and (world.old / "key.priv").exists() and world.agent.exists()


def test_cli_root_install_status_update_uninstall(world, capsys, tmp_path):
    assert system_cli_main(_cli(world)) == 0
    out = capsys.readouterr().out
    assert "（--root：未执行）" in out and (world.old / "MOVED.txt").exists()
    assert system_cli_main(["system", "status", "--json", "--root", str(world.prefix), "--runtime", str(world.runtime)]) == 0
    report = json.loads(capsys.readouterr().out)
    assert report["installed"] is True and report["running"] is False and report["rpcRunning"] is False
    assert report["ownerUid"] == UID and report["proxyPort"] == 9090 and report["updateAvailable"] is False
    assert report["publicDir"] == str(world.layout.public) and "无响应" in report["error"]
    new_runtime = make_runtime(tmp_path / "bundle2" / "runtime", built="2026-10-01T00:00:00Z")
    assert system_cli_main(["system", "status", "--json", "--root", str(world.prefix), "--runtime", str(new_runtime)]) == 0
    assert json.loads(capsys.readouterr().out)["updateAvailable"] is True
    assert system_cli_main(["system", "update", "--runtime", str(new_runtime), "--port", "9191", "--root", str(world.prefix)]) == 0
    assert read_service_config(world.layout.config).runtime_version == "0.1.0+2026-10-01T00:00:00Z"
    assert system_cli_main(["system", "status", "--root", str(world.prefix)]) == 1   # text mode: not running
    assert system_cli_main(["system", "uninstall", "--root", str(world.prefix)]) == 0
    capsys.readouterr()
    assert system_cli_main(["system", "status", "--json", "--root", str(world.prefix)]) == 0
    assert json.loads(capsys.readouterr().out)["installed"] is False


def test_cli_refusals(world, capsys, monkeypatch):
    assert system_cli_main(["system", "install", "--owner-uid", "501", "--runtime", str(world.runtime), "--root", "/"]) == 2
    assert "--root" in capsys.readouterr().err
    assert system_cli_main(["system", "install", "--owner-uid", "0", "--runtime", str(world.runtime), "--root", str(world.prefix)]) == 2
    assert "不可为 root" in capsys.readouterr().err
    monkeypatch.setattr("os.geteuid", lambda: 501)
    assert system_cli_main(["system", "uninstall"]) == 2
    assert "需要管理员权限" in capsys.readouterr().err
    assert system_cli_main(["system", "update", "--runtime", str(world.runtime), "--root", str(world.prefix)]) == 2
    assert "未安装" in capsys.readouterr().err


def test_status_report_of_a_running_service(world):
    assert world.install().ok
    report = system_cli.service_status(world.layout, lambda _sock: {"proxyRunning": True}, "0.1.0+2026-09-27T00:00:00Z")
    assert report["running"] and report["rpcRunning"] and report["proxyRunning"] and report["error"] is None
    stopped = system_cli.service_status(world.layout, lambda _sock: {"proxyRunning": False}, None)
    assert not stopped["running"] and "代理未运行" in stopped["error"]


def test_gather_facts_reads_dscl(world):
    listing = {"/Users UniqueID": "root 0\n_www 70\n_x 450\nme 501\n", "/Groups PrimaryGroupID": "_x 450\n_y 451\n"}

    def runner(argv):
        return CommandResult(0, listing[f"{argv[3]} {argv[4]}"])

    facts = system_cli.gather_install_facts(world.options(), runner, simulate=False, now=datetime(2026, 9, 27))
    assert facts.account == Account(452, 452, True, True)
    assert facts.runtime_version == "0.1.0+2026-09-27T00:00:00Z" and facts.old_agent_plist == world.agent
    with pytest.raises(GateError, match="dscl"):
        system_cli.gather_install_facts(world.options(), lambda _argv: CommandResult(1), simulate=False,
                                        now=datetime(2026, 9, 27))


def system_cli_main(argv: list[str]) -> int:
    from secret_gate.cli import main

    return main(argv)


def test_tilde_means_the_owners_home_not_roots(tmp_path):
    assert system_cli.owner_path("~/.secret-gate", tmp_path / "me") == tmp_path / "me" / ".secret-gate"
    assert system_cli.owner_path("/abs/x", None) == Path("/abs/x")
    with pytest.raises(GateError, match="用户目录"):
        system_cli.owner_path("~/.secret-gate", None)
    with pytest.raises(GateError, match="绝对路径"):
        system_cli.owner_path("relative", tmp_path)
    assert system_cli._owner_home(UID).is_absolute()                       # from the user database, not $HOME
    with pytest.raises(GateError, match="不存在"):
        system_cli._owner_home(2**31 - 7)


def test_install_as_the_mac_app_runs_it_with_home_unset(world):
    """`/usr/bin/env -i PATH=… LANG=… <runtime>/python/bin/secret-gate system install … --migrate-from ~/.secret-gate`."""
    import subprocess
    import sys

    argv = [sys.executable, "-m", "secret_gate.cli", "system", "install", "--owner-uid", str(UID), "--port", "9090",
            "--runtime", str(world.runtime), "--migrate-from", "~/.secret-gate", "--user-home", str(world.user_home),
            "--root", str(world.prefix)]
    env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8",
           "PYTHONPATH": str(Path(__file__).resolve().parents[1])}
    proc = subprocess.run(argv, env=env, capture_output=True, text=True, timeout=120, check=False)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert (world.old / "MOVED.txt").exists() and "[完成]" in proc.stdout
    assert current_name(world.layout.gate) == "main"
