"""Client of the gate service's `gate.sock` (gate-service-v0 §3): one connection per call.

A call that cannot reach the service fails with "凭据网关服务无响应"; it never falls back to a local gate
(that would quietly undo the isolation, §4 Mac 应用).
"""

from __future__ import annotations

import itertools
import socket
from pathlib import Path
from typing import Any

from .errors import GateError
from .rpc_protocol import MAX_REQUEST_BYTES, MAX_RESPONSE_BYTES, ProtocolError, decode_response, encode
from .service_paths import SERVICE_UNAVAILABLE

DEFAULT_TIMEOUT_SECONDS = 15.0
# Calls that wait for a site, a command or the dispatcher: the service's own limits (30 s HTTP, 60 s exec,
# 65 s repair) plus margin.
SLOW_METHOD_TIMEOUTS = {"mcp.http": 60.0, "mcp.exec": 90.0, "mcp.repair": 90.0}


class ServiceUnavailable(GateError):
    """The socket is missing, refused the connection, or the service did not answer in time."""


class RpcClient:
    def __init__(self, path: Path, *, timeout: float | None = None) -> None:
        self._path = Path(path)
        self._timeout = timeout
        self._ids = itertools.count(1)

    @property
    def path(self) -> Path:
        return self._path

    def call(self, method: str, params: dict[str, Any] | None = None) -> Any:
        request_id = next(self._ids)
        line = encode({"id": request_id, "method": method, "params": params or {}})
        if len(line) > MAX_REQUEST_BYTES:
            raise ProtocolError("请求超过 1 MiB")
        timeout = self._timeout or SLOW_METHOD_TIMEOUTS.get(method, DEFAULT_TIMEOUT_SECONDS)
        try:
            with socket.socket(socket.AF_UNIX, socket.SOCK_STREAM) as sock:
                sock.settimeout(timeout)
                sock.connect(str(self._path))
                sock.sendall(line)
                reply = _read_line(sock)
        except TimeoutError:
            raise ServiceUnavailable(f"{SERVICE_UNAVAILABLE}（等待超时）") from None
        except OSError as exc:
            raise ServiceUnavailable(f"{SERVICE_UNAVAILABLE}（{exc.strerror or exc}）") from None
        if not reply:
            raise ServiceUnavailable(f"{SERVICE_UNAVAILABLE}（连接被关闭）")
        return decode_response(reply, request_id)


def _read_line(sock: socket.socket) -> bytes:
    chunks: list[bytes] = []
    size = 0
    while True:
        chunk = sock.recv(65536)
        if not chunk:
            return b""  # closed before a full line: the peer check refused us, or the service died
        newline = chunk.find(b"\n")
        if newline >= 0:
            chunks.append(chunk[:newline])
            return b"".join(chunks)
        chunks.append(chunk)
        size += len(chunk)
        if size > MAX_RESPONSE_BYTES:
            raise ProtocolError("凭据网关服务的响应过大")
