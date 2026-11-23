"""Windows: one Windows service under the virtual account `NT SERVICE\\AgentSwitchGate`, ACLs, a named pipe
(gate-simple-v0 §5, Windows column).

Layout (`<root>` = %ProgramData%\\AgentSwitch, `<pf>` = %ProgramFiles%\\AgentSwitch, both from the shell's known
folders, never from environment variables):

| path | ACL (protected, owner Administrators) | what |
|---|---|---|
| `<root>\\` | SYSTEM, Administrators full; Users, the service read | |
| `<root>\\gate\\` | SYSTEM, Administrators, the service full; nobody else | key.priv/key.pub, refs, logs\\, mitmproxy\\ (CA + key) |
| `<root>\\gate-public\\` | SYSTEM, Administrators full; the service modify; the login user (`ownerSid`) read | keys.json, ca.pem |
| `<root>\\gate-service.json` | inherited from `<root>\\`: only administrators write it | ownerSid, proxyPort, runtimeVersion, installedAt; its presence is service mode |
| `<pf>\\gate-runtime\\` | inherited from `<pf>\\` (SYSTEM, Administrators full; Users, the service read) | the copy of the runtime the service runs |
| `\\\\.\\pipe\\agentswitch-gate` | owner the service; the service full, the login user and SYSTEM read/write data (winpipe.py) | the interface (gate.sock elsewhere) |

Decisions:

* **One service, one account.** A virtual account is always the service's own (`NT SERVICE\\<service name>`), so two
  services would mean two accounts that both need the key. Instead the service `AgentSwitchGate` is a small host
  (secret_gate/win_service.py, pywin32's servicemanager in the runtime's own python.exe) that runs the rpc server and the
  proxy as two child processes, restarting either when it exits; both inherit the virtual account. The plan's two
  labels are therefore one service.
* **Administrators keep access to the gate home** (the spec said SYSTEM + the service only). `system install` and
  `rotate-key` write the keys from an elevated administrator's process, as root does on macOS and Linux; without an
  entry they could only get in by taking ownership. An administrator's non-elevated processes (the agent's) carry the
  Administrators group as deny-only under UAC, so the entry does not apply to them, exactly like root's access on
  POSIX does not apply to the login user.
* **`<root>` made by someone else is refused.** Users may create folders in ProgramData; a `<root>` that already exists
  and is not owned by Administrators, SYSTEM or TrustedInstaller could hold a planted key, so install stops
  (`preflight`).
* **Reload without SIGHUP.** The proxy watches key.priv and upstream-insecure.txt (reload.py), so rotate-key sends
  nothing.

Commands are absolute paths below the Windows directory (GetWindowsDirectoryW): `sc.exe` registers, configures and
deletes the service, `net.exe` stops and starts it (both wait until the service is stopped or running; `sc stop` does
not). ACLs are `SetAcl` operations carried out with pywin32 (system_exec), not icacls, so each is an exact, complete DACL.
"""

from __future__ import annotations

import socket
from dataclasses import dataclass
from pathlib import Path, PureWindowsPath
from typing import TYPE_CHECKING, Any

from ..fsacl import (
    ADMINISTRATORS_SID,
    GATE_SERVICE_NAME,
    GATE_SERVICE_SID,
    SYSTEM_SID,
    TRUSTED_INSTALLER_SID,
    USERS_SID,
    known_folder,
    windows_dir,
)
from .base import GatePlatform

if TYPE_CHECKING:
    from ..service import Runner
    from ..service_paths import SystemLayout
    from ..system_ops import Op

SERVICE_NAME = GATE_SERVICE_NAME
SERVICE_ACCOUNT = f"NT SERVICE\\{SERVICE_NAME}"
DISPLAY_NAME = "AgentSwitch Gate"
DESCRIPTION = ("AgentSwitch credential gate (docs/gate-simple-v0.md): keeps the gate's keys and runs its proxy and "
               "its local interface. Managed by `secret-gate system`.")
HOST_MODULE = "secret_gate.win_service"
# Restart the host 2 s after it dies, every time (launchd KeepAlive, systemd Restart=always); count reset daily.
FAILURE_ACTIONS = "restart/2000/restart/2000/restart/2000"

ROOT_GRANTS = ((SYSTEM_SID, "full"), (ADMINISTRATORS_SID, "full"), (USERS_SID, "read"), (GATE_SERVICE_SID, "read"))
GATE_GRANTS = ((SYSTEM_SID, "full"), (ADMINISTRATORS_SID, "full"), (GATE_SERVICE_SID, "full"))
ADMIN_OWNERS = frozenset({ADMINISTRATORS_SID, SYSTEM_SID, TRUSTED_INSTALLER_SID})

