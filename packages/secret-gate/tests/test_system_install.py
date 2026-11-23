"""`secret-gate system install|update|rotate-key|uninstall` carried out in a temporary root (gate-service-v0 §5, §6;
gate-simple-v0 §1, §6).

Privileged commands go to a recording fake runner; the "running service" is a fake status that reads the gate
home. The login user's home is a temp dir owned by this test user with an old gate home in it, which install must
not read or change; nothing under the real ~ is touched.
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
from secret_gate.errors import GateError, TokenError
from secret_gate.keyring import keypair_info
from secret_gate.keystore import load_public_key, save_keypair
from secret_gate.policy import SecretPayload
from secret_gate.resolver import Resolver
from secret_gate.rpc_client import ServiceUnavailable
from secret_gate.service import CommandResult
from secret_gate.service_paths import (
    PROXY_LABEL,
    SERVICE_USER,
    ServiceConfig,
    SystemLayout,
    read_service_config,
)
from secret_gate.system_exec import SystemDeps, check_tree, execute, local_status
from secret_gate.system_plan import (
    Account,
    InstallFacts,
    InstallOptions,
    install_plan,
    rotate_key_plan,
    uninstall_plan,
    update_plan,
)
from secret_gate.tokens import make_token

UID = os.getuid()


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
    return make_token(public, SecretPayload.create(value=f"pw-{label}-1234", hosts=["a.example"], uses=[USE_HTTP],
                                                   label=label))


def _snapshot(root: Path) -> dict[str, tuple[int, bytes | None]]:
    return {str(p.relative_to(root)): (p.lstat().st_mode, p.read_bytes() if p.is_file() and not p.is_symlink() else None)
            for p in sorted(root.rglob("*"))}


class World:
    """A login user's home holding an old gate home, ~/.mitmproxy and an old LaunchAgent; a runtime; a temp root."""

    def __init__(self, tmp: Path) -> None:
        self.prefix = tmp / "prefix"
        self.prefix.mkdir()
        self.layout = SystemLayout(self.prefix)
        self.user_home = tmp / "user"
        self.old = self.user_home / ".secret-gate"
        old = generate_keypair()
        save_keypair(self.old, old)
        self.old_token = _token(old.public, "old/pass")
        (self.old / "exec_templates.json").write_text('{"x": {"argv": ["/bin/echo"], "env": {"V": "{SECRET}"}}}')
        (self.old / "upstream-insecure.txt").write_text("intranet.example\n")
        (self.user_home / ".mitmproxy").mkdir()
        (self.user_home / ".mitmproxy" / "mitmproxy-ca.pem").write_text("OLD CA KEY")
        agent = self.user_home / "Library" / "LaunchAgents" / "com.agentswitch.secret-gate.proxy.plist"
        agent.parent.mkdir(parents=True)
        agent.write_text("<plist/>")
        self.runtime = make_runtime(tmp / "bundle" / "runtime")

    def options(self, **changes) -> InstallOptions:
        return replace(InstallOptions(owner_uid=UID, port=9090, runtime=self.runtime), **changes)

    def facts(self, **changes) -> InstallFacts:
        return replace(InstallFacts(account=Account(450, 450, True, True), runtime_version="0.1.0+2026-09-27T00:00:00Z",
                                    installed_at="2026-09-27T01:02:03Z"), **changes)

    def deps(self, runner=None, status=None, **kw) -> SystemDeps:
        return SystemDeps(runner=runner or FakeRunner(), status=status or local_status(self.layout.gate),
                          sleep=lambda _s: None, **kw)

    def install(self, runner=None, status=None, **kw):
        return execute(install_plan(self.layout, self.options(), self.facts()), self.deps(runner, status, **kw))


@pytest.fixture
def world(tmp_path) -> World:
    return World(tmp_path)


