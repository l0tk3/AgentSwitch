"""Linux: the system user `agentswitch-gate`, two systemd units, SO_PEERCRED (gate-simple-v0 §5, Linux column).

Layout (`<root>` = /var/lib/agentswitch, root:root 0755):

| path | owner / mode | what |
|---|---|---|
| `<root>/gate/` | agentswitch-gate 0700 (files 0600) | the service's home: key.priv/key.pub, refs, logs/, mitmproxy/ (CA + key) |
| `<root>/gate-public/` | agentswitch-gate:<login user's primary group> 0750 | keys.json, ca.pem (0644), gate.sock (0666, peer uid checked) |
| `<root>/gate-service.json` | root:root 0644 | ownerUid, proxyPort, runtimeVersion, installedAt; its presence is service mode |
| `/opt/agentswitch/gate-runtime/` | root:root 0755 / 0644 | the copy of the node's runtime the units run |
| `/etc/systemd/system/agentswitch-gate-{rpc,proxy}.service` | root:root 0644 | the two units |

`gate-public/` is opened to the login user's primary group only, not to everybody as on macOS: on a server other
accounts are more common than on a Mac, and nothing there is for them (the peer check refuses their uid on the socket
anyway). The service account keeps owning the directory, which is how its own processes know they are the service.

The node's runtime is installed per user (`~/.local/share/agentswitch/runtime/<stamp>`, writable by the login user and
so by its agents): `system install --runtime <it>` copies its `python/`, `secret-gate/` and `VERSIONS` as root with the
same hardened copy as on macOS (system_exec.stage_runtime: nothing followed, every entry owned by the runtime's
owner), and the units run only that copy.
"""

from __future__ import annotations

import os
import socket
import struct
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

from .base import PROCESS_UMASK, SYSTEM_PATH, GatePlatform

if TYPE_CHECKING:
    from ..service import Runner
    from ..service_paths import SystemLayout
    from ..system_ops import Op

SYSTEM_ROOT = Path("/var/lib/agentswitch")
RUNTIME_DIR = Path("/opt/agentswitch/gate-runtime")
SYSTEMD_UNITS = Path("/etc/systemd/system")
SERVICE_USER = "agentswitch-gate"
SERVICE_FULL_NAME = "AgentSwitch Gate"
RPC_UNIT = "agentswitch-gate-rpc"
PROXY_UNIT = "agentswitch-gate-proxy"

# Absolute paths that hold on usr-merged and split /usr systems alike (/bin is /usr/bin on the former).
USERADD = "/usr/sbin/useradd"
ADDUSER = "/usr/sbin/adduser"
GETENT = "/usr/bin/getent"
CHOWN = "/bin/chown"
CHMOD = "/bin/chmod"
SYSTEMCTL = "/bin/systemctl"

NOLOGIN_CANDIDATES = ("/usr/sbin/nologin", "/sbin/nologin", "/usr/bin/nologin")
NO_LOGIN_SHELLS = frozenset({*NOLOGIN_CANDIDATES, "/bin/false", "/usr/bin/false"})
NO_HOME = "/nonexistent"
GETENT_NOT_FOUND = 2
_UCRED = struct.Struct("3i")  # struct ucred {pid_t pid; uid_t uid; gid_t gid;}


@dataclass(frozen=True)
class LinuxAccount:
    """`exists`: reuse `agentswitch-gate` as it is (its shell already checked); else create it with `tool`."""

    exists: bool
    tool: str                 # "useradd" | "adduser"
    shell: str


def peer_uid_ucred(sock: socket.socket) -> int:
    _pid, uid, _gid = _UCRED.unpack(sock.getsockopt(socket.SOL_SOCKET, socket.SO_PEERCRED, _UCRED.size))
    return uid


def _word(text: str) -> str:
    """One word of a unit file line, quoted when it has to be (systemd.syntax)."""
    if text and all(c.isalnum() or c in "_@%+=:,./-" for c in text):
        return text
    return '"' + text.replace("\\", "\\\\").replace('"', '\\"') + '"'


