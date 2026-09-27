"""`secret-gate system` plans as data (gate-service-v0 §2, §4, §5, §6): accounts, commands, order, plists.

Nothing here executes anything: account creation, chown and launchctl are asserted as the commands a plan holds.
"""

from __future__ import annotations

import plistlib
from pathlib import Path

import pytest

from secret_gate.errors import ValidationError
from secret_gate.service_paths import (
    PROXY_LABEL,
    RPC_LABEL,
    SERVICE_USER,
    ServiceConfig,
    SystemLayout,
)
from secret_gate.system_plan import (
    Account,
    CleanupUserHome,
    CreateCurrentKey,
    DeleteOldCA,
    GenerateCA,
    InstallFacts,
    InstallOptions,
    MigrateFiles,
    MigrateKeys,
    Publish,
    RemovePath,
    RemoveUserFile,
    Run,
    StageRuntime,
    SwapRuntime,
    WaitForService,
    choose_account,
    install_plan,
    plists,
    render,
    runtime_version,
    uninstall_plan,
    update_plan,
)

PREFIX = Path("/tmp/sg-prefix")
LAYOUT = SystemLayout(PREFIX)
ROOT = PREFIX / "Library/Application Support/AgentSwitch"
OPTIONS = InstallOptions(owner_uid=501, port=9090, runtime=Path("/Apps/AgentSwitch.app/Contents/Resources/runtime"),
                         migrate_from=Path("/Users/me/.secret-gate"), user_home=Path("/Users/me"))
FACTS = InstallFacts(account=Account(450, 450, True, True), runtime_version="0.1.0+2026-09-27T00:00:00Z",
                     installed_at="2026-09-27T01:02:03Z",
                     old_agent_plist=Path("/Users/me/Library/LaunchAgents/com.agentswitch.secret-gate.proxy.plist"))


def _ops(plan):
    return [op for step in plan.steps for op in step.ops]


def _argvs(plan):
    return [op.argv for op in _ops(plan) if isinstance(op, Run)]


def _index(ops, kind):
    return next(i for i, op in enumerate(ops) if isinstance(op, kind))


# -- account ------------------------------------------------------------------------------------

def test_first_id_free_as_both_user_and_group():
    assert choose_account({}, {}) == Account(450, 450, True, True)
    assert choose_account({"_a": 450}, {"_b": 451}) == Account(452, 452, True, True)
    taken = {f"u{n}": n for n in range(450, 500)}
    with pytest.raises(ValidationError, match="无空闲"):
        choose_account(taken, {})


def test_an_existing_account_is_reused_whatever_its_ids():
    # 2026-09-27, first real install: sysadminctl ignored -UID 450 and made the account 502, and dscl may not edit
    # user records even as root (eDSPermissionError). Nothing depends on the number, so the account is reused as is.
    assert choose_account({SERVICE_USER: 502}, {SERVICE_USER: 450}) == Account(502, 450, False, False)
    assert choose_account({SERVICE_USER: 460}, {SERVICE_USER: 461}) == Account(460, 461, False, False)
    assert choose_account({SERVICE_USER: 460}, {"x": 450}) == Account(460, 451, True, False)
    assert choose_account({}, {SERVICE_USER: 470}) == Account(470, 470, False, True)


def test_account_commands():
    argvs = _argvs(install_plan(LAYOUT, OPTIONS, FACTS))
    assert argvs[0] == ("/usr/sbin/dseditgroup", "-o", "create", "-i", "450", "-r", "AgentSwitch Gate", SERVICE_USER)
    assert argvs[1] == ("/usr/sbin/sysadminctl", "-addUser", SERVICE_USER, "-fullName", "AgentSwitch Gate", "-UID", "450", "-GID", "450",
                        "-shell", "/usr/bin/false", "-home", "/var/empty", "-roleAccount")
    read = ("/usr/bin/dscl", ".", "-read", f"/Users/{SERVICE_USER}", "UserShell")
    assert argvs[2] == read
    verify = next(op for op in _ops(install_plan(LAYOUT, OPTIONS, FACTS)) if isinstance(op, Run) and op.argv == read)
    assert verify.expect == "UserShell: /usr/bin/false"                     # whoever made it, nobody logs in as it
    existing = install_plan(LAYOUT, OPTIONS, InstallFacts(Account(502, 450, False, False), "v", "t"))
    assert _argvs(existing)[0] == read
    assert not any(Path(a[0]).name in ("sysadminctl", "dseditgroup") for a in _argvs(existing))
    assert not any("UniqueID" in a or "PrimaryGroupID" in a for a in _argvs(existing))