def test_install_makes_a_fresh_key_in_the_service_home_and_leaves_the_users_home_alone(world):
    before = _snapshot(world.user_home)
    runner = FakeRunner()
    outcome = world.install(runner)
    assert outcome.ok, outcome.lines
    layout = world.layout
    assert all(not line.startswith(("[失败]", "[未执行]")) for line in outcome.lines)
    # directories and modes (§2)
    for path, mode in ((layout.root, 0o755), (layout.gate, 0o700), (layout.logs, 0o700), (layout.mitmproxy, 0o700),
                       (layout.public, 0o755), (layout.runtime, 0o755)):
        assert _mode(path) == mode, path
    # the one keypair, generated here; nothing of the old home came in
    assert sorted(p.name for p in layout.gate.iterdir()) == ["key.priv", "key.pub", "logs", "mitmproxy"]
    assert _mode(layout.gate / "key.priv") == 0o600
    with pytest.raises(TokenError):
        Resolver.from_home(layout.gate).describe(world.old_token)
    assert load_public_key(layout.gate) != load_public_key(world.old)
    # public files
    published = json.loads((layout.public / "keys.json").read_text())
    assert [(r["name"], r["current"], r["legacy"]) for r in published] == [("main", True, False)]
    assert published[0]["publicKey"] == keypair_info(layout.gate).public
    assert (layout.public / "ca.pem").read_text().startswith("-----BEGIN CERTIFICATE-----")
    assert b"PRIVATE KEY" not in (layout.public / "ca.pem").read_bytes()
    assert _mode(layout.mitmproxy / "mitmproxy-ca.pem") == 0o600
    # runtime copy
    wrapper = (layout.runtime / "bin" / "secret-gate").read_text()
    assert f"'{layout.runtime / 'python/bin/secret-gate'}'" in wrapper and _mode(layout.runtime / "bin" / "secret-gate") == 0o755
    assert os.readlink(layout.runtime / "python/bin/python3") == "python3.12"
    assert _mode(layout.runtime / "python/lib/x.py") == 0o644 and _mode(layout.runtime / "python/bin/python3.12") == 0o755
    assert not layout.runtime_staging.exists() and not layout.runtime_backup.exists()
    config = read_service_config(layout.config)
    assert config == ServiceConfig(UID, 9090, "0.1.0+2026-09-27T00:00:00Z", "2026-09-27T01:02:03Z")
    assert _mode(layout.config) == 0o644 and _mode(layout.plist("com.agentswitch.gate.rpc")) == 0o644
    # privileged commands, in order; none names the login user's home or its launchd domain
    assert runner.calls[0][0] == "/usr/sbin/dseditgroup" and runner.calls[1][0] == "/usr/sbin/sysadminctl"
    assert ("/usr/sbin/chown", "-R", f"{SERVICE_USER}:{SERVICE_USER}", str(layout.gate)) in runner.calls
    assert runner.calls[-1] == ("/bin/launchctl", "bootstrap", "system", str(layout.plist("com.agentswitch.gate.proxy")))
    assert not any(str(world.user_home) in " ".join(call) or "gui/" in " ".join(call) for call in runner.calls)
    # the login user's side: byte for byte as it was
    assert _snapshot(world.user_home) == before
    assert not any(str(world.user_home) in line for line in outcome.lines)


def test_a_failing_command_stops_the_install_and_says_what_was_not_done(world):
    outcome = world.install(FakeRunner(fail="dseditgroup"))
    assert not outcome.ok
    failed = [line for line in outcome.lines if line.startswith("[失败]")]
    assert failed == ["[失败] 1. 创建服务账户 _agentswitchgate：/usr/sbin/dseditgroup -o create -i 450 "
                      "-r 'AgentSwitch Gate' _agentswitchgate 失败（1）：dseditgroup: simulated failure"]
    assert sum(line.startswith("[未执行]") for line in outcome.lines) == len(install_plan(world.layout, world.options(), world.facts()).steps) - 1
    assert not world.layout.root.exists()


def test_the_wait_fails_when_the_service_never_answers(world):
    def silent(_socket):
        raise ServiceUnavailable("凭据网关服务无响应（连接被关闭）")

    outcome = world.install(status=silent, wait_tries=3)
    assert not outcome.ok
    assert any(line.startswith("[失败]") and "等待服务响应" in line and "无响应" in line for line in outcome.lines)


