"""`secret-gate system install|update|rotate-key|uninstall`: the plan, as pure data (gate-service-v0 §2, §4, §5).

A plan is a list of steps; a step is a list of operations. Building a plan reads nothing and changes nothing:
facts about the machine (free UIDs, the runtime's version, ...) come in as arguments, so the plan can be
printed (`--dry-run`) and asserted in tests. system_exec.py carries it out; every privileged command (dscl,
dseditgroup, sysadminctl, launchctl on macOS; useradd, getent, systemctl on Linux; sc.exe, net.exe on Windows; chown)
is a `Run` that goes through one injectable runner. The plan is written once; what differs per system comes from
`layout.platform` (platform/), including how files are given to root and to the service (chown/chmod, or ACLs).

Nothing here reads or changes the login user's home (gate-simple-v0 §1, §6): install generates the service's one
keypair inside the service's own home, and nothing is moved in from `~/.secret-gate`.
"""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .errors import ValidationError
from .platform.base import PROCESS_UMASK, SYSTEM_PATH  # noqa: F401
from .platform.macos import daemon_plist, plists  # noqa: F401  (the macOS service definitions, as before)
from .service_paths import (
    SERVICE_USER,
    ServiceConfig,
    SystemLayout,
)
from .system_ops import (  # noqa: F401  (EnsureFile, MakeDir, Run: as before, for the tests that import them here)
    CreateKey,
    EnsureFile,
    GenerateCA,
    MakeDir,
    Plan,
    Publish,
    RemovePath,
    Run,
    StageRuntime,
    Step,
    SwapRuntime,
    WaitForService,
    WriteFile,
)

ROLE_ID_RANGE = range(450, 500)
SERVICE_FILE_MODE = 0o644
PLIST_MODE = SERVICE_FILE_MODE
CONFIG_MODE = 0o644
PRIVATE_DIR_MODE = 0o700
PUBLIC_DIR_MODE = 0o755
LOG_FILE_MODE = 0o600
LOG_NAMES = ("proxy", "rpc")
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
    owner_uid: int | None        # macOS, Linux: the login user allowed on gate.sock
    port: int
    runtime: Path
    owner_sid: str | None = None  # Windows: the login user allowed on the pipe


@dataclass(frozen=True)
class InstallFacts:
    account: Any                 # macOS: Account; Linux: platform.linux.LinuxAccount; Windows: WindowsAccount
    runtime_version: str
    installed_at: str
    owner_gid: int | None = None  # Linux: the group gate-public/ is opened to


def runtime_version(versions_text: str) -> str:
    """`<secret-gate version>+<build time>` from the runtime's VERSIONS file (build-app.sh)."""
    fields = dict(line.split("=", 1) for line in versions_text.splitlines() if "=" in line)
    gate = fields.get("secret-gate", "").strip()
    if not gate:
        raise ValidationError("运行时的 VERSIONS 文件缺少 secret-gate 版本")
    built = fields.get("built", "").strip()
    return f"{gate}+{built}" if built else gate


# -- plans ---------------------------------------------------------------------------------------

def _root_owned(layout: SystemLayout, *paths: Path, recursive: bool = False) -> tuple:
    return layout.platform.root_owned_ops(layout, *paths, recursive=recursive)


def _stop(layout: SystemLayout, *, disable: bool = False) -> Step:
    return Step("停止服务", layout.platform.stop_ops(layout, disable=disable))


def _start(layout: SystemLayout) -> Step:
    return Step("启动服务", layout.platform.start_ops(layout))


def _write_service_files(layout: SystemLayout, port: int) -> Step:
    return Step(layout.platform.services_title, layout.platform.service_definition_ops(layout, port))


def _config_file(layout: SystemLayout, config: ServiceConfig) -> WriteFile:
    import json

    return WriteFile(layout.config, (json.dumps(config.to_json(), indent=1) + "\n").encode(), CONFIG_MODE)


def _account_step(layout: SystemLayout, account: Any) -> Step:
    title, ops = layout.platform.account_ops(account)
    return Step(title, ops)


def _directories(layout: SystemLayout, reader: Any) -> Step:
    return Step("创建目录", layout.platform.directory_ops(layout, reader))


def public_reader(options_or_config: Any, owner_gid: int | None) -> Any:
    """Who besides the service may read gate-public/: the login user's SID on Windows, its group on Linux."""
    return getattr(options_or_config, "owner_sid", None) or owner_gid