# sc.exe and net.exe exit codes / messages (locale-independent numbers).
ERROR_SERVICE_EXISTS = 1073
ERROR_SERVICE_DOES_NOT_EXIST = 1060
NET_NOT_STARTED = "3521"        # NET HELPMSG 3521: the service is not started
NET_INVALID_SERVICE = "2185"    # NET HELPMSG 2185: the service name is invalid (not installed)


def public_grants(owner_sid: str | None) -> tuple[tuple[str, str], ...]:
    reader = ((owner_sid, "read"),) if owner_sid else ()
    return ((SYSTEM_SID, "full"), (ADMINISTRATORS_SID, "full"), (GATE_SERVICE_SID, "modify"), *reader)


def tool(name: str, windows: str | None = None) -> str:
    return f"{windows or windows_dir()}\\System32\\{name}"


def host_command(layout: SystemLayout) -> str:
    """The service's binPath: the runtime copy's own interpreter, isolated (-I: no PYTHON* variables, no user site,
    no current directory on sys.path) and in UTF-8 mode, running the host module."""
    python = layout.runtime / "python" / "python.exe"
    return f'"{python}" -I -X utf8 -m {HOST_MODULE}'


@dataclass(frozen=True)
class WindowsAccount:
    """The virtual account: nothing to create, it comes with the service."""

    sid: str = GATE_SERVICE_SID