def test_a_proxy_that_did_not_start_fails_the_wait(world):
    def no_proxy(_socket):
        return {**local_status(world.layout.gate)(_socket), "proxyRunning": False}

    outcome = world.install(status=no_proxy, wait_tries=2)
    assert not outcome.ok and any("代理未运行" in line for line in outcome.lines)


def test_the_wait_fails_when_the_service_reports_another_key(world):
    def other_key(_socket):
        status = local_status(world.layout.gate)(_socket)
        return {**status, "keys": [{**status["keys"][0], "publicKey": "B" * 43}]}

    outcome = world.install(status=other_key, wait_tries=2)
    assert not outcome.ok and any("服务列出的密钥与文件不一致" in line for line in outcome.lines)


def test_install_again_keeps_the_key(world):
    assert world.install().ok
    key = keypair_info(world.layout.gate).public
    again = execute(install_plan(world.layout, world.options(), world.facts(account=Account(450, 450, False, False))),
                    world.deps())
    assert again.ok, again.lines
    assert keypair_info(world.layout.gate).public == key
    assert any("已有密钥，保留" in line for line in again.lines)


def test_rotate_key_replaces_the_key_republishes_and_signals_the_proxy(world):
    assert world.install().ok
    old_public = load_public_key(world.layout.gate)
    old_token = _token(old_public, "site/pass")
    runner = FakeRunner()
    outcome = execute(rotate_key_plan(world.layout), world.deps(runner))
    assert outcome.ok, outcome.lines
    new_public = load_public_key(world.layout.gate)
    assert new_public != old_public and _mode(world.layout.gate / "key.priv") == 0o600
    published = json.loads((world.layout.public / "keys.json").read_text())
    assert [r["publicKey"] for r in published] == [keypair_info(world.layout.gate).public]
    assert ("/bin/launchctl", "kill", "SIGHUP", f"system/{PROXY_LABEL}") in runner.calls
    assert ("/usr/sbin/chown", "-R", f"{SERVICE_USER}:{SERVICE_USER}", str(world.layout.gate)) in runner.calls
    with pytest.raises(TokenError):                                        # sealed to the old key: gone for good
        Resolver.from_home(world.layout.gate).describe(old_token)
    assert any("旧密文全部失效" in line for line in outcome.lines)


def test_rotate_key_never_writes_through_a_planted_link(world, tmp_path):
    assert world.install().ok
    victim = tmp_path / "victim"
    victim.write_text("keep me")
    (world.layout.gate / "key.pub").unlink()
    (world.layout.gate / "key.pub").symlink_to(victim)
    outcome = execute(rotate_key_plan(world.layout), world.deps())
    assert not outcome.ok and any("符号链接" in line for line in outcome.lines)
    assert victim.read_text() == "keep me"


def test_a_runtime_symlink_leaving_the_copy_is_refused(world, tmp_path):
    (world.runtime / "python" / "lib" / "escape").symlink_to(tmp_path)
    outcome = world.install()
    assert not outcome.ok and any("符号链接指向副本之外" in line for line in outcome.lines)


def _secret_dir(tmp_path: Path) -> Path:
    """Stands in for the gate home: what root could read and the login user could not."""
    secret = tmp_path / "gate-home"
    (secret / "python" / "bin").mkdir(parents=True)
    (secret / "python" / "bin" / "secret-gate").write_text("#!/bin/sh\n")
    (secret / "python" / "bin" / "secret-gate").chmod(0o700)
    (secret / "key.priv").write_text("PRIVATE")
    (secret / "key.priv").chmod(0o600)
    return secret