def install_plan(layout: SystemLayout, options: InstallOptions, facts: InstallFacts) -> Plan:
    config = ServiceConfig(owner_uid=options.owner_uid, proxy_port=options.port,
                           runtime_version=facts.runtime_version, installed_at=facts.installed_at,
                           owner_sid=options.owner_sid)
    reader = public_reader(options, facts.owner_gid)
    steps = [
        _account_step(layout, facts.account),
        _directories(layout, reader),
        Step("复制运行时", (StageRuntime(options.runtime, layout),
                          *_root_owned(layout, layout.runtime_staging, recursive=True))),
        Step("写入 gate-service.json", (_config_file(layout, config), *_root_owned(layout, layout.config))),
        Step("生成密钥", (*layout.platform.key_access_ops(layout), CreateKey(layout.gate))),
        Step("生成 mitmproxy CA", (GenerateCA(layout.mitmproxy),)),
        Step("发布 keys.json 和 ca.pem", (Publish(layout),)),
        _ownership(layout, reader),
        _write_service_files(layout, options.port),
        _stop(layout),
        Step("启用新运行时", (SwapRuntime(layout),)),
        _start(layout),
        Step("等待服务响应", (WaitForService(layout),)),
        Step("删除旧运行时", (RemovePath(layout.runtime_backup),)),
    ]
    return Plan("安装凭据网关服务", tuple(steps))


def _ownership(layout: SystemLayout, reader: Any) -> Step:
    return Step("设置属主和权限", layout.platform.ownership_ops(layout, reader))


def rotate_key_plan(layout: SystemLayout, owner_gid: Any = None) -> Plan:
    """Replace the service's keypair (gate-simple-v0 §1): every token sealed to the old one stops opening and has to
    be sealed again. keys.json is republished and the proxy reloads its key on SIGHUP (reload.py; on Windows it
    notices the new key file itself); the rpc service reads the key on every call. `owner_gid`: who may read
    gate-public/ (Linux: the group of gate-service.json's ownerUid; Windows: its ownerSid)."""
    return Plan("更换凭据网关密钥", (
        Step("生成新密钥（旧密文全部失效）", (*layout.platform.key_access_ops(layout),
                                     CreateKey(layout.gate, replace=True))),
        Step("发布 keys.json 和 ca.pem", (Publish(layout),)),
        _ownership(layout, owner_gid),
        Step("通知代理重新加载密钥", layout.platform.reload_proxy_ops(layout)),
        Step("等待服务响应", (WaitForService(layout),)),
    ))


def update_plan(layout: SystemLayout, runtime: Path, config: ServiceConfig) -> Plan:
    """Swap the runtime and restart both services; keys and data stay. `config` is the new gate-service.json."""
    return Plan("更新凭据网关服务", (
        Step("复制运行时", (StageRuntime(runtime, layout), *_root_owned(layout, layout.runtime_staging, recursive=True))),
        Step("写入 gate-service.json", (_config_file(layout, config), *_root_owned(layout, layout.config))),
        _write_service_files(layout, config.proxy_port),
        _stop(layout),
        Step("启用新运行时", (SwapRuntime(layout),)),
        _start(layout),
        Step("等待服务响应", (WaitForService(layout),)),
        Step("删除旧运行时", (RemovePath(layout.runtime_backup),)),
    ))


def uninstall_plan(layout: SystemLayout, *, delete_keys: bool) -> Plan:
    """Services, their definitions, runtime and public files go; the gate home (keys, data) stays unless asked,
    the service account always stays."""
    platform = layout.platform
    steps = [
        _stop(layout, disable=True),
        Step(f"删除 {platform.services_title.removeprefix('写入 ').removeprefix('注册 ')}",
             platform.remove_service_ops(layout)),
        Step("删除运行时", tuple(RemovePath(p) for p in (layout.runtime, layout.runtime_staging, layout.runtime_backup))),
        Step("删除公开目录和 gate-service.json", (RemovePath(layout.public), RemovePath(layout.config))),
    ]
    if delete_keys:
        steps.append(Step("删除密钥和数据（已有密文将全部无法解开）",
                          (*platform.key_access_ops(layout), RemovePath(layout.gate))))
    return Plan("卸载凭据网关服务", tuple(steps))


def render(plan: Plan) -> list[str]:
    lines = [f"{plan.title}：计划（未执行）"]
    for number, step in enumerate(plan.steps, start=1):
        lines.append(f"{number}. {step.title}")
        lines.extend(f"   {op.describe()}" for op in step.ops)
    return lines