# -- install ------------------------------------------------------------------------------------

def test_install_plan_orders_the_steps_so_no_key_is_ever_lost():
    ops = _ops(install_plan(LAYOUT, OPTIONS, FACTS))
    order = [_index(ops, kind) for kind in (StageRuntime, MigrateKeys, CreateCurrentKey, MigrateFiles, GenerateCA, Publish)]
    assert order == sorted(order)
    wait, cleanup = _index(ops, WaitForService), _index(ops, CleanupUserHome)
    assert _index(ops, MigrateKeys) < wait < cleanup                       # originals go only after the service answered
    assert cleanup >= len(ops) - 2 and isinstance(ops[-1], DeleteOldCA)    # the very end
    stop = next(i for i, op in enumerate(ops) if isinstance(op, Run) and op.argv[:2] == ("/bin/launchctl", "bootout")
                and op.argv[2].startswith("system/"))
    start = next(i for i, op in enumerate(ops) if isinstance(op, Run) and op.argv[:2] == ("/bin/launchctl", "bootstrap"))
    assert stop < _index(ops, SwapRuntime) < start < wait
    assert _index(ops, RemoveUserFile) < start                             # the old LaunchAgent is gone before the new proxy binds


def test_install_plan_commands_and_paths():
    plan = install_plan(LAYOUT, OPTIONS, FACTS)
    argvs = _argvs(plan)
    assert ("/usr/sbin/chown", "-R", f"{SERVICE_USER}:{SERVICE_USER}", str(ROOT / "gate")) in argvs
    assert argvs.index(("/bin/chmod", "-R", "go-rwx", str(ROOT / "gate"))) < argvs.index(("/usr/sbin/chown", "-R", f"{SERVICE_USER}:{SERVICE_USER}", str(ROOT / "gate")))
    assert ("/usr/sbin/chown", "-R", f"{SERVICE_USER}:{SERVICE_USER}", str(ROOT / "gate-public")) in argvs
    assert ("/usr/sbin/chown", "-R", "root:wheel", str(ROOT / "runtime.new")) in argvs
    assert ("/usr/sbin/chown", "root:wheel", str(ROOT / "gate-service.json")) in argvs
    daemons = PREFIX / "Library/LaunchDaemons"
    assert ("/bin/launchctl", "bootstrap", "system", str(daemons / f"{RPC_LABEL}.plist")) in argvs
    assert ("/bin/launchctl", "bootstrap", "system", str(daemons / f"{PROXY_LABEL}.plist")) in argvs
    assert ("/bin/launchctl", "bootout", "gui/501/com.agentswitch.secret-gate.proxy") in argvs
    every_path = " ".join(op.describe() for op in _ops(plan))
    assert "/Library/Application Support" not in every_path.replace(str(PREFIX / "Library"), "")   # all under --root
    config = next(op for op in _ops(plan) if getattr(op, "path", None) == ROOT / "gate-service.json")
    import json

    assert json.loads(config.data) == {"ownerUid": 501, "proxyPort": 9090, "runtimeVersion": "0.1.0+2026-09-27T00:00:00Z",
                                       "installedAt": "2026-09-27T01:02:03Z"}
    assert config.mode == 0o644


def test_install_without_migration_or_user_home():
    plan = install_plan(LAYOUT, InstallOptions(owner_uid=501, port=8080, runtime=Path("/r")),
                        InstallFacts(Account(450, 450, True, True), "v", "t"))
    kinds = {type(op) for op in _ops(plan)}
    assert not kinds & {MigrateKeys, MigrateFiles, CleanupUserHome, DeleteOldCA, RemoveUserFile}
    assert CreateCurrentKey in kinds and WaitForService in kinds