@pytest.mark.parametrize("item", ["python", "secret-gate"])
def test_a_top_level_runtime_item_that_is_a_symlink_is_never_followed(world, tmp_path, item):
    secret = _secret_dir(tmp_path)
    moved = world.runtime / f"{item}.real"
    (world.runtime / item).rename(moved)
    (world.runtime / item).symlink_to(secret if item == "secret-gate" else secret / "python")
    outcome = world.install()
    assert not outcome.ok and any(f"运行时中的 {item} 不是目录" in line for line in outcome.lines)
    assert not world.layout.runtime_staging.exists() or not any(
        p.name == "key.priv" for p in world.layout.runtime_staging.rglob("*"))
    assert _mode(secret / "key.priv") == 0o600                              # nothing outside the copy was chmodded


def test_a_symlinked_versions_file_is_never_read(world, tmp_path):
    secret = tmp_path / "root-only"
    secret.write_text("secret-gate=leaked-line\n")
    (world.runtime / "VERSIONS").unlink()
    (world.runtime / "VERSIONS").symlink_to(secret)
    with pytest.raises(GateError, match="VERSIONS 是符号链接"):
        system_cli.gather_install_facts(world.options(), FakeRunner(), simulate=True, now=datetime(2026, 9, 27))
    outcome = execute(install_plan(world.layout, world.options(), world.facts()), world.deps())
    assert not outcome.ok and any("VERSIONS 是符号链接" in line for line in outcome.lines)
    assert not world.layout.config.exists() or "leaked" not in world.layout.config.read_text()


def test_runtime_entries_of_another_owner_or_odd_types_are_refused(world, tmp_path, monkeypatch):
    os.mkfifo(world.runtime / "python" / "lib" / "pipe")
    outcome = world.install()
    assert not outcome.ok and any("pipe 不是普通文件、目录或符号链接" in line for line in outcome.lines)
    (world.runtime / "python" / "lib" / "pipe").unlink()
    # A hard link to a file root can read but the user cannot keeps that file's owner: refused, never copied.
    real_stat, victim = os.stat, world.runtime / "python" / "lib" / "x.py"

    def stat_as_root_owned(path, *a, **kw):
        info = real_stat(path, *a, **kw)
        if (path == "x.py" or path == victim) and info.st_uid == UID:
            return os.stat_result((info.st_mode, info.st_ino, info.st_dev, info.st_nlink, 0, *info[5:]))
        return info
    monkeypatch.setattr("secret_gate.system_exec.os.stat", stat_as_root_owned)
    outcome = world.install()
    assert not outcome.ok and any("x.py 不属于 App 包的属主" in line for line in outcome.lines)


def test_check_tree_only_verifies(tmp_path):
    tree = tmp_path / "tree"
    tree.mkdir(mode=0o755)
    tree.chmod(0o755)
    (tree / "f").write_text("x")
    (tree / "f").chmod(0o600)
    with pytest.raises(GateError, match="文件权限不对"):
        check_tree(tree)
    assert _mode(tree / "f") == 0o600
    (tree / "f").chmod(0o644)
    (tree / "abs").symlink_to(tree / "f")                                   # absolute, even if it points inside
    with pytest.raises(GateError, match="符号链接指向副本之外"):
        check_tree(tree)


def test_update_replaces_the_runtime_and_restarts(world, tmp_path):
    assert world.install().ok
    key = keypair_info(world.layout.gate).public
    new_runtime = make_runtime(tmp_path / "bundle2" / "runtime", built="2026-10-01T00:00:00Z")
    config = replace(read_service_config(world.layout.config), runtime_version="0.1.0+2026-10-01T00:00:00Z", proxy_port=9191)
    runner = FakeRunner()
    outcome = execute(update_plan(world.layout, new_runtime, config), world.deps(runner))
    assert outcome.ok, outcome.lines
    assert "built=2026-10-01" in (world.layout.runtime / "VERSIONS").read_text()
    assert read_service_config(world.layout.config).proxy_port == 9191
    assert b"9191" in world.layout.plist("com.agentswitch.gate.proxy").read_bytes()
    assert [c[1] for c in runner.calls if c[0] == "/bin/launchctl"] == ["bootout", "bootout", "bootstrap", "bootstrap"]
    assert keypair_info(world.layout.gate).public == key


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
            "--root", str(world.prefix), *extra]


