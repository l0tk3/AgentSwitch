"""What the gate service needs from the operating system, as one small interface (gate-simple-v0 §5).

The service is the same everywhere: a service account that keeps the keypair and the mitmproxy CA, the proxy and the
rpc server running under it from a root-owned copy of the runtime, and `gate-public/` with `keys.json`, `ca.pem` and
`gate.sock` for the login user. What differs per system is thin and lives behind `GatePlatform`:

* where things are (`system_root`, `runtime_dir`, `services_dir`) and who owns them (`root_owner`, `service_user`);
* how the account is made and checked (`account_ops`, `gather_account`);
* how the two services are described and driven (`service_files`, `stop_ops`, `start_ops`, `reload_proxy_ops`);
* how files are given to root and to the service (`root_owned_ops`, `directory_ops`, `ownership_ops`: chown and
  modes on POSIX, ACLs on Windows);
* how the socket learns the peer's uid (`peer_uid`).

The defaults of the file-ownership and service-definition hooks are the POSIX way, so macOS and Linux keep their
plans byte for byte; Windows (platform/windows.py) overrides them.

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

    key: str                     # "macos" | "linux" | "windows": `secret-gate system --platform`, tests
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

    # -- file ownership (POSIX: chown/chmod; Windows overrides with ACLs) ------------------------------

    def root_owned_ops(self, layout: SystemLayout, *paths: Path, recursive: bool = False) -> tuple[Op, ...]:
        """Make `paths` root's (the runtime copy, gate-service.json, the service definitions)."""
        from ..system_ops import Run

        return (Run((self.chown, *(("-R",) if recursive else ()), self.root_owner, *map(str, paths))),)

    def directory_ops(self, layout: SystemLayout, reader: Any) -> tuple[Op, ...]:
        """Create `<root>`, the runtime's parent, the gate home (+ logs, mitmproxy) and the public directory.
        `reader`: who may read gate-public/ besides the service (Linux: the login user's group; Windows: its SID)."""
        from ..system_ops import EnsureFile, MakeDir
        from ..system_plan import LOG_FILE_MODE, LOG_NAMES, PRIVATE_DIR_MODE, PUBLIC_DIR_MODE

        runtime_parent = layout.runtime.parent
        own_parent = runtime_parent != layout.root     # Linux: /opt/agentswitch for gate-runtime/
        return (
            MakeDir(layout.root, PUBLIC_DIR_MODE), *self.root_owned_ops(layout, layout.root),
            *((MakeDir(runtime_parent, PUBLIC_DIR_MODE), *self.root_owned_ops(layout, runtime_parent))
              if own_parent else ()),
            *(MakeDir(p, PRIVATE_DIR_MODE) for p in (layout.gate, layout.logs, layout.mitmproxy)),
            MakeDir(layout.public, self.public_dir_mode),
            *((EnsureFile(layout.logs / f"{name}.log", LOG_FILE_MODE) for name in LOG_NAMES)
              if self.precreate_logs else ()),
        )

    def ownership_ops(self, layout: SystemLayout, reader: Any) -> tuple[Op, ...]:
        """The gate home to the service account only, gate-public/ to the service account (and `reader`)."""
        from ..system_ops import Run

        owner = f"{self.service_user}:{self.service_group}"
        return (Run((self.chmod, "-R", "go-rwx", str(layout.gate))),   # 0700 / 0600 whatever root's umask was
                Run((self.chown, "-R", owner, str(layout.gate))),
                Run((self.chown, "-R", self.public_owner(reader), str(layout.public))))

    def key_access_ops(self, layout: SystemLayout) -> tuple[Op, ...]:
        """What the administrator's process needs before it writes or removes the service's keys (POSIX: root
        needs nothing)."""
        return ()

    def service_definition_ops(self, layout: SystemLayout, port: int) -> tuple[Op, ...]:
        """Write the two service definitions (root-owned) and tell the service manager."""
        from ..system_ops import MakeDir, WriteFile
        from ..system_plan import PUBLIC_DIR_MODE, SERVICE_FILE_MODE

        files = self.service_files(layout, port)
        return (
            MakeDir(layout.services_dir, PUBLIC_DIR_MODE),
            *(WriteFile(layout.service_file(label), data, SERVICE_FILE_MODE) for label, data in files.items()),
            *self.root_owned_ops(layout, *(layout.service_file(label) for label in files)),
            *self.after_service_files(layout),
        )

    def remove_service_ops(self, layout: SystemLayout) -> tuple[Op, ...]:
        """Remove the service definitions (both services are stopped)."""
        from ..system_ops import RemovePath

        return (*(RemovePath(layout.service_file(label)) for label in self.labels), *self.after_uninstall(layout))

    # -- facts -------------------------------------------------------------------------------------

    @abstractmethod
    def gather_account(self, runner: Runner, *, simulate: bool) -> Any:
        """A read-only look at the machine: the account to reuse or create (passed back to `account_ops`)."""

    def preflight(self, layout: SystemLayout, *, simulate: bool) -> None:
        """Refuse to install over something the administrator did not make (Windows: a `<root>` a user created)."""

    def is_admin(self) -> bool:
        """Whether this process may run `system install` and friends (root)."""
        import os

        return os.geteuid() == 0

    def owner_gid(self, owner_uid: int, *, simulate: bool, getpwuid: Callable[[int], Any] | None = None) -> int | None:
        """The group `gate-public/` is opened to, when this system narrows it to the login user's group."""
        return None

    # -- the socket --------------------------------------------------------------------------------

    @abstractmethod
    def peer_uid(self, sock: socket.socket) -> int:
        """Effective uid of the process at the other end of a connected AF_UNIX socket, from the kernel."""
