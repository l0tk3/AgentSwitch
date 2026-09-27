"""`secret-gate system install|update|uninstall`: the plan, as pure data (gate-service-v0 §2, §4, §5).

A plan is a list of steps; a step is a list of operations. Building a plan reads nothing and changes nothing:
facts about the machine (free UIDs, the runtime's version, ...) come in as arguments, so the plan can be
printed (`--dry-run`) and asserted in tests. system_exec.py carries it out; every privileged command (dscl,
dseditgroup, sysadminctl, chown, launchctl) is a `Run` that goes through one injectable runner.

Order matters for the keys: originals in the login user's home are deleted only in the last step, after the
running service reported the migrated keys (`WaitForService`), and only where an identical copy exists.
"""

from __future__ import annotations

import plistlib
from dataclasses import dataclass
from pathlib import Path

from .errors import ValidationError
from .service import SERVICE_LABEL as OLD_AGENT_LABEL
from .service_paths import (
    PROXY_LABEL,
    RPC_LABEL,
    SERVICE_FULL_NAME,
    SERVICE_LABELS,
    SERVICE_USER,
    ServiceConfig,
    SystemLayout,
)
from .system_ops import (
    CHMOD,
    CHOWN,
    DSCL,
    DSEDITGROUP,
    LAUNCHCTL,
    NOT_LOADED_OK,
    SYSADMINCTL,
    CleanupUserHome,
    CreateCurrentKey,
    DeleteOldCA,
    GenerateCA,
    MakeDir,
    MigrateFiles,
    MigrateKeys,
    Op,
    Plan,
    Publish,
    RemovePath,
    RemoveUserFile,
    Run,
    StageRuntime,
    Step,
    SwapRuntime,
    WaitForService,
    WriteFile,
)

ROLE_ID_RANGE = range(450, 500)
SYSTEM_PATH = ("/usr/bin", "/bin", "/usr/sbin", "/sbin")
NEW_KEY_NAME = "main"
ROOT_OWNER = "root:wheel"
PLIST_MODE = 0o644
CONFIG_MODE = 0o644
PRIVATE_DIR_MODE = 0o700
PUBLIC_DIR_MODE = 0o755
PROCESS_UMASK = 0o077
# -- facts and options ---------------------------------------------------------------------------

@dataclass(frozen=True)
class Account:
    """The service account and its group. `uid`/`gid` are what exists, or the ids asked for when creating; only the
    names matter afterwards (files are chowned by name, launchd runs the services by name)."""

    uid: int
    gid: int
    create_group: bool
    create_user: bool


def choose_account(users: dict[str, int], groups: dict[str, int]) -> Account:
    """Reuse `_agentswitchgate` and its group whatever ids they have; for a missing one ask for the first id in
    450–499 that no user and no group holds. sysadminctl may still give the user another UID (macOS 27 made it 502,
    2026-09-27), and user records cannot be edited afterwards (dscl answers eDSPermissionError even as root)."""
    used = set(users.values()) | set(groups.values())
    free = [n for n in ROLE_ID_RANGE if n not in used]
    uid, gid = users.get(SERVICE_USER), groups.get(SERVICE_USER)
    if (uid is None or gid is None) and not free:
        raise ValidationError("450–499 中无空闲的 ID，无法创建服务账户")
    if gid is None:
        gid = free[0]
    if uid is None:
        uid = gid if gid not in set(users.values()) else next(n for n in free if n != gid) if len(free) > 1 else free[0]
    return Account(uid, gid, create_group=SERVICE_USER not in groups, create_user=SERVICE_USER not in users)


@dataclass(frozen=True)
class InstallOptions:
    owner_uid: int
    port: int
    runtime: Path
    migrate_from: Path | None = None
    user_home: Path | None = None  # the owner's home: old ~/.mitmproxy CA key, old LaunchAgent


@dataclass(frozen=True)
class InstallFacts:
    account: Account
    runtime_version: str
    installed_at: str
    old_agent_plist: Path | None = None  # present in the owner's ~/Library/LaunchAgents


def runtime_version(versions_text: str) -> str:
    """`<secret-gate version>+<build time>` from the runtime's VERSIONS file (build-app.sh)."""
    fields = dict(line.split("=", 1) for line in versions_text.splitlines() if "=" in line)
    gate = fields.get("secret-gate", "").strip()
    if not gate:
        raise ValidationError("运行时的 VERSIONS 文件缺少 secret-gate 版本")
    built = fields.get("built", "").strip()
    return f"{gate}+{built}" if built else gate


# -- plists --------------------------------------------------------------------------------------

