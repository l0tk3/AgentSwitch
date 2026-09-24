"""Loopback probes of a running gate proxy, for `service status` and `bootstrap`.

Two questions, answered without any traffic leaving the machine:

* Is anything listening on 127.0.0.1:<port>? (TCP connect.)
* Is that listener the secret-gate proxy? A plain web server on 8080 is common, and so is a bare mitmproxy
  started for something else. The probe sends one absolute-form request for `http://127.0.0.1:9/` (loopback
  discard port) carrying a well-formed but undecryptable `enc:v1:` value. The gate addon refuses it in its
  request hook with `403` + `X-Secret-Gate: denied` (the documented denial contract in AGENTS.md) before any
  upstream connection is made; a bare mitmproxy would try 127.0.0.1:9 and answer 502 with
  `Server: mitmproxy`; anything else answers something else. Even in the worst case the request stays on loopback.
"""

from __future__ import annotations

import socket
from collections.abc import Callable
from dataclasses import dataclass

LOOPBACK = "127.0.0.1"
PROBE_TIMEOUT_SECONDS = 2.0
MAX_RESPONSE_HEAD_BYTES = 8192
# Matches the token pattern, but 18 zero bytes are not a sealed box: decryption always fails.
PROBE_TOKEN = "enc:v1:" + "A" * 24
PROBE_TARGET = f"{LOOPBACK}:9"
PROBE_HEADER = "X-Secret-Gate-Probe"

VERDICT_GATE = "gate"
VERDICT_MITMPROXY = "mitmproxy"
VERDICT_OTHER_HTTP = "other-http"
VERDICT_NOT_HTTP = "not-http"
VERDICT_UNREACHABLE = "unreachable"

Connect = Callable[..., socket.socket]


@dataclass(frozen=True)
class ProbeResult:
    verdict: str
    detail: str

    @property
    def is_gate(self) -> bool:
        return self.verdict == VERDICT_GATE


def tcp_reachable(port: int, host: str = LOOPBACK, timeout: float = PROBE_TIMEOUT_SECONDS,
                  connect: Connect = socket.create_connection) -> bool:
    try:
        with connect((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def probe_request() -> bytes:
    """The single request the gate probe sends (pure, so the test can pin what goes on the wire)."""
    return (
        f"GET http://{PROBE_TARGET}/secret-gate-probe HTTP/1.1\r\n"
        f"Host: {PROBE_TARGET}\r\n"
        f"{PROBE_HEADER}: {PROBE_TOKEN}\r\n"
        "Connection: close\r\n\r\n"
    ).encode("ascii")


def _parse_head(raw: bytes) -> tuple[str, dict[str, str]]:
    head = raw.split(b"\r\n\r\n", 1)[0].decode("latin-1")
    status_line, *header_lines = head.split("\r\n")
    headers: dict[str, str] = {}
    for line in header_lines:
        name, sep, value = line.partition(":")
        if sep:
            headers.setdefault(name.strip().lower(), value.strip())
    return status_line, headers


def classify_response(raw: bytes) -> ProbeResult:
    """Pure: decide what answered from the response head alone."""
    status_line, headers = _parse_head(raw)
    parts = status_line.split(" ", 2)
    if len(parts) < 2 or not parts[0].startswith("HTTP/1.") or not parts[1].isdigit():
        return ProbeResult(VERDICT_NOT_HTTP, "the listener does not speak HTTP/1.x")
    status = int(parts[1])
    server = headers.get("server", "")
    if status == 403 and headers.get("x-secret-gate", "").lower() == "denied":
        return ProbeResult(VERDICT_GATE, "refused the probe value with 403 X-Secret-Gate: denied")
    if server.lower().startswith("mitmproxy"):
        return ProbeResult(VERDICT_MITMPROXY, f"a mitmproxy without the secret-gate addon answered {status} ({server})")
    return ProbeResult(VERDICT_OTHER_HTTP, f"another HTTP server answered {status}" + (f" (Server: {server})" if server else ""))


def _read_head(sock: socket.socket) -> bytes:
    buf = b""
    while b"\r\n\r\n" not in buf and len(buf) < MAX_RESPONSE_HEAD_BYTES:
        chunk = sock.recv(4096)
        if not chunk:
            break
        buf += chunk
    return buf


def probe_gate(port: int, host: str = LOOPBACK, timeout: float = PROBE_TIMEOUT_SECONDS,
               connect: Connect = socket.create_connection) -> ProbeResult:
    try:
        with connect((host, port), timeout=timeout) as sock:
            sock.sendall(probe_request())
            raw = _read_head(sock)
    except OSError as exc:
        return ProbeResult(VERDICT_UNREACHABLE, f"{host}:{port}: {exc.strerror or exc}")
    if not raw:
        return ProbeResult(VERDICT_NOT_HTTP, "the listener closed the connection without answering")
    return classify_response(raw)
