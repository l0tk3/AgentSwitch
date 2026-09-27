"""Wire format of `gate.sock` (gate-service-v0 §3.1) and the peer credential check.

One JSON object per line each way:
    request   {"id": <int|str>, "method": "<name>", "params": {...}}
    response  {"id": ..., "ok": true, "result": ...}  |  {"id": ..., "ok": false, "error": "<reason>"}
A request line is at most 1 MiB. Protocol errors are in Chinese (the Mac app shows them); errors raised by the
gate's own checks keep their existing text, so a model or the daemon reads exactly what it read before the
gate became a service.

Peer check: the kernel's record of the connecting process's effective uid, `LOCAL_PEERCRED` (struct xucred) on
macOS, `SO_PEERCRED` on Linux. Nothing the client sends can change it.
"""

from __future__ import annotations

import json
import socket
import struct
import sys
from typing import Any

from .errors import GateError

MAX_REQUEST_BYTES = 1 << 20
MAX_RESPONSE_BYTES = 64 << 20
ENCODING = "utf-8"

# <sys/un.h>, <sys/ucred.h>: SOL_LOCAL 0, LOCAL_PEERCRED 1; struct xucred {u_int cr_version; uid_t cr_uid;
# short cr_ngroups; gid_t cr_groups[16];} = 76 bytes, XUCRED_VERSION 0.
SOL_LOCAL = 0
LOCAL_PEERCRED = 1
XUCRED_SIZE = 76
XUCRED_VERSION = 0

ERR_INVALID_JSON = "请求不是有效的 JSON 对象"
ERR_TOO_LARGE = "请求超过 1 MiB"
ERR_INTERNAL = "凭据网关服务内部错误"


class ProtocolError(GateError):
    """The request could not be read as a call (bad JSON, too large, wrong shape)."""


class RemoteError(GateError):
    """The service refused or failed a call; the message is the service's own reason."""


def peer_uid(sock: socket.socket, platform: str = sys.platform) -> int:
    """Effective uid of the process at the other end of a connected AF_UNIX socket."""
    if platform == "darwin":
        raw = sock.getsockopt(SOL_LOCAL, LOCAL_PEERCRED, XUCRED_SIZE)
        version, uid = struct.unpack_from("=II", raw)
        if version != XUCRED_VERSION:
            raise OSError(f"unexpected xucred version {version}")
        return uid
    peercred = getattr(socket, "SO_PEERCRED", None)
    if peercred is None:
        raise OSError("no peer credentials on this platform")
    _pid, uid, _gid = struct.unpack("3i", sock.getsockopt(socket.SOL_SOCKET, peercred, struct.calcsize("3i")))
    return uid


def encode(message: dict[str, Any]) -> bytes:
    return (json.dumps(message, ensure_ascii=False, separators=(",", ":")) + "\n").encode(ENCODING)


def decode_request(line: bytes) -> tuple[Any, str, dict[str, Any]]:
    """(id, method, params) of one request line; ProtocolError carries the reason to send back."""
    if len(line) > MAX_REQUEST_BYTES:
        raise ProtocolError(ERR_TOO_LARGE)
    try:
        data = json.loads(line.decode(ENCODING))
    except (ValueError, UnicodeDecodeError):
        raise ProtocolError(ERR_INVALID_JSON) from None
    if not isinstance(data, dict) or set(data) - {"id", "method", "params"}:
        raise ProtocolError(ERR_INVALID_JSON)
    request_id, method, params = data.get("id"), data.get("method"), data.get("params", {})
    if request_id is not None and (isinstance(request_id, bool) or not isinstance(request_id, (int, str))):
        raise ProtocolError("请求 id 应为整数或字符串")
    if not isinstance(method, str) or not method:
        raise ProtocolError("请求缺少 method")
    if params is None:
        params = {}
    if not isinstance(params, dict):
        raise ProtocolError("params 应为 JSON 对象")
    return request_id, method, params


def ok(request_id: Any, result: Any) -> dict[str, Any]:
    return {"id": request_id, "ok": True, "result": result}


def failed(request_id: Any, reason: str) -> dict[str, Any]:
    return {"id": request_id, "ok": False, "error": reason}


def decode_response(line: bytes, request_id: Any) -> Any:
    """The result of a response line, or RemoteError with the service's reason."""
    try:
        data = json.loads(line.decode(ENCODING))
    except (ValueError, UnicodeDecodeError):
        raise ProtocolError("凭据网关服务返回了无效的响应") from None
    if not isinstance(data, dict) or data.get("id") != request_id or not isinstance(data.get("ok"), bool):
        raise ProtocolError("凭据网关服务返回了无效的响应")
    if data["ok"]:
        return data.get("result")
    error = data.get("error")
    raise RemoteError(error if isinstance(error, str) and error else ERR_INTERNAL)
