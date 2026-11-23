"""Where the gate service lives (gate-service-v0 §2, gate-simple-v0 §5), and whether this process is its client (§4).

The service runs under its own account (macOS `_agentswitchgate`, Linux `agentswitch-gate`) from a root-owned copy of
the runtime. Everything the login user may see is in `<root>/gate-public/`: `keys.json`, `ca.pem` and `gate.sock`.
Once `<root>/gate-service.json` exists, every process but the service's own is a *client* of the service
(`client_socket`), with or without the socket; the service's own processes (the proxy and the rpc server, whose
account owns `gate-public/`) keep working on their gate home directly, exactly like a gate without service.

Where `<root>` and the rest are depends on the system (platform/): `SystemLayout(prefix, platform)`; `SystemLayout.native()`
is this machine's. `prefix` relocates every system path (`secret-gate system … --root`), for tests; a Windows path
(`C:\\ProgramData\\AgentSwitch`) moves under it without its drive.

Windows (gate-simple-v0 §5): `gate.sock` names a named pipe (winpipe.py), and peers are SIDs: gate-service.json has
`ownerSid` instead of `ownerUid`, and the service's own processes are the ones running as `NT SERVICE\\AgentSwitchGate`.
"""

from __future__ import annotations

import os
import re
import stat
from collections.abc import Callable, Mapping
from dataclasses import dataclass
from pathlib import Path, PurePath
from typing import Any

from . import fsacl
from .errors import ServiceUnavailable, ValidationError
from .platform import MACOS, GatePlatform, native

# The macOS names, as they were before the platform layer (platform/macos.py has them now).
from .platform.macos import (  # noqa: F401
    LAUNCH_DAEMONS,
    PROXY_LABEL,
    RPC_LABEL,
    SERVICE_FULL_NAME,
    SERVICE_USER,
    SYSTEM_ROOT,
)

PUBLIC_ENV_VAR = "SECRET_GATE_PUBLIC"
SERVICE_LABELS = (RPC_LABEL, PROXY_LABEL)

GATE_DIR = "gate"
PUBLIC_DIR = "gate-public"
RUNTIME_DIR = "runtime"
SERVICE_CONFIG_FILE = "gate-service.json"
SOCKET_FILE = "gate.sock"
KEYS_JSON = "keys.json"
CA_PEM = "ca.pem"
MITMPROXY_DIR = "mitmproxy"
LOGS_DIR = "logs"

SERVICE_REFUSAL = "凭据网关由系统服务管理"
SERVICE_UNAVAILABLE = "凭据网关服务无响应"


def service_refusal(platform: GatePlatform | None = None) -> str:
    """What a command the service owns answers (macOS: "…，请在 Mac 应用里操作。")."""
    return f"{SERVICE_REFUSAL}，{(platform or native()).admin_hint}。"


@dataclass(frozen=True)
class SystemLayout:
    """Every path of the installed service; `prefix` is "/" on a real machine. The platform defaults to macOS (the
    layout before there was a choice); product code takes this machine's with `SystemLayout.native()`."""

    prefix: Path = Path("/")
    platform: GatePlatform = MACOS

    @classmethod
    def native(cls, prefix: Path = Path("/")) -> SystemLayout:
        return cls(prefix, native())

    def system(self, path: PurePath) -> Path:
        if Path(self.prefix) == Path("/"):
            return Path(str(path))
        return Path(self.prefix).joinpath(*PurePath(path).parts[1:])

    @property
    def root(self) -> Path:
        return self.system(self.platform.system_root)

    @property
    def gate(self) -> Path:
        return self.root / GATE_DIR

    @property
    def public(self) -> Path:
        return self.root / PUBLIC_DIR

    @property
    def runtime(self) -> Path:
        return self.system(self.platform.runtime_dir)

    @property
    def runtime_staging(self) -> Path:
        return self.runtime.with_name(self.runtime.name + ".new")

    @property
    def runtime_backup(self) -> Path:
        return self.runtime.with_name(self.runtime.name + ".old")

    @property
    def wrapper(self) -> Path:
        """The command both services run (`<runtime>/bin/secret-gate`)."""
        return self.runtime / "bin" / "secret-gate"

    @property
    def config(self) -> Path:
        return self.root / SERVICE_CONFIG_FILE

    @property
    def services_dir(self) -> Path:
        return self.system(self.platform.services_dir)

    @property
    def launch_daemons(self) -> Path:
        return self.services_dir

    @property
    def mitmproxy(self) -> Path:
        return self.gate / MITMPROXY_DIR

    @property
    def logs(self) -> Path:
        return self.gate / LOGS_DIR

    @property
    def socket(self) -> Path:
        return self.public / SOCKET_FILE

    def service_file(self, label: str) -> Path:
        return self.platform.service_file(self.services_dir, label)

    def plist(self, label: str) -> Path:
        return self.service_file(label)


