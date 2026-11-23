"""macOS: the role account `_agentswitchgate`, two LaunchDaemons, LOCAL_PEERCRED (gate-service-v0 §2, §3.1).

This is the gate service as it was first built (2026-09-27); moving it behind `GatePlatform` changed no command, path
or file it writes.
"""

from __future__ import annotations

import plistlib
import socket
import struct
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .base import PROCESS_UMASK, SYSTEM_PATH, GatePlatform

if TYPE_CHECKING:
    from ..service import Runner
    from ..service_paths import SystemLayout
    from ..system_ops import Op

SYSTEM_ROOT = Path("/Library/Application Support/AgentSwitch")
LAUNCH_DAEMONS = Path("/Library/LaunchDaemons")
SERVICE_USER = "_agentswitchgate"
SERVICE_FULL_NAME = "AgentSwitch Gate"
PROXY_LABEL = "com.agentswitch.gate.proxy"
RPC_LABEL = "com.agentswitch.gate.rpc"

# Absolute paths: root never resolves a privileged tool through PATH.
DSCL = "/usr/bin/dscl"
DSEDITGROUP = "/usr/sbin/dseditgroup"
SYSADMINCTL = "/usr/sbin/sysadminctl"
CHOWN = "/usr/sbin/chown"
CHMOD = "/bin/chmod"
LAUNCHCTL = "/bin/launchctl"

# <sys/un.h>, <sys/ucred.h>: SOL_LOCAL 0, LOCAL_PEERCRED 1; struct xucred {u_int cr_version; uid_t cr_uid;
# short cr_ngroups; gid_t cr_groups[16];} = 76 bytes, XUCRED_VERSION 0.
SOL_LOCAL = 0
LOCAL_PEERCRED = 1
XUCRED_SIZE = 76
XUCRED_VERSION = 0


def peer_uid_xucred(sock: socket.socket) -> int:
    raw = sock.getsockopt(SOL_LOCAL, LOCAL_PEERCRED, XUCRED_SIZE)
    version, uid = struct.unpack_from("=II", raw)
    if version != XUCRED_VERSION:
        raise OSError(f"unexpected xucred version {version}")
    return uid


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


def _ids(runner: Runner, path: str, attribute: str) -> dict[str, int]:
    from ..errors import ValidationError

    result = runner((DSCL, ".", "-list", path, attribute))
    if result.returncode != 0:
        raise ValidationError(f"dscl . -list {path} {attribute} 失败（{result.returncode}）")
    out: dict[str, int] = {}
    for line in result.stdout.splitlines():
        parts = line.split()
        if len(parts) >= 2 and parts[-1].lstrip("-").isdigit():
            out[parts[0]] = int(parts[-1])
    return out


class MacOS(GatePlatform):
    key = "macos"
    service_user = SERVICE_USER
    service_group = SERVICE_USER
    system_root = SYSTEM_ROOT
    runtime_dir = SYSTEM_ROOT / "runtime"
    services_dir = LAUNCH_DAEMONS
    service_suffix = ".plist"
    rpc_label = RPC_LABEL
    proxy_label = PROXY_LABEL
    root_owner = "root:wheel"
    chown = CHOWN
    chmod = CHMOD
    public_dir_mode = 0o755
    services_title = "写入 LaunchDaemon"
    admin_hint = "请在 Mac 应用里操作"
    need_root = "需要管理员权限：请在 Mac 应用中操作（会请求一次管理员授权）。"

    def account_ops(self, account: Any) -> tuple[str, tuple[Op, ...]]:
        from ..system_ops import Run

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
        return f"{verb}服务账户 {SERVICE_USER}", tuple(ops)

    def service_files(self, layout: SystemLayout, port: int) -> dict[str, bytes]:
        return plists(layout, port)

    def stop_ops(self, layout: SystemLayout, *, disable: bool = False) -> tuple[Op, ...]:
        from ..system_ops import NOT_LOADED_OK, Run

        return tuple(Run((LAUNCHCTL, "bootout", f"system/{label}"), tolerate=NOT_LOADED_OK) for label in self.labels)

    def start_ops(self, layout: SystemLayout) -> tuple[Op, ...]:
        from ..system_ops import Run

        return tuple(Run((LAUNCHCTL, "bootstrap", "system", str(layout.plist(label))), retries=3) for label in self.labels)

    def reload_proxy_ops(self, layout: SystemLayout) -> tuple[Op, ...]:
        from ..system_ops import NOT_LOADED_OK, Run

        return (Run((LAUNCHCTL, "kill", "SIGHUP", f"system/{PROXY_LABEL}"), tolerate=NOT_LOADED_OK),)

    def gather_account(self, runner: Runner, *, simulate: bool) -> Any:
        from ..system_plan import choose_account

        users = {} if simulate else _ids(runner, "/Users", "UniqueID")
        groups = {} if simulate else _ids(runner, "/Groups", "PrimaryGroupID")
        return choose_account(users, groups)

    def peer_uid(self, sock: socket.socket) -> int:
        return peer_uid_xucred(sock)


MACOS = MacOS()