class Windows(GatePlatform):
    key = "windows"
    service_user = SERVICE_ACCOUNT
    service_group = SERVICE_ACCOUNT
    service_suffix = ""
    rpc_label = SERVICE_NAME
    proxy_label = SERVICE_NAME
    root_owner = "Administrators"
    chown = ""
    chmod = ""
    public_dir_mode = 0o755
    services_title = "注册 Windows 服务"
    admin_hint = "请在以管理员身份运行的终端里用 secret-gate system install|update|rotate-key|uninstall 操作"
    need_root = "需要管理员权限：请在以管理员身份运行的终端里运行（例如 secret-gate system install …）。"

    def __init__(self, windows: str | None = None) -> None:
        self._windows = windows

    # Known folders are looked up when used, not at import (they need Windows; tests simulate the defaults).
    @property
    def system_root(self) -> PureWindowsPath:  # type: ignore[override]
        return PureWindowsPath(known_folder("ProgramData", "C:\\ProgramData")) / "AgentSwitch"

    @property
    def runtime_dir(self) -> PureWindowsPath:  # type: ignore[override]
        return PureWindowsPath(known_folder("ProgramFiles", "C:\\Program Files")) / "AgentSwitch" / "gate-runtime"

    @property
    def services_dir(self) -> PureWindowsPath:  # type: ignore[override]
        return self.runtime_dir.parent  # nothing is written there: the service lives in the registry

    @property
    def labels(self) -> tuple[str, ...]:  # type: ignore[override]
        return (SERVICE_NAME,)

    def _tool(self, name: str) -> str:
        return tool(name, self._windows)

    # -- plan pieces ----------------------------------------------------------------------------------

    def account_ops(self, account: Any) -> tuple[str, tuple[Op, ...]]:
        return f"服务账户 {SERVICE_ACCOUNT}（虚拟账户，随服务注册，SID {account.sid}）", ()

    def root_owned_ops(self, layout: SystemLayout, *paths: Path, recursive: bool = False) -> tuple[Op, ...]:
        """Nothing: everything root-owned inherits the ACL its parent got in `directory_ops`."""
        return ()

    def directory_ops(self, layout: SystemLayout, reader: Any) -> tuple[Op, ...]:
        """Each directory gets its ACL right when it is made, before anything is written into it: the gate home is
        never readable by Users, not even between two steps."""
        from ..system_ops import MakeDir, SetAcl
        from ..system_plan import PRIVATE_DIR_MODE, PUBLIC_DIR_MODE

        runtime_parent = layout.runtime.parent
        return (
            MakeDir(layout.root, PUBLIC_DIR_MODE), SetAcl(layout.root, ROOT_GRANTS, ADMINISTRATORS_SID),
            MakeDir(runtime_parent, PUBLIC_DIR_MODE), SetAcl(runtime_parent, ROOT_GRANTS, ADMINISTRATORS_SID),
            MakeDir(layout.gate, PRIVATE_DIR_MODE), SetAcl(layout.gate, GATE_GRANTS, ADMINISTRATORS_SID, tree=True),
            MakeDir(layout.logs, PRIVATE_DIR_MODE), MakeDir(layout.mitmproxy, PRIVATE_DIR_MODE),
            MakeDir(layout.public, self.public_dir_mode),
            SetAcl(layout.public, public_grants(reader), ADMINISTRATORS_SID, tree=True),
        )

    def ownership_ops(self, layout: SystemLayout, reader: Any) -> tuple[Op, ...]:
        """The same two ACLs again, and everything below them back to inheriting only (a file written meanwhile with
        an ACL of its own loses it)."""
        from ..system_ops import SetAcl

        return (SetAcl(layout.gate, GATE_GRANTS, ADMINISTRATORS_SID, tree=True),
                SetAcl(layout.public, public_grants(reader), ADMINISTRATORS_SID, tree=True))

    def service_files(self, layout: SystemLayout, port: int) -> dict[str, bytes]:
        return {}  # the service is registered with sc.exe; the port is read from gate-service.json at start

    def service_definition_ops(self, layout: SystemLayout, port: int) -> tuple[Op, ...]:
        from ..system_ops import WINDOWS_EXISTS_OK, Run

        sc = self._tool("sc.exe")
        settings = ("binPath=", host_command(layout), "obj=", SERVICE_ACCOUNT, "start=", "auto",
                    "DisplayName=", DISPLAY_NAME)
        return (
            Run((sc, "create", SERVICE_NAME, *settings), tolerate=WINDOWS_EXISTS_OK),
            Run((sc, "config", SERVICE_NAME, *settings)),          # an existing registration takes the same settings
            Run((sc, "description", SERVICE_NAME, DESCRIPTION)),
            Run((sc, "failure", SERVICE_NAME, "reset=", "86400", "actions=", FAILURE_ACTIONS)),
        )

    def stop_ops(self, layout: SystemLayout, *, disable: bool = False) -> tuple[Op, ...]:
        from ..system_ops import WINDOWS_NOT_RUNNING_OK, Run

        return (Run((self._tool("net.exe"), "stop", SERVICE_NAME), tolerate=WINDOWS_NOT_RUNNING_OK),)

    def start_ops(self, layout: SystemLayout) -> tuple[Op, ...]:
        from ..system_ops import Run

        return (Run((self._tool("net.exe"), "start", SERVICE_NAME), retries=3),)

    def reload_proxy_ops(self, layout: SystemLayout) -> tuple[Op, ...]:
        return ()  # the proxy watches key.priv itself (reload.py)

    def key_access_ops(self, layout: SystemLayout) -> tuple[Op, ...]:
        """The gate home's ACL as it must be, so the elevated process can write or remove the keys even when someone
        changed it (Administrators own it, so they may always rewrite its ACL)."""
        from ..system_ops import SetAcl

        return (SetAcl(layout.gate, GATE_GRANTS, ADMINISTRATORS_SID, tree=True),)

    def remove_service_ops(self, layout: SystemLayout) -> tuple[Op, ...]:
        from ..system_ops import WINDOWS_NO_SERVICE_OK, Run

        return (Run((self._tool("sc.exe"), "delete", SERVICE_NAME), tolerate=WINDOWS_NO_SERVICE_OK),)

    # -- facts -----------------------------------------------------------------------------------------

    def gather_account(self, runner: Runner, *, simulate: bool) -> WindowsAccount:
        return WindowsAccount()

    def preflight(self, layout: SystemLayout, *, simulate: bool, owner_of: Any = None) -> None:
        """A `<root>` that exists must have been made by an administrator (Users may create folders in ProgramData)."""
        from ..errors import ValidationError
        from ..fsacl import owner_sid

        if simulate or not Path(layout.root).exists():
            return
        owner = (owner_of or owner_sid)(Path(layout.root))
        if owner not in ADMIN_OWNERS:
            raise ValidationError(f"{layout.root} 已存在，但不是管理员创建的（所有者 {owner}）；"
                                  f"其中可能有他人放入的文件，请检查后删除再安装")

    def is_admin(self) -> bool:
        from ..fsacl import is_admin

        return is_admin()

    def peer_uid(self, sock: socket.socket) -> int:
        raise OSError("Windows has no uid on a socket: the gate's interface is a named pipe there (winpipe.py)")


WINDOWS = Windows()