def unit_text(layout: SystemLayout, description: str, args: tuple[str, ...], log_name: str) -> str:
    log = layout.logs / f"{log_name}.log"
    env = {
        "SECRET_GATE_HOME": str(layout.gate),
        "HOME": str(layout.gate),
        "SECRET_GATE_PUBLIC": str(layout.public),
        "PATH": ":".join((str(layout.runtime / "python" / "bin"), *SYSTEM_PATH)),
    }
    lines = [
        "# AgentSwitch gate service (docs/gate-simple-v0.md §5). Written by `secret-gate system install`; do not edit.",
        "[Unit]",
        f"Description={description}",
        "After=network.target",
        "",
        "[Service]",
        "Type=simple",
        f"User={SERVICE_USER}",
        f"Group={SERVICE_USER}",
        "ExecStart=" + " ".join(_word(w) for w in (str(layout.wrapper), *args)),
        *(f"Environment={_word(f'{k}={v}')}" for k, v in env.items()),
        f"WorkingDirectory={_word(str(layout.gate))}",
        f"UMask={PROCESS_UMASK:04o}",
        f"StandardOutput=append:{log}",
        f"StandardError=append:{log}",
        "Restart=always",
        "RestartSec=2",
        # Hardening: the service reads its runtime and writes only its home and the public directory.
        "NoNewPrivileges=yes",
        "ProtectSystem=strict",
        "ProtectHome=yes",
        "PrivateTmp=yes",
        "PrivateDevices=yes",
        f"ReadWritePaths={_word(str(layout.gate))} {_word(str(layout.public))}",
        "ProtectKernelTunables=yes",
        "ProtectKernelModules=yes",
        "ProtectKernelLogs=yes",
        "ProtectControlGroups=yes",
        "ProtectClock=yes",
        "ProtectHostname=yes",
        "RestrictNamespaces=yes",
        "RestrictRealtime=yes",
        "RestrictSUIDSGID=yes",
        "LockPersonality=yes",
        "RestrictAddressFamilies=AF_UNIX AF_INET AF_INET6 AF_NETLINK",
        "CapabilityBoundingSet=",
        "SystemCallArchitectures=native",
        "",
        "[Install]",
        "WantedBy=multi-user.target",
        "",
    ]
    return "\n".join(lines)


def units(layout: SystemLayout, port: int) -> dict[str, bytes]:
    rpc = unit_text(layout, "AgentSwitch gate: rpc (gate.sock)", ("rpc",), "rpc")
    proxy = unit_text(layout, "AgentSwitch gate: proxy",
                      ("proxy", "--port", str(port), "--confdir", str(layout.mitmproxy)), "proxy")
    return {RPC_UNIT: rpc.encode(), PROXY_UNIT: proxy.encode()}


def _unit(label: str) -> str:
    return f"{label}.service"


