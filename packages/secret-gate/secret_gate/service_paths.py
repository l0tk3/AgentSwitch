"""Where the gate service lives (gate-service-v0 §2), and whether this process is its client (§4).

The service runs under the role account `_agentswitchgate` from a root-owned copy of the runtime. Everything the
login user may see is in `<root>/gate-public/`: `keys.json`, `ca.pem` and `gate.sock`. A process is a *client* of
the service when that socket exists and belongs to another user; the service's own processes (the proxy and the
rpc server, which own the socket) keep working on their gate home directly, exactly like a gate without service.

`SystemLayout(prefix)` relocates every system path under a prefix (`secret-gate system … --root`), for tests.
"""

from __future__ import annotations

import os
import stat
from collections.abc import Mapping
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .errors import ValidationError

SYSTEM_ROOT = Path("/Library/Application Support/AgentSwitch")
LAUNCH_DAEMONS = Path("/Library/LaunchDaemons")
PUBLIC_ENV_VAR = "SECRET_GATE_PUBLIC"

SERVICE_USER = "_agentswitchgate"
SERVICE_FULL_NAME = "AgentSwitch Gate"
PROXY_LABEL = "com.agentswitch.gate.proxy"
RPC_LABEL = "com.agentswitch.gate.rpc"
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

SERVICE_REFUSAL = "凭据网关由系统服务管理，请在 Mac 应用里操作。"
SERVICE_UNAVAILABLE = "凭据网关服务无响应"


@dataclass(frozen=True)
class SystemLayout:
    """Every path of the installed service; `prefix` is "/" on a real machine."""

    prefix: Path = Path("/")

    def system(self, path: Path) -> Path:
        return Path(self.prefix) / path.relative_to("/")

    @property
    def root(self) -> Path:
        return self.system(SYSTEM_ROOT)

    @property
    def gate(self) -> Path:
        return self.root / GATE_DIR

    @property
    def public(self) -> Path:
        return self.root / PUBLIC_DIR

    @property
    def runtime(self) -> Path:
        return self.root / RUNTIME_DIR

    @property
    def runtime_staging(self) -> Path:
        return self.root / (RUNTIME_DIR + ".new")

    @property
    def runtime_backup(self) -> Path:
        return self.root / (RUNTIME_DIR + ".old")

    @property
    def wrapper(self) -> Path:
        """The command both LaunchDaemons run (`<root>/runtime/bin/secret-gate`)."""
        return self.runtime / "bin" / "secret-gate"

    @property
    def config(self) -> Path:
        return self.root / SERVICE_CONFIG_FILE

    @property
    def launch_daemons(self) -> Path:
        return self.system(LAUNCH_DAEMONS)

    @property
    def mitmproxy(self) -> Path:
        return self.gate / MITMPROXY_DIR

    @property
    def logs(self) -> Path:
        return self.gate / LOGS_DIR

    @property
    def socket(self) -> Path:
        return self.public / SOCKET_FILE

    def plist(self, label: str) -> Path:
        return self.launch_daemons / f"{label}.plist"


def public_dir(env: Mapping[str, str] | None = None) -> Path:
    env = os.environ if env is None else env
    override = env.get(PUBLIC_ENV_VAR)
    return Path(override).expanduser() if override else SystemLayout().public


def socket_path(env: Mapping[str, str] | None = None) -> Path:
    return public_dir(env) / SOCKET_FILE


def client_socket(env: Mapping[str, str] | None = None, uid: int | None = None) -> Path | None:
    """The service socket when this process is a client of the gate service, else None.

    A socket owned by this very uid means this process *is* the service (its proxy or rpc server)."""
    path = socket_path(env)
    try:
        info = path.stat()
    except OSError:
        return None
    if not stat.S_ISSOCK(info.st_mode):
        return None
    if info.st_uid == (os.getuid() if uid is None else uid):
        return None
    return path


def config_path_for(public: Path) -> Path:
    """`<root>/gate-service.json` next to `<root>/gate-public`."""
    return Path(public).parent / SERVICE_CONFIG_FILE


# -- gate-service.json ---------------------------------------------------------------------------

_CONFIG_KEYS = frozenset({"ownerUid", "proxyPort", "runtimeVersion", "installedAt"})


@dataclass(frozen=True)
class ServiceConfig:
    owner_uid: int
    proxy_port: int
    runtime_version: str
    installed_at: str

    def to_json(self) -> dict[str, Any]:
        return {"ownerUid": self.owner_uid, "proxyPort": self.proxy_port,
                "runtimeVersion": self.runtime_version, "installedAt": self.installed_at}

    @classmethod
    def from_json(cls, data: object) -> ServiceConfig:
        if not isinstance(data, dict) or set(data) != _CONFIG_KEYS:
            raise ValidationError(f"{SERVICE_CONFIG_FILE} 格式无效：字段应为 {sorted(_CONFIG_KEYS)}")
        owner, port = data["ownerUid"], data["proxyPort"]
        if not _is_int(owner) or not 0 < owner < 2**31:
            raise ValidationError(f"{SERVICE_CONFIG_FILE} 格式无效：ownerUid 应为正整数")
        if not _is_int(port) or not 0 < port < 65536:
            raise ValidationError(f"{SERVICE_CONFIG_FILE} 格式无效：proxyPort 应为 1–65535")
        if not all(isinstance(data[k], str) and len(data[k]) <= 200 for k in ("runtimeVersion", "installedAt")):
            raise ValidationError(f"{SERVICE_CONFIG_FILE} 格式无效：runtimeVersion、installedAt 应为字符串")
        return cls(owner_uid=owner, proxy_port=port, runtime_version=data["runtimeVersion"],
                   installed_at=data["installedAt"])


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
