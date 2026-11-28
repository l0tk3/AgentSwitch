"""The gateway run for real (mitmdump with the addon): a scope's connections go on through its `upstream` proxy.

Until 2026-11-28 none did: the proxy was named in a hook that comes after mitmproxy has decided how to connect, and
no test ran the proxy itself — every connection of a terminal with a proxy of its own went straight out."""

from __future__ import annotations

import base64
import http.client
import http.server
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
from pathlib import Path

import pytest

MITMDUMP = shutil.which("mitmdump", path=str(Path(sys.executable).parent)) or shutil.which("mitmdump")
pytestmark = pytest.mark.skipif(not MITMDUMP or sys.platform == "win32", reason="needs mitmdump")


def _port() -> int:
    with socket.socket() as s:
        s.bind(("127.0.0.1", 0))
        return s.getsockname()[1]


class _Target(http.server.BaseHTTPRequestHandler):
    def do_GET(self) -> None:  # noqa: N802
        self.server.hits.append(self.path)  # type: ignore[attr-defined]
        self.send_response(200)
        self.send_header("content-length", "2")
        self.end_headers()
        self.wfile.write(b"ok")

    def log_message(self, *a: object) -> None:
        pass


def _forwarder(seen: list[str]) -> int:
    """An HTTP proxy that takes CONNECT, writes down what it was asked, and passes the bytes on."""
    port = _port()
    ls = socket.socket()
    ls.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    ls.bind(("127.0.0.1", port))
    ls.listen(20)

    def pipe(a: socket.socket, b: socket.socket) -> None:
        try:
            while d := a.recv(65536):
                b.sendall(d)
        except OSError:
            pass
        for s in (a, b):
            try:
                s.shutdown(socket.SHUT_RDWR)
            except OSError:
                pass

    def serve(c: socket.socket) -> None:
        head = b""
        while b"\r\n\r\n" not in head:
            d = c.recv(4096)
            if not d:
                return
            head += d
        seen.append(head.decode("latin1"))
        method, target, _ = head.split(b"\r\n")[0].decode().split(" ")
        if method != "CONNECT":
            c.close()
            return
        u = socket.create_connection(("127.0.0.1", int(target.rsplit(":", 1)[1])))
        c.sendall(b"HTTP/1.1 200 OK\r\n\r\n")
        threading.Thread(target=pipe, args=(c, u), daemon=True).start()
        pipe(u, c)

    def loop() -> None:
        while True:
            try:
                c, _ = ls.accept()
            except OSError:
                return
            threading.Thread(target=serve, args=(c,), daemon=True).start()

    threading.Thread(target=loop, daemon=True).start()
    return port


@pytest.fixture
def rig(tmp_path):
    target = http.server.ThreadingHTTPServer(("127.0.0.1", 0), _Target)
    target.hits = []  # type: ignore[attr-defined]
    threading.Thread(target=target.serve_forever, daemon=True).start()
    seen: list[str] = []
    fwd, port = _forwarder(seen), _port()
    # The addon of this checkout by its file: another checkout's, installed for development, would be found first.
    import secret_gate.model_gate as tested
    entry = tmp_path / "entry.py"
    entry.write_text("import importlib.util, sys\n"
                     f"spec = importlib.util.spec_from_file_location('model_gate_under_test', {tested.__file__!r})\n"
                     "mg = importlib.util.module_from_spec(spec)\nsys.modules[spec.name] = mg\nspec.loader.exec_module(mg)\naddons = [mg.ModelGate()]\n")
    env = {"HOME": str(tmp_path), "PATH": "/usr/bin:/bin", "PYTHONDONTWRITEBYTECODE": "1"}
    gate = subprocess.Popen([MITMDUMP, "-q", "-s", str(entry), "-p", str(port), "--listen-host", "127.0.0.1", "--set", "http2=false", "--set", f"confdir={tmp_path / 'conf'}"],
                            stdin=subprocess.PIPE, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, env=env)
    for _ in range(100):
        try:
            socket.create_connection(("127.0.0.1", port), timeout=0.2).close()
            break
        except OSError:
            time.sleep(0.1)

    def ask(upstream: str | None, opened: bool) -> tuple[int, int, list[str]]:
        """One plain-http request of scope `t` through the gateway: (status, times the target was reached, what the forwarder was asked)."""
        table = {"logDir": str(tmp_path / "logs"), "scopes": {"t": {"hosts": ["localhost"] if opened else ["other.example"], "upstream": upstream, "pairs": [], "patterns": [], "log": False}}}
        gate.stdin.write((json.dumps(table) + "\n").encode())
        gate.stdin.flush()
        time.sleep(0.4)
        seen.clear()
        target.hits.clear()  # type: ignore[attr-defined]
        # Asked of the gateway itself (urllib would go round a proxy for `localhost`).
        c = http.client.HTTPConnection("127.0.0.1", port, timeout=10)
        c.request("GET", f"http://localhost:{target.server_address[1]}/x", headers={"Proxy-Authorization": "Basic " + base64.b64encode(b"s:t").decode()})
        r = c.getresponse()
        status = r.status
        r.read()
        c.close()
        return status, len(target.hits), list(seen)  # type: ignore[attr-defined]

    try:
        yield ask, fwd
    finally:
        gate.stdin.close()
        try:
            gate.wait(timeout=5)
        except subprocess.TimeoutExpired:
            gate.kill()
        target.shutdown()


def test_a_scopes_connections_go_on_through_its_own_proxy_and_never_straight_out(rig):
    ask, fwd = rig
    for opened in (True, False):
        status, hits, asked = ask(f"http://127.0.0.1:{fwd}", opened)
        assert (status, hits) == (200, 1)
        assert [a.split(" ")[0] for a in asked] == ["CONNECT"], "the request went on through the scope's proxy"
    # Its name and password go with it.
    _, _, asked = ask(f"http://user:pw%40x@127.0.0.1:{fwd}", True)
    assert "proxy-authorization: basic dxnlcjpwd0b4" in asked[0].lower()
    # No proxy of its own: straight out.
    assert ask(None, True) == (200, 1, [])
    # A proxy that is not there: refused, not sent straight out instead.
    status, hits, asked = ask(f"http://127.0.0.1:{_port()}", True)
    assert status == 502 and hits == 0 and asked == []