def daemon_plist(layout: SystemLayout, label: str, args: tuple[str, ...], log_name: str) -> dict:
    log = str(layout.logs / f"{log_name}.log")
    return {
        "Label": label,
        "ProgramArguments": [str(layout.wrapper), *args],
        "UserName": SERVICE_USER,
        "GroupName": SERVICE_USER,
        "EnvironmentVariables": {
            "SECRET_GATE_HOME": str(layout.gate),
            "HOME": str(layout.gate),
            "SECRET_GATE_PUBLIC": str(layout.public),
            "PATH": ":".join((str(layout.runtime / "python" / "bin"), *SYSTEM_PATH)),
        },
        "WorkingDirectory": str(layout.gate),
        "Umask": PROCESS_UMASK,
        "RunAtLoad": True,
        "KeepAlive": True,
        "ProcessType": "Background",
        "StandardOutPath": log,
        "StandardErrorPath": log,
    }


def plists(layout: SystemLayout, port: int) -> dict[str, bytes]:
    proxy = daemon_plist(layout, PROXY_LABEL, ("proxy", "--port", str(port), "--confdir", str(layout.mitmproxy)), "proxy")
    rpc = daemon_plist(layout, RPC_LABEL, ("rpc",), "rpc")
    return {label: plistlib.dumps(data, fmt=plistlib.FMT_XML, sort_keys=True)
            for label, data in ((RPC_LABEL, rpc), (PROXY_LABEL, proxy))}


def moved_text(layout: SystemLayout, at: str) -> str:
    return (
        "凭据网关已改为系统服务（docs/gate-service-v0.md）。本目录原有的内容已迁移：\n"
        f"- 密钥：{layout.gate}/keys/legacy/（仅解密，不再作为当前密钥）\n"
        f"- 短引用库、exec_templates.json、upstream-insecure.txt、screenshot-mask.json：{layout.gate}/\n"
        f"- 公钥列表与 CA 证书：{layout.public}/keys.json、{layout.public}/ca.pem\n"
        f"这些文件归服务账户 {SERVICE_USER} 所有，修改需要管理员权限；请在 Mac 应用里操作。\n"
        f"迁移时间：{at}\n"
    )


# -- plans ---------------------------------------------------------------------------------------

def _chown(owner: str, *paths: Path, recursive: bool = False) -> Run:
    return Run((CHOWN, *(("-R",) if recursive else ()), owner, *map(str, paths)))


def _stop(layout: SystemLayout) -> Step:
    return Step("停止服务", tuple(Run((LAUNCHCTL, "bootout", f"system/{label}"), tolerate=NOT_LOADED_OK)
                              for label in SERVICE_LABELS))


def _start(layout: SystemLayout) -> Step:
    return Step("启动服务", tuple(Run((LAUNCHCTL, "bootstrap", "system", str(layout.plist(label))), retries=3)
                              for label in SERVICE_LABELS))


def _write_plists(layout: SystemLayout, port: int) -> Step:
    files = plists(layout, port)
    return Step("写入 LaunchDaemon", (
        MakeDir(layout.launch_daemons, PUBLIC_DIR_MODE),
        *(WriteFile(layout.plist(label), data, PLIST_MODE) for label, data in files.items()),
        _chown(ROOT_OWNER, *(layout.plist(label) for label in files)),
    ))


def _config_file(layout: SystemLayout, config: ServiceConfig) -> WriteFile:
    import json

    return WriteFile(layout.config, (json.dumps(config.to_json(), indent=1) + "\n").encode(), CONFIG_MODE)


def _account_step(account: Account) -> Step:
    ops: list[Op] = []
    if account.create_group:
        ops.append(Run((DSEDITGROUP, "-o", "create", "-i", str(account.gid), "-r", SERVICE_FULL_NAME, SERVICE_USER)))
    if account.create_user:
        # sysadminctl is what may still write user records on current macOS; the UID it gives does not matter below.
        ops.append(Run((SYSADMINCTL, "-addUser", SERVICE_USER, "-fullName", SERVICE_FULL_NAME, "-UID", str(account.uid),
                        "-GID", str(account.gid), "-shell", "/usr/bin/false", "-home", "/var/empty", "-roleAccount")))
    # Whatever made it, the account must be one nobody can log in as.
    ops.append(Run((DSCL, ".", "-read", f"/Users/{SERVICE_USER}", "UserShell"), expect="UserShell: /usr/bin/false"))
    verb = "创建" if account.create_user else "确认"
    return Step(f"{verb}服务账户 {SERVICE_USER}", tuple(ops))