def test_launch_daemon_plists():
    files = plists(LAYOUT, 9090)
    proxy, rpc = plistlib.loads(files[PROXY_LABEL]), plistlib.loads(files[RPC_LABEL])
    wrapper = str(ROOT / "runtime/bin/secret-gate")
    assert proxy["ProgramArguments"] == [wrapper, "proxy", "--port", "9090", "--confdir", str(ROOT / "gate/mitmproxy")]
    assert rpc["ProgramArguments"] == [wrapper, "rpc"]
    for data in (proxy, rpc):
        assert data["UserName"] == data["GroupName"] == SERVICE_USER
        assert data["EnvironmentVariables"] == {
            "SECRET_GATE_HOME": str(ROOT / "gate"), "HOME": str(ROOT / "gate"), "SECRET_GATE_PUBLIC": str(ROOT / "gate-public"),
            "PATH": f"{ROOT / 'runtime/python/bin'}:/usr/bin:/bin:/usr/sbin:/sbin"}
        assert data["Umask"] == 0o077 and data["RunAtLoad"] is True and data["KeepAlive"] is True
        assert data["StandardOutPath"] == data["StandardErrorPath"]
        assert data["StandardOutPath"].startswith(str(ROOT / "gate/logs/"))
    assert proxy["StandardOutPath"].endswith("proxy.log") and rpc["StandardOutPath"].endswith("rpc.log")


def test_runtime_version():
    assert runtime_version("node=24\nsecret-gate=0.1.0\nbuilt=2026-09-27T00:00:00Z\n") == "0.1.0+2026-09-27T00:00:00Z"
    assert runtime_version("secret-gate=0.1.0\n") == "0.1.0"
    with pytest.raises(ValidationError, match="VERSIONS"):
        runtime_version("node=24\n")


# -- update and uninstall ----------------------------------------------------------------------

def test_update_plan_swaps_the_runtime_and_keeps_data():
    config = ServiceConfig(owner_uid=501, proxy_port=9191, runtime_version="0.2.0", installed_at="t")
    plan = update_plan(LAYOUT, Path("/new/runtime"), config)
    ops = _ops(plan)
    kinds = {type(op) for op in ops}
    assert not kinds & {MigrateKeys, MigrateFiles, CreateCurrentKey, GenerateCA, CleanupUserHome}
    assert not any(Path(a[0]).name in ("sysadminctl", "dseditgroup", "dscl") for a in _argvs(plan))
    assert _index(ops, StageRuntime) < _index(ops, SwapRuntime) < _index(ops, WaitForService)
    proxy = next(op for op in ops if getattr(op, "path", None) == LAYOUT.plist(PROXY_LABEL))
    assert "9191" in plistlib.loads(proxy.data)["ProgramArguments"]


def test_uninstall_keeps_keys_and_account_unless_asked():
    keep = uninstall_plan(LAYOUT, delete_keys=False)
    removed = {op.path for op in _ops(keep) if isinstance(op, RemovePath)}
    assert LAYOUT.gate not in removed
    assert {LAYOUT.plist(RPC_LABEL), LAYOUT.plist(PROXY_LABEL), LAYOUT.runtime, LAYOUT.public, LAYOUT.config} <= removed
    assert all(a[0] == "/bin/launchctl" for a in _argvs(keep))                  # the account stays
    purge = uninstall_plan(LAYOUT, delete_keys=True)
    assert LAYOUT.gate in {op.path for op in _ops(purge) if isinstance(op, RemovePath)}
    assert "已有密文将全部无法解开" in purge.steps[-1].title


def test_render_lists_every_step_and_command():
    lines = render(install_plan(LAYOUT, OPTIONS, FACTS))
    assert lines[0] == "安装凭据网关服务：计划（未执行）"
    assert any(line.startswith("1. 创建服务账户 _agentswitchgate") for line in lines)
    assert any("$ /usr/sbin/sysadminctl -addUser _agentswitchgate" in line for line in lines)
    assert any("launchctl bootstrap system" in line for line in lines)