def test_cli_dry_run_prints_the_plan_and_changes_nothing(world, capsys):
    assert system_cli_main(_cli(world, "--dry-run")) == 0
    out = capsys.readouterr().out
    assert "安装凭据网关服务：计划（未执行）" in out and "$ /usr/sbin/sysadminctl -addUser _agentswitchgate" in out
    assert "生成密钥" in out and "迁移" not in out
    assert list(world.prefix.iterdir()) == []


def test_cli_old_migration_flags_are_accepted_and_ignored_but_import_config_is_gone(world, capsys):
    before = _snapshot(world.user_home)
    assert system_cli_main(_cli(world, "--migrate-from", str(world.old), "--user-home", str(world.user_home))) == 0
    assert _snapshot(world.user_home) == before
    assert str(world.user_home) not in capsys.readouterr().out
    with pytest.raises(SystemExit):
        system_cli_main(_cli(world, "--import-config"))


def test_cli_root_install_status_rotate_update_uninstall(world, capsys, tmp_path):
    assert system_cli_main(["system", "rotate-key", "--root", str(world.prefix)]) == 2
    assert "未安装" in capsys.readouterr().err                              # nothing to rotate before install
    assert system_cli_main(_cli(world)) == 0
    out = capsys.readouterr().out
    assert "（--root：未执行）" in out
    assert system_cli_main(["system", "status", "--json", "--root", str(world.prefix), "--runtime", str(world.runtime)]) == 0
    report = json.loads(capsys.readouterr().out)
    assert report["installed"] is True and report["running"] is False and report["rpcRunning"] is False
    assert report["ownerUid"] == UID and report["proxyPort"] == 9090 and report["updateAvailable"] is False
    assert report["publicDir"] == str(world.layout.public) and "无响应" in report["error"]
    key = keypair_info(world.layout.gate).public
    assert system_cli_main(["system", "rotate-key", "--root", str(world.prefix), "--dry-run"]) == 0
    assert "更换凭据网关密钥：计划（未执行）" in capsys.readouterr().out and keypair_info(world.layout.gate).public == key
    assert system_cli_main(["system", "rotate-key", "--root", str(world.prefix)]) == 0
    out = capsys.readouterr().out
    assert "$ /bin/launchctl kill SIGHUP system/com.agentswitch.gate.proxy（--root：未执行）" in out
    assert keypair_info(world.layout.gate).public != key
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
    assert system_cli_main(["system", "rotate-key"]) == 2
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
    assert facts.runtime_version == "0.1.0+2026-09-27T00:00:00Z"
    with pytest.raises(GateError, match="dscl"):
        system_cli.gather_install_facts(world.options(), lambda _argv: CommandResult(1), simulate=False,
                                        now=datetime(2026, 9, 27))


def system_cli_main(argv: list[str]) -> int:
    from secret_gate.cli import main

    return main(argv)


def test_install_as_the_mac_app_runs_it_with_home_unset(world):
    """`/usr/bin/env -i PATH=… LANG=… <runtime>/python/bin/secret-gate system install …` (an App that still passes
    `--migrate-from ~/.secret-gate` keeps working; the flag is ignored)."""
    import subprocess
    import sys

    before = _snapshot(world.user_home)
    argv = [sys.executable, "-m", "secret_gate.cli", "system", "install", "--owner-uid", str(UID), "--port", "9090",
            "--runtime", str(world.runtime), "--migrate-from", "~/.secret-gate", "--root", str(world.prefix)]
    env = {"PATH": "/usr/bin:/bin:/usr/sbin:/sbin", "LANG": "en_US.UTF-8",
           "PYTHONPATH": str(Path(__file__).resolve().parents[1])}
    proc = subprocess.run(argv, env=env, capture_output=True, text=True, timeout=120, check=False)
    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "[完成]" in proc.stdout and keypair_info(world.layout.gate) is not None
    assert _snapshot(world.user_home) == before
