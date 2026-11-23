"""A real gate service (rpc_server) on a temporary socket, for the service-mode tests.

AF_UNIX paths are limited to 104 bytes on macOS, so the socket lives in a short temporary directory, not in
pytest's tmp_path. The peer check is real (LOCAL_PEERCRED); the allowed uids are injected.

Windows: the same service on the named pipe for that path (PipeRpcServer, winpipe.py); the peers are SIDs (SYSTEM and
this user's unless injected), checked on the client's token, and the client checks the pipe was made by this user.
"""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
import threading
from collections.abc import Iterator
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from secret_gate.keyring import create_keypair
from secret_gate.rpc_client import RpcClient
from secret_gate.rpc_methods import GateService
from secret_gate.rpc_server import AUDIT_FILE, PipeRpcServer, RpcServer
from secret_gate.service_paths import SOCKET_FILE, ServiceConfig

WINDOWS = sys.platform == "win32"


def _own_sid() -> str:
    from secret_gate.fsacl import current_user_sid

    return current_user_sid()


OWNER_CONFIG = (ServiceConfig(owner_uid=None, owner_sid=_own_sid(), proxy_port=18080, runtime_version="0.1.0+test",
                              installed_at="2026-09-27T00:00:00Z") if WINDOWS else
                ServiceConfig(owner_uid=os.getuid(), proxy_port=18080, runtime_version="0.1.0+test",
                              installed_at="2026-09-27T00:00:00Z"))


@dataclass
class RunningService:
    root: Path
    home: Path
    public: Path
    socket: Path
    server: RpcServer | PipeRpcServer
    service: GateService

    @property
    def client(self) -> RpcClient:
        return RpcClient(self.socket)

    @property
    def audit(self) -> Path:
        return self.home / AUDIT_FILE


@contextmanager
def short_dir() -> Iterator[Path]:
    path = Path(tempfile.mkdtemp(prefix="sg-"))
    try:
        yield path
    finally:
        shutil.rmtree(path, ignore_errors=True)


def default_peers() -> frozenset:
    if WINDOWS:
        from secret_gate.fsacl import SYSTEM_SID

        return frozenset({SYSTEM_SID, _own_sid()})
    return frozenset({0, os.getuid()})


@contextmanager
def running_service(*, allowed: frozenset | None = None, key: bool = True,
                    **service_kwargs: Any) -> Iterator[RunningService]:
    with short_dir() as root:
        home, public = root / "gate", root / "pub"
        home.mkdir(mode=0o700)
        public.mkdir()
        if key:
            create_keypair(home)
        service_kwargs.setdefault("proxy_running_fn", lambda: True)
        service = GateService(home, public, lambda: OWNER_CONFIG, **service_kwargs)
        service.publish()
        peers = default_peers() if allowed is None else allowed
        server_class = PipeRpcServer if WINDOWS else RpcServer
        server = server_class(public / SOCKET_FILE, service, lambda: peers, home / AUDIT_FILE)
        thread = threading.Thread(target=server.serve_forever, kwargs={"poll_interval": 0.05}, daemon=True)
        thread.start()
        try:
            yield RunningService(root, home, public, public / SOCKET_FILE, server, service)
        finally:
            server.shutdown()
            server.server_close()
            thread.join(5)