def public_dir(env: Mapping[str, str] | None = None) -> Path:
    env = os.environ if env is None else env
    override = env.get(PUBLIC_ENV_VAR)
    return Path(override).expanduser() if override else SystemLayout.native().public


def socket_path(env: Mapping[str, str] | None = None) -> Path:
    return public_dir(env) / SOCKET_FILE


def client_socket(env: Mapping[str, str] | None = None, uid: int | None = None, *, sid: str | None = None,
                  windows: bool = fsacl.IS_WINDOWS) -> Path | None:
    """The service socket when this process is a client of the gate service, else None (a gate without service).

    Whether the service is installed is decided by `<root>/gate-service.json` (root-owned, written by `system
    install`, removed by `system uninstall`), never by the socket: the rpc server removes `gate.sock` whenever it
    stops, and a process that went local in that window would seal to and decrypt with keys in the login user's
    own, writable gate home, where another process of this uid may have planted its keypair. So once the file exists:

    * the service's own processes (their uid owns the public directory) keep working on their gate home;
    * every other process is a client. It gets the socket path even when the socket is missing, so calls fail
      with "凭据网关服务无响应" and the commands that only read the service's `keys.json` keep working; a path
      that is there but is not a socket, or a socket the service account does not own, raises ServiceUnavailable.

    Without the file the old rule stands: a socket of another user makes this process a client.

    Windows: the same decision by gate-service.json; the service's own processes are those running as the service's
    account (`sid`, default this process's), and a client always gets the path (its pipe is checked on connect,
    winpipe.connect). Without the file there is no service to find: a pipe has no owner to look at before connecting.
    """
    if windows:
        return _client_pipe(public_dir(env), sid)
    uid = os.getuid() if uid is None else uid
    public = public_dir(env)
    path = public / SOCKET_FILE
    if not _exists(config_path_for(public)):
        return _socket_of_another_user(path, uid)
    service_uid = _owner(public)
    if service_uid == uid:
        return None
    try:
        info = path.lstat()
    except FileNotFoundError:
        return path
    except OSError as exc:
        raise ServiceUnavailable(f"{SERVICE_UNAVAILABLE}（{exc.strerror or exc}）") from None
    if not stat.S_ISSOCK(info.st_mode):
        raise ServiceUnavailable(f"{SERVICE_UNAVAILABLE}（{path} 不是 socket）")
    if info.st_uid != service_uid:
        raise ServiceUnavailable(f"{SERVICE_UNAVAILABLE}（{path} 不属于网关服务账户）")
    return path


def _client_pipe(public: Path, sid: str | None, own_sid: Callable[[], str] | None = None) -> Path | None:
    if not _exists(config_path_for(public)):
        return None
    me = sid or (own_sid or fsacl.current_user_sid)()
    if me == fsacl.GATE_SERVICE_SID:
        return None
    return public / SOCKET_FILE


def _exists(path: Path) -> bool:
    """Whether anything is at `path`; a path that cannot be checked counts as there (fail closed: service mode)."""
    try:
        path.lstat()
    except FileNotFoundError:
        return False
    except OSError:
        return True
    return True


def _owner(path: Path) -> int | None:
    try:
        return path.stat().st_uid
    except OSError:
        return None  # no public directory: no process is the service, none falls back to a local gate


def _socket_of_another_user(path: Path, uid: int) -> Path | None:
    """No service installed: a socket of this very uid means this process *is* the service (or a test's)."""
    try:
        info = path.stat()
    except OSError:
        return None
    if not stat.S_ISSOCK(info.st_mode) or info.st_uid == uid:
        return None
    return path


