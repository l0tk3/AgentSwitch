"""`secret-gate rpc`: the gate service's local socket `<public>/gate.sock` (gate-service-v0 §3).

Runs as the service account. The socket is mode 0666 so any local process can connect, and the peer check lets
only root and the `ownerUid` of gate-service.json stay: the uid comes from the kernel (LOCAL_PEERCRED), every
other user is disconnected before a byte is read. One thread per connection, so a slow `mcp.http`, `mcp.exec` or
`mcp.repair` never holds up another client; key changes are serialized inside the service.

Every call writes one line to `<gate home>/logs/rpc-audit.jsonl` (0600): time, method, peer uid, the scope's
short hash, token labels, host, result. Never a value, a ciphertext or the scope itself.
"""

from __future__ import annotations

import argparse
import os
import signal
import socket
import socketserver
import stat
import sys
import threading
import time
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .audit import Audit
from .errors import GateError, ValidationError
from .keystore import gate_home
from .rpc_methods import GateService
from .rpc_protocol import (
    ERR_INTERNAL,
    ERR_TOO_LARGE,
    MAX_REQUEST_BYTES,
    ProtocolError,
    decode_request,
    encode,
    failed,
    ok,
    peer_uid,
)
from .service_paths import SOCKET_FILE, ServiceConfig, config_path_for, public_dir, read_service_config

SOCKET_MODE = 0o666
AUDIT_FILE = "logs/rpc-audit.jsonl"
IDLE_TIMEOUT_SECONDS = 300.0
MAX_CONNECTIONS = 64
ROOT_UID = 0


def owner_uids(config: Callable[[], ServiceConfig | None]) -> Callable[[], frozenset[int]]:
    """root and gate-service.json's ownerUid; root alone when the file is missing or invalid."""
    def allowed() -> frozenset[int]:
        cfg = config()
        return frozenset({ROOT_UID} | ({cfg.owner_uid} if cfg else set()))
    return allowed


def config_loader(path: Path) -> Callable[[], ServiceConfig | None]:
    def load() -> ServiceConfig | None:
        try:
            return read_service_config(path)
        except GateError as exc:
            _log(f"gate-service.json: {exc}")
            return None
    return load


def _log(line: str) -> None:
    print(f"secret-gate rpc: {line}", file=sys.stderr, flush=True)


class _Handler(socketserver.StreamRequestHandler):
    server: RpcServer

    def handle(self) -> None:
        try:
            uid = peer_uid(self.request)
        except OSError as exc:
            _log(f"peer check failed ({exc}); connection closed")
            return
        if uid not in self.server.allowed_uids():
            _log(f"uid {uid} is not allowed; connection closed")
            return
        self.request.settimeout(IDLE_TIMEOUT_SECONDS)
        while True:
            try:
                line = self.rfile.readline(MAX_REQUEST_BYTES + 1)
            except OSError:
                return
            if not line:
                return
            if len(line) > MAX_REQUEST_BYTES and not line.endswith(b"\n"):
                self._send(failed(None, ERR_TOO_LARGE))
                return  # the rest of that line cannot be told apart from a next request
            if not self._send(self.server.answer(line.rstrip(b"\n"), uid)):
                return

    def _send(self, message: dict[str, Any]) -> bool:
        try:
            self.wfile.write(encode(message))
            self.wfile.flush()
        except OSError:
            return False
        return True


