"""Loopback probes: every socket here is one the test opens itself on 127.0.0.1."""

from __future__ import annotations

import socket
import threading

import pytest

from secret_gate.proxy_probe import (
    PROBE_TARGET,
    PROBE_TOKEN,
    VERDICT_GATE,
    VERDICT_MITMPROXY,
    VERDICT_NOT_HTTP,
    VERDICT_OTHER_HTTP,
    VERDICT_UNREACHABLE,
    classify_response,
    probe_gate,
    probe_request,
    tcp_reachable,
)

GATE_403 = (b"HTTP/1.1 403 Forbidden\r\nContent-Type: text/plain\r\nX-Secret-Gate: denied\r\n"
            b"content-length: 3\r\n\r\nno\n")
MITM_502 = b"HTTP/1.1 502 Bad Gateway\r\nServer: mitmproxy 12.2.3\r\nConnection: close\r\n\r\n"


class OneShotServer:
    """Accepts one connection on 127.0.0.1, records the request head, answers with `reply` (or nothing)."""

    def __init__(self, reply: bytes) -> None:
        self.reply = reply
        self.received = b""
        self.sock = socket.socket()
        self.sock.bind(("127.0.0.1", 0))
        self.sock.listen(1)
        self.port = self.sock.getsockname()[1]
        self.thread = threading.Thread(target=self._serve, daemon=True)
        self.thread.start()

    def _serve(self) -> None:
        conn, _ = self.sock.accept()
        with conn:
            conn.settimeout(2)
            while b"\r\n\r\n" not in self.received:
                chunk = conn.recv(4096)
                if not chunk:
                    break
                self.received += chunk
            if self.reply:
                conn.sendall(self.reply)
        self.sock.close()

    def join(self) -> None:
        self.thread.join(timeout=5)


def _free_port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]  # closed on exit: nothing listens there afterwards


def test_probe_request_is_absolute_form_to_loopback_with_an_undecryptable_value():
    raw = probe_request().decode()
    assert raw.startswith(f"GET http://{PROBE_TARGET}/")
    assert PROBE_TARGET.startswith("127.0.0.1:")
    assert PROBE_TOKEN in raw and raw.endswith("\r\n\r\n")


@pytest.mark.parametrize("raw,verdict", [
    (GATE_403, VERDICT_GATE),
    (MITM_502, VERDICT_MITMPROXY),
    (b"HTTP/1.1 404 Not Found\r\nServer: nginx\r\n\r\n", VERDICT_OTHER_HTTP),
    (b"HTTP/1.0 200 OK\r\n\r\n", VERDICT_OTHER_HTTP),
    (b"HTTP/1.1 403 Forbidden\r\nX-Secret-Gate: something-else\r\n\r\n", VERDICT_OTHER_HTTP),
    (b"SSH-2.0-OpenSSH_9.8\r\n", VERDICT_NOT_HTTP),
    (b"HTTP/1.1 abc\r\n\r\n", VERDICT_NOT_HTTP),
    (b"HTTP/2 200\r\n\r\n", VERDICT_NOT_HTTP),
])
def test_classify_response(raw, verdict):
    result = classify_response(raw)
    assert result.verdict == verdict
    assert result.is_gate is (verdict == VERDICT_GATE)


def test_other_http_names_the_server():
    assert "nginx" in classify_response(b"HTTP/1.1 404 Not Found\r\nServer: nginx\r\n\r\n").detail


def test_tcp_reachable_against_own_listener():
    server = OneShotServer(b"")
    assert tcp_reachable(server.port)
    server.join()
    assert not tcp_reachable(_free_port())


def test_probe_gate_sends_the_probe_and_recognises_the_gate():
    server = OneShotServer(GATE_403)
    result = probe_gate(server.port)
    server.join()
    assert result.verdict == VERDICT_GATE
    assert server.received == probe_request()


def test_probe_gate_bare_mitmproxy_and_silent_listener():
    mitm = OneShotServer(MITM_502)
    assert probe_gate(mitm.port).verdict == VERDICT_MITMPROXY
    mitm.join()
    silent = OneShotServer(b"")
    assert probe_gate(silent.port).verdict == VERDICT_NOT_HTTP
    silent.join()


def test_probe_gate_unreachable():
    result = probe_gate(_free_port(), timeout=0.5)
    assert result.verdict == VERDICT_UNREACHABLE and not result.is_gate