def config_path_for(public: Path) -> Path:
    """`<root>/gate-service.json` next to `<root>/gate-public`."""
    return Path(public).parent / SERVICE_CONFIG_FILE


# -- gate-service.json ---------------------------------------------------------------------------

_CONFIG_KEYS = frozenset({"ownerUid", "proxyPort", "runtimeVersion", "installedAt"})
_WINDOWS_CONFIG_KEYS = frozenset({"ownerSid", "proxyPort", "runtimeVersion", "installedAt"})
# A user's SID: a local or domain account (S-1-5-21-…) or an Entra ID account (S-1-12-1-…); never a well-known one.
USER_SID_PATTERN = re.compile(r"S-1-5-21(-[0-9]{1,10}){3,6}|S-1-12-1(-[0-9]{1,10}){4,6}")


def is_user_sid(text: object) -> bool:
    return isinstance(text, str) and USER_SID_PATTERN.fullmatch(text) is not None


@dataclass(frozen=True)
class ServiceConfig:
    """gate-service.json. `owner_uid` on macOS and Linux, `owner_sid` on Windows: the login user allowed on the
    interface (exactly one of the two)."""

    owner_uid: int | None
    proxy_port: int
    runtime_version: str
    installed_at: str
    owner_sid: str | None = None

    def to_json(self) -> dict[str, Any]:
        owner = {"ownerSid": self.owner_sid} if self.owner_sid is not None else {"ownerUid": self.owner_uid}
        return {**owner, "proxyPort": self.proxy_port,
                "runtimeVersion": self.runtime_version, "installedAt": self.installed_at}

    @classmethod
    def from_json(cls, data: object) -> ServiceConfig:
        if isinstance(data, dict) and set(data) == _WINDOWS_CONFIG_KEYS:
            if not is_user_sid(data["ownerSid"]):
                raise ValidationError(f"{SERVICE_CONFIG_FILE} 格式无效：ownerSid 应为用户的 SID")
            return cls._rest(data, owner_uid=None, owner_sid=data["ownerSid"])
        if not isinstance(data, dict) or set(data) != _CONFIG_KEYS:
            raise ValidationError(f"{SERVICE_CONFIG_FILE} 格式无效：字段应为 {sorted(_CONFIG_KEYS)}")
        owner = data["ownerUid"]
        if not _is_int(owner) or not 0 < owner < 2**31:
            raise ValidationError(f"{SERVICE_CONFIG_FILE} 格式无效：ownerUid 应为正整数")
        return cls._rest(data, owner_uid=owner, owner_sid=None)

    @classmethod
    def _rest(cls, data: dict, *, owner_uid: int | None, owner_sid: str | None) -> ServiceConfig:
        port = data["proxyPort"]
        if not _is_int(port) or not 0 < port < 65536:
            raise ValidationError(f"{SERVICE_CONFIG_FILE} 格式无效：proxyPort 应为 1–65535")
        if not all(isinstance(data[k], str) and len(data[k]) <= 200 for k in ("runtimeVersion", "installedAt")):
            raise ValidationError(f"{SERVICE_CONFIG_FILE} 格式无效：runtimeVersion、installedAt 应为字符串")
        return cls(owner_uid=owner_uid, proxy_port=port, runtime_version=data["runtimeVersion"],
                   installed_at=data["installedAt"], owner_sid=owner_sid)


def _is_int(value: object) -> bool:
    return isinstance(value, int) and not isinstance(value, bool)


def read_service_config(path: Path) -> ServiceConfig:
    import json

    try:
        raw = Path(path).read_text(encoding="utf-8")
    except FileNotFoundError:
        raise ValidationError(f"未安装凭据网关服务（{path} 不存在）") from None
    except (OSError, UnicodeDecodeError) as exc:
        raise ValidationError(f"无法读取 {path}：{getattr(exc, 'strerror', None) or exc}") from None
    try:
        data = json.loads(raw)
    except ValueError:
        raise ValidationError(f"{SERVICE_CONFIG_FILE} 不是有效的 JSON") from None
    return ServiceConfig.from_json(data)