class RpcServer(socketserver.ThreadingMixIn, socketserver.UnixStreamServer):
    daemon_threads = True
    block_on_close = False

    def __init__(self, path: Path, service: GateService, allowed_uids: Callable[[], frozenset[int]],
                 audit_path: Path | None) -> None:
        self.service = service
        self.allowed_uids = allowed_uids
        self._audit_path = audit_path
        self._audit_lock = threading.Lock()
        self._slots = threading.BoundedSemaphore(MAX_CONNECTIONS)
        prepare_socket_path(path)
        super().__init__(str(path), _Handler)
        os.chmod(path, SOCKET_MODE)
        self.path = Path(path)

    def process_request(self, request: Any, client_address: Any) -> None:
        if not self._slots.acquire(blocking=False):
            self.shutdown_request(request)
            return
        try:
            super().process_request(request, client_address)
        except BaseException:
            self._slots.release()
            raise

    def process_request_thread(self, request: Any, client_address: Any) -> None:
        try:
            super().process_request_thread(request, client_address)
        finally:
            self._slots.release()

    def answer(self, line: bytes, uid: int) -> dict[str, Any]:
        """One request line in, one response out; never raises."""
        request_id, method, params = None, "?", {}
        try:
            request_id, method, params = decode_request(line)
            reply = self.service.call(method, params)
        except ProtocolError as exc:
            self._audit(method, uid, params, ok=False, error=str(exc))
            return failed(request_id, str(exc))
        except GateError as exc:
            self._audit(method, uid, params, ok=False, error=str(exc))
            return failed(request_id, str(exc))
        except Exception as exc:  # noqa: BLE001 - a bug must answer this call, not kill the connection thread
            _log(f"{method}: internal error {type(exc).__name__}")
            self._audit(method, uid, params, ok=False, error=type(exc).__name__)
            return failed(request_id, ERR_INTERNAL)
        self._audit(method, uid, params, ok=True, labels=reply.labels, host=reply.host)
        return ok(request_id, reply.value)

    def _audit(self, method: str, uid: int, params: dict[str, Any], *, ok: bool, error: str | None = None,
               labels: tuple[str, ...] = (), host: str | None = None) -> None:
        scope = params.get("scope") if isinstance(params.get("scope"), str) else None
        extra: dict[str, Any] = {"labels": list(labels)} if labels else {}
        if host:
            extra["host"] = host
        if error:
            extra["error"] = error[:300]
        with self._audit_lock:
            Audit(self._audit_path, scope).record("rpc", method=method[:64], uid=uid, ok=ok, **extra)

    def server_close(self) -> None:
        super().server_close()
        try:
            if stat.S_ISSOCK(self.path.lstat().st_mode):
                self.path.unlink()
        except OSError:
            pass


def prepare_socket_path(path: Path) -> None:
    """Remove a stale socket left by a previous run; refuse to replace anything else."""
    try:
        info = path.lstat()
    except FileNotFoundError:
        return
    if not stat.S_ISSOCK(info.st_mode):
        raise ValidationError(f"{path} 已存在且不是 socket，未覆盖")
    probe = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
    try:
        probe.settimeout(1.0)
        probe.connect(str(path))
    except OSError:
        path.unlink()  # nobody listens: stale
        return
    finally:
        probe.close()
    raise ValidationError(f"{path} 上已有服务在运行")


def build_server(home: Path, public: Path, config_path: Path, **service_kwargs: Any) -> RpcServer:
    config = config_loader(config_path)
    service = GateService(home, public, config, **service_kwargs)
    service.publish()
    return RpcServer(public / SOCKET_FILE, service, owner_uids(config), Path(home) / AUDIT_FILE)


def _cmd_rpc(args: argparse.Namespace) -> int:
    public = public_dir()
    config_path = Path(args.config) if args.config else config_path_for(public)
    server = build_server(gate_home(), public, config_path)

    def stop(_signum: int, _frame: object) -> None:
        threading.Thread(target=server.shutdown, daemon=True).start()

    signal.signal(signal.SIGTERM, stop)
    signal.signal(signal.SIGINT, stop)
    _log(f"listening on {server.path} (pid {os.getpid()}, {time.strftime('%Y-%m-%dT%H:%M:%S')})")
    try:
        server.serve_forever()
    finally:
        server.server_close()
    return 0


def add_rpc_parser(sub: argparse._SubParsersAction) -> None:
    r = sub.add_parser("rpc", help="gate service only: serve <SECRET_GATE_PUBLIC>/gate.sock (gate-service-v0 §3)")
    r.add_argument("--config", help="gate-service.json (default: next to the public directory)")
    r.set_defaults(fn=_cmd_rpc)