def install_plan(layout: SystemLayout, options: InstallOptions, facts: InstallFacts) -> Plan:
    account, owner = facts.account, f"{SERVICE_USER}:{SERVICE_USER}"
    config = ServiceConfig(owner_uid=options.owner_uid, proxy_port=options.port,
                           runtime_version=facts.runtime_version, installed_at=facts.installed_at)
    source = options.migrate_from
    steps = [
        _account_step(account),
        Step("创建目录", (
            MakeDir(layout.root, PUBLIC_DIR_MODE), _chown(ROOT_OWNER, layout.root),
            *(MakeDir(p, PRIVATE_DIR_MODE) for p in (layout.gate, layout.gate / "keys", layout.gate / "keys" / "legacy",
                                                     layout.logs, layout.mitmproxy)),
            MakeDir(layout.public, PUBLIC_DIR_MODE),
        )),
        Step("复制运行时", (StageRuntime(options.runtime, layout),
                          _chown(ROOT_OWNER, layout.runtime_staging, recursive=True))),
        Step("写入 gate-service.json", (_config_file(layout, config), _chown(ROOT_OWNER, layout.config))),
    ]
    if source is not None:
        steps.append(Step("迁移旧密钥（仅解密）", (MigrateKeys(source, options.owner_uid, layout.gate),)))
    steps.append(Step(f"新建当前密钥 {NEW_KEY_NAME}", (CreateCurrentKey(layout.gate, NEW_KEY_NAME),)))
    if source is not None:
        steps.append(Step("迁移短引用库、可信配置和日志", (MigrateFiles(source, options.owner_uid, layout.gate),)))
    steps += [
        Step("生成 mitmproxy CA", (GenerateCA(layout.mitmproxy),)),
        Step("发布 keys.json 和 ca.pem", (Publish(layout),)),
        Step("设置属主和权限", (Run((CHMOD, "-R", "go-rwx", str(layout.gate))),   # 0700 / 0600 whatever root's umask was
                            _chown(owner, layout.gate, recursive=True), _chown(owner, layout.public, recursive=True))),
    ]
    if facts.old_agent_plist is not None:
        steps.append(Step("停用用户级网关服务（旧 LaunchAgent）", (
            Run((LAUNCHCTL, "bootout", f"gui/{options.owner_uid}/{OLD_AGENT_LABEL}"), tolerate=NOT_LOADED_OK),
            RemoveUserFile(facts.old_agent_plist, options.owner_uid),
        )))
    steps += [
        _write_plists(layout, options.port),
        _stop(layout),
        Step("启用新运行时", (SwapRuntime(layout),)),
        _start(layout),
        Step("等待服务响应", (WaitForService(layout),)),
        Step("删除旧运行时", (RemovePath(layout.runtime_backup),)),
    ]
    cleanup: list[Op] = []
    if source is not None:
        cleanup.append(CleanupUserHome(source, options.owner_uid, layout.gate, moved_text(layout, facts.installed_at)))
    if options.user_home is not None:
        cleanup.append(DeleteOldCA(options.user_home / ".mitmproxy", options.owner_uid))
    if cleanup:
        steps.append(Step("清理用户目录中的旧文件", tuple(cleanup)))
    return Plan("安装凭据网关服务", tuple(steps))


def update_plan(layout: SystemLayout, runtime: Path, config: ServiceConfig) -> Plan:
    """Swap the runtime and restart both services; keys and data stay. `config` is the new gate-service.json."""
    return Plan("更新凭据网关服务", (
        Step("复制运行时", (StageRuntime(runtime, layout), _chown(ROOT_OWNER, layout.runtime_staging, recursive=True))),
        Step("写入 gate-service.json", (_config_file(layout, config), _chown(ROOT_OWNER, layout.config))),
        _write_plists(layout, config.proxy_port),
        _stop(layout),
        Step("启用新运行时", (SwapRuntime(layout),)),
        _start(layout),
        Step("等待服务响应", (WaitForService(layout),)),
        Step("删除旧运行时", (RemovePath(layout.runtime_backup),)),
    ))


def uninstall_plan(layout: SystemLayout, *, delete_keys: bool) -> Plan:
    """Services, LaunchDaemons, runtime and public files go; the gate home (keys, data) stays unless asked,
    the service account always stays."""
    steps = [
        _stop(layout),
        Step("删除 LaunchDaemon", tuple(RemovePath(layout.plist(label)) for label in SERVICE_LABELS)),
        Step("删除运行时", tuple(RemovePath(p) for p in (layout.runtime, layout.runtime_staging, layout.runtime_backup))),
        Step("删除公开目录和 gate-service.json", (RemovePath(layout.public), RemovePath(layout.config))),
    ]
    if delete_keys:
        steps.append(Step("删除密钥和数据（已有密文将全部无法解开）", (RemovePath(layout.gate),)))
    return Plan("卸载凭据网关服务", tuple(steps))


def render(plan: Plan) -> list[str]:
    lines = [f"{plan.title}：计划（未执行）"]
    for number, step in enumerate(plan.steps, start=1):
        lines.append(f"{number}. {step.title}")
        lines.extend(f"   {op.describe()}" for op in step.ops)
    return lines
