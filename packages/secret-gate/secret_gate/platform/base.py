"""What the gate service needs from the operating system, as one small interface (gate-simple-v0 §5).

The service is the same everywhere: a service account that keeps the keypair and the mitmproxy CA, the proxy and the
rpc server running under it from a root-owned copy of the runtime, and `gate-public/` with `keys.json`, `ca.pem` and
`gate.sock` for the login user. What differs per system is thin and lives behind `GatePlatform`:

* where things are (`system_root`, `runtime_dir`, `services_dir`) and who owns them (`root_owner`, `service_user`);
* how the account is made and checked (`account_ops`, `gather_account`);
* how the two services are described and driven (`service_files`, `stop_ops`, `start_ops`, `reload_proxy_ops`);
* how the socket learns the peer's uid (`peer_uid`).

Interface methods only build data (`system_ops` operations); nothing here runs a command. The plan (system_plan) is
written once against this interface, and system_exec carries it out the same way on every system.

The modules of this package import nothing of the gate at load time (service_paths imports them), so the operations
are imported inside the methods that build them.
"""

from __future__ import annotations

import socket
from abc import ABC, abstractmethod
from collections.abc import Callable
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from ..service import Runner
    from ..service_paths import SystemLayout
    from ..system_ops import Op


SYSTEM_PATH = ("/usr/bin", "/bin", "/usr/sbin", "/sbin")
PROCESS_UMASK = 0o077


class GatePlatform(ABC):
    """One operating system's way of running the gate service. Instances are stateless singletons."""

    key: str                     # "macos" | "linux": `secret-gate system --platform`, tests
    service_user: str
    service_group: str
    system_root: Path            # `<root>`: gate/, gate-public/, gate-service.json
    runtime_dir: Path            # the root-owned copy of the runtime the services run
    services_dir: Path           # where the two service definitions go
    service_suffix: str          # ".plist" | ".service"
    rpc_label: str
    proxy_label: str
    root_owner: str              # chown spec for root-owned files
    chown: str                   # absolute paths: root never looks a tool up in PATH
    chmod: str
    public_dir_mode: int         # gate-public/
    services_title: str          # the plan step that writes the service definitions
    admin_hint: str              # where an administrator manages the service (refusals)
    need_root: str               # `system install` etc. run without root
    precreate_logs: bool = False # create the log files before the services start (systemd would make them root's)

    @property
    def labels(self) -> tuple[str, str]:
        """Both services, the rpc server first (the order they are written, stopped and started in)."""
        return (self.rpc_label, self.proxy_label)

    def service_file(self, services_dir: Path, label: str) -> Path:
        return services_dir / f"{label}{self.service_suffix}"

    def public_owner(self, owner_gid: int | None) -> str:
        """The chown spec of `gate-public/` and its files: the service account (whose ownership of the directory is
        what tells its own processes apart from clients, service_paths.client_socket)."""
        return f"{self.service_user}:{self.service_group}"

    # -- plan pieces (data only) ------------------------------------------------------------------

    @abstractmethod
    def account_ops(self, account: Any) -> tuple[str, tuple[Op, ...]]:
        """(step title, operations) that make the service account when missing and check that nobody logs in as it."""

    @abstractmethod
    def service_files(self, layout: SystemLayout, port: int) -> dict[str, bytes]:
        """label -> the service definition's bytes, rpc server first."""

    def after_service_files(self, layout: SystemLayout) -> tuple[Op, ...]:
        """What the service manager needs after the definitions changed (systemd: daemon-reload)."""
        return ()

    @abstractmethod
    def stop_ops(self, layout: SystemLayout, *, disable: bool = False) -> tuple[Op, ...]:
        """Stop both services; a service that is not loaded counts as stopped. `disable`: for good (uninstall)."""

    @abstractmethod
    def start_ops(self, layout: SystemLayout) -> tuple[Op, ...]:
        """Start both services from their definitions (and at every boot)."""

    @abstractmethod
    def reload_proxy_ops(self, layout: SystemLayout) -> tuple[Op, ...]:
        """SIGHUP to the proxy: it reloads its key and the upstream exceptions (reload.py)."""

    def after_uninstall(self, layout: SystemLayout) -> tuple[Op, ...]:
        """What the service manager needs once the definitions are gone."""
        return ()

    # -- facts -------------------------------------------------------------------------------------

    @abstractmethod
    def gather_account(self, runner: Runner, *, simulate: bool) -> Any:
        """A read-only look at the machine: the account to reuse or create (passed back to `account_ops`)."""

    def owner_gid(self, owner_uid: int, *, simulate: bool, getpwuid: Callable[[int], Any] | None = None) -> int | None:
        """The group `gate-public/` is opened to, when this system narrows it to the login user's group."""
        return None

    # -- the socket --------------------------------------------------------------------------------

    @abstractmethod
    def peer_uid(self, sock: socket.socket) -> int:
        """Effective uid of the process at the other end of a connected AF_UNIX socket, from the kernel."""