class Linux(GatePlatform):
    key = "linux"
    service_user = SERVICE_USER
    service_group = SERVICE_USER
    system_root = SYSTEM_ROOT
    runtime_dir = RUNTIME_DIR
    services_dir = SYSTEMD_UNITS
    service_suffix = ".service"
    rpc_label = RPC_UNIT
    proxy_label = PROXY_UNIT
    root_owner = "root:root"
    chown = CHOWN
    chmod = CHMOD
    public_dir_mode = 0o750
    services_title = "写入 systemd 单元"
    admin_hint = "请用 sudo secret-gate system install|update|rotate-key|uninstall 操作"
    need_root = "需要管理员权限：请用 sudo 运行（例如 sudo secret-gate system install …）。"
    precreate_logs = True

    def __init__(self, exists: Callable[[str], bool] = os.path.exists) -> None:
        self._exists = exists

    def public_owner(self, owner_gid: int | None) -> str:
        if owner_gid is None:
            from ..errors import ValidationError

            raise ValidationError("未知登录用户的组，无法设置 gate-public 的属组")
        return f"{SERVICE_USER}:{owner_gid}"

    def account_ops(self, account: Any) -> tuple[str, tuple[Op, ...]]:
        from ..system_ops import Run

        ops: list[Op] = []
        if not account.exists:
            if account.tool == "adduser":   # Debian's adduser, where useradd is missing
                ops.append(Run((ADDUSER, "--system", "--group", "--no-create-home", "--home", NO_HOME,
                                "--shell", account.shell, "--gecos", SERVICE_FULL_NAME, SERVICE_USER)))
            else:
                ops.append(Run((USERADD, "--system", "--user-group", "--no-create-home", "--home-dir", NO_HOME,
                                "--shell", account.shell, "--comment", SERVICE_FULL_NAME, SERVICE_USER)))
        # Whatever made it, nobody logs in as it, and its group is there for the chown below.
        ops.append(Run((GETENT, "passwd", SERVICE_USER), expect=f":{account.shell}\n"))
        ops.append(Run((GETENT, "group", SERVICE_USER)))
        verb = "确认" if account.exists else "创建"
        return f"{verb}服务账户 {SERVICE_USER}", tuple(ops)

    def service_files(self, layout: SystemLayout, port: int) -> dict[str, bytes]:
        return units(layout, port)

    def after_service_files(self, layout: SystemLayout) -> tuple[Op, ...]:
        from ..system_ops import Run

        return (Run((SYSTEMCTL, "daemon-reload")),)

    def stop_ops(self, layout: SystemLayout, *, disable: bool = False) -> tuple[Op, ...]:
        from ..system_ops import SYSTEMD_NOT_LOADED_OK, Run

        verb = ("disable", "--now") if disable else ("stop",)
        return tuple(Run((SYSTEMCTL, *verb, _unit(label)), tolerate=SYSTEMD_NOT_LOADED_OK) for label in self.labels)

    def start_ops(self, layout: SystemLayout) -> tuple[Op, ...]:
        from ..system_ops import Run

        return tuple(Run((SYSTEMCTL, "enable", "--now", _unit(label))) for label in self.labels)

    def reload_proxy_ops(self, layout: SystemLayout) -> tuple[Op, ...]:
        from ..system_ops import SYSTEMD_NOT_LOADED_OK, Run

        return (Run((SYSTEMCTL, "kill", "--signal=SIGHUP", _unit(PROXY_UNIT)), tolerate=SYSTEMD_NOT_LOADED_OK),)

    def after_uninstall(self, layout: SystemLayout) -> tuple[Op, ...]:
        from ..system_ops import Run

        return (Run((SYSTEMCTL, "daemon-reload")),)

    def gather_account(self, runner: Runner, *, simulate: bool) -> LinuxAccount:
        """`getent passwd agentswitch-gate`: reuse it when nobody can log in as it (and it is not root), refuse it
        otherwise; else create it with useradd, or Debian's adduser where there is no useradd."""
        from ..errors import ValidationError

        if simulate:
            return LinuxAccount(exists=False, tool="useradd", shell=NOLOGIN_CANDIDATES[0])
        result = runner((GETENT, "passwd", SERVICE_USER))
        if result.returncode == 0:
            fields = result.stdout.strip().splitlines()[0].split(":") if result.stdout.strip() else []
            if len(fields) != 7:
                raise ValidationError(f"getent passwd {SERVICE_USER} 的输出无法识别")
            if fields[2] == "0" or fields[6] not in NO_LOGIN_SHELLS:
                raise ValidationError(f"已有账户 {SERVICE_USER} 可以登录（shell {fields[6]}，uid {fields[2]}），未使用；"
                                      f"请先删除或改为 nologin")
            return LinuxAccount(exists=True, tool="", shell=fields[6])
        if result.returncode != GETENT_NOT_FOUND:
            raise ValidationError(f"getent passwd {SERVICE_USER} 失败（{result.returncode}）")
        tool = "useradd" if self._exists(USERADD) else "adduser" if self._exists(ADDUSER) else ""
        if not tool:
            raise ValidationError("找不到 useradd 或 adduser，无法创建服务账户")
        shell = next((s for s in NOLOGIN_CANDIDATES if self._exists(s)), "/bin/false")
        return LinuxAccount(exists=False, tool=tool, shell=shell)

    def owner_gid(self, owner_uid: int, *, simulate: bool, getpwuid: Callable[[int], Any] | None = None) -> int | None:
        from ..errors import ValidationError

        if getpwuid is None:
            import pwd

            getpwuid = pwd.getpwuid
        try:
            return int(getpwuid(owner_uid).pw_gid)
        except KeyError:
            if simulate:
                return os.getgid()
            raise ValidationError(f"找不到 uid {owner_uid} 的用户") from None

    def peer_uid(self, sock: socket.socket) -> int:
        return peer_uid_ucred(sock)


LINUX = Linux()
