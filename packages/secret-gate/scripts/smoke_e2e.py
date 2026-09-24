"""Live end-to-end smoke test: real mitmdump proxy + local echo server + curl.

Run: .venv/bin/python scripts/smoke_e2e.py   (not part of pytest; needs the venv and curl).
Proves that (1) the site receives plaintext, (2) the client/model sees only [REDACTED:...],
(3) a token bound to one host is refused with 403 on another host, without leaking, and for
task-scoped references (gate-next-v0 §1): (4) an enc:ref: resolves when the proxy URL carries the
execution scope, over plain http and (5) over HTTPS CONNECT, the scope never reaches the site, and
(6) the same reference without the scope is refused.
"""
import json
import os
import shutil
import socket
import ssl
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GATE = os.path.join(ROOT, ".venv", "bin", "secret-gate")
HOME = os.path.join(os.environ.get("TMPDIR", "/tmp"), "secret-gate-smoke-home")
ENV = {**os.environ, "SECRET_GATE_HOME": HOME}
PROXY_PORT, ECHO_PORT, TLS_PORT = 18080, 18081, 18443
SCOPE = "smoke-scope-0123456789abcdefgh"
FAKE_PASS, FAKE_BEARER = "Hunter2-Fake-Pa55!", "sk-fake-bearer-XYZ"
received: list[tuple] = []


class Echo(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode()
        received.append((self.headers.get("Host"), self.headers.get("Authorization"), body, self.headers.get("Proxy-Authorization")))
        out = json.dumps({"got": body, "auth": self.headers.get("Authorization")}).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Content-Length", str(len(out)))
        self.end_headers()
        self.wfile.write(out)

    def log_message(self, *_):
        pass


def wait_port(port: int) -> None:
    for _ in range(100):
        with socket.socket() as s:
            if s.connect_ex(("127.0.0.1", port)) == 0:
                return
        time.sleep(0.1)
    raise RuntimeError(f"port {port} never opened")


def gate(*args: str, stdin: str | None = None) -> str:
    return subprocess.run([GATE, *args], capture_output=True, text=True, env=ENV, input=stdin, check=True).stdout.strip()


def curl(*args: str) -> str:
    return subprocess.run(["curl", "-s", *args], capture_output=True, text=True, check=False).stdout


def tls_server() -> HTTPServer:
    """A self-signed HTTPS echo, listed in upstream-insecure.txt so the proxy accepts it."""
    subprocess.run(["openssl", "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=127.0.0.1",
                    "-keyout", os.path.join(HOME, "tls.key"), "-out", os.path.join(HOME, "tls.pem")],
                   check=True, capture_output=True)
    with open(os.path.join(HOME, "upstream-insecure.txt"), "w") as fh:
        fh.write(f"127.0.0.1:{TLS_PORT}\n")
    srv = HTTPServer(("127.0.0.1", TLS_PORT), Echo)
    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(os.path.join(HOME, "tls.pem"), os.path.join(HOME, "tls.key"))
    srv.socket = context.wrap_socket(srv.socket, server_side=True)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv


def main() -> int:
    shutil.rmtree(HOME, ignore_errors=True)
    srv = HTTPServer(("127.0.0.1", ECHO_PORT), Echo)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    gate("keygen")
    tls = tls_server()
    tok = gate("enc", "--label", "echo/pass", "--host", "127.0.0.1", "--stdin", stdin=FAKE_PASS + "\n")
    bearer = gate("enc", "--label", "echo/bearer", "--host", "127.0.0.1", "--stdin", stdin=FAKE_BEARER + "\n")
    print("check:", gate("check", tok).replace("\n", " ; "))
    ref = json.loads(gate("refs", "register", stdin=json.dumps({"scope": SCOPE, "tokens": [tok]})))["refs"][0]["ref"]
    print("ref:", ref)

    proxy = subprocess.Popen([GATE, "proxy", "-p", str(PROXY_PORT)], env=ENV, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    px = f"http://127.0.0.1:{PROXY_PORT}"
    try:
        wait_port(PROXY_PORT)
        allowed = curl("-x", px, "-H", f"Authorization: Bearer {bearer}", "-d", f"user=zhangsan&pass={tok}", f"http://127.0.0.1:{ECHO_PORT}/login")
        denied = curl("-i", "-x", px, "-d", f"pass={tok}", f"http://localhost:{ECHO_PORT}/login")
        scoped_px = f"http://scope:{SCOPE}@127.0.0.1:{PROXY_PORT}"
        by_ref = curl("-x", scoped_px, "-d", f"pass={ref}", f"http://127.0.0.1:{ECHO_PORT}/login")
        by_ref_tls = curl("-k", "-x", scoped_px, "-d", f"pass={ref}", f"https://127.0.0.1:{TLS_PORT}/login")
        no_scope = curl("-i", "-x", px, "-d", f"pass={ref}", f"http://127.0.0.1:{ECHO_PORT}/login")
        released = json.loads(gate("refs", "release", stdin=json.dumps({"scope": SCOPE})))["released"]
        after_release = curl("-i", "-x", scoped_px, "-d", f"pass={ref}", f"http://127.0.0.1:{ECHO_PORT}/login")
    except RuntimeError as exc:
        proxy.terminate()
        print(exc, "\nPROXY STDERR:\n", proxy.stderr.read().decode()[-1500:])
        return 1
    finally:
        proxy.terminate()
        proxy.wait(timeout=10)
        srv.shutdown()
        tls.shutdown()
        shutil.rmtree(HOME, ignore_errors=True)

    print("[1] server received:", received[0] if received else None)
    print("[1] client saw:     ", allowed.strip())
    print("[2] wrong host -> client saw:", denied.splitlines()[0] if denied else "")
    print("[4] enc:ref over http, server received:", received[1][2] if len(received) > 1 else None, "| client saw:", by_ref.strip())
    print("[5] enc:ref over HTTPS CONNECT, server received:", received[2][2] if len(received) > 2 else None, "| client saw:", by_ref_tls.strip())
    print("[6] enc:ref without scope ->", no_scope.splitlines()[0] if no_scope else "", "| after release ->",
          after_release.splitlines()[0] if after_release else "", f"({released} released)")
    ok = (
        len(received) == 3
        and received[0][2] == f"user=zhangsan&pass={FAKE_PASS}"
        and received[0][1] == f"Bearer {FAKE_BEARER}"
        and FAKE_PASS not in allowed and FAKE_BEARER not in allowed
        and "[REDACTED:echo/pass]" in allowed and "[REDACTED:echo/bearer]" in allowed
        and " 403 " in denied and FAKE_PASS not in denied
        and received[1][2] == received[2][2] == f"pass={FAKE_PASS}"
        and all(r[3] is None for r in received)  # the scope never reaches the site
        and FAKE_PASS not in by_ref + by_ref_tls and "[REDACTED:echo/pass]" in by_ref and "[REDACTED:echo/pass]" in by_ref_tls
        and " 403 " in no_scope and "task scope" in no_scope
        and released == 1 and " 403 " in after_release and "released" in after_release
    )
    print("\nSMOKE", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
