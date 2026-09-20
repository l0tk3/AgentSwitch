"""Live end-to-end smoke test: real mitmdump proxy + local echo server + curl.

Run: .venv/bin/python scripts/smoke_e2e.py   (not part of pytest; needs the venv and curl).
Proves that (1) the site receives plaintext, (2) the client/model sees only [REDACTED:...],
(3) a token bound to one host is refused with 403 on another host, without leaking.
"""
import json
import os
import shutil
import socket
import subprocess
import sys
import threading
import time
from http.server import BaseHTTPRequestHandler, HTTPServer

ROOT = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
GATE = os.path.join(ROOT, ".venv", "bin", "secret-gate")
HOME = os.path.join(os.environ.get("TMPDIR", "/tmp"), "secret-gate-smoke-home")
ENV = {**os.environ, "SECRET_GATE_HOME": HOME}
PROXY_PORT, ECHO_PORT = 18080, 18081
FAKE_PASS, FAKE_BEARER = "Hunter2-Fake-Pa55!", "sk-fake-bearer-XYZ"
received: list[tuple] = []


class Echo(BaseHTTPRequestHandler):
    def do_POST(self):
        body = self.rfile.read(int(self.headers.get("Content-Length", 0))).decode()
        received.append((self.headers.get("Host"), self.headers.get("Authorization"), body))
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


def main() -> int:
    shutil.rmtree(HOME, ignore_errors=True)
    srv = HTTPServer(("127.0.0.1", ECHO_PORT), Echo)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    gate("keygen")
    tok = gate("enc", "--label", "echo/pass", "--host", "127.0.0.1", "--stdin", stdin=FAKE_PASS + "\n")
    bearer = gate("enc", "--label", "echo/bearer", "--host", "127.0.0.1", "--stdin", stdin=FAKE_BEARER + "\n")
    print("check:", gate("check", tok).replace("\n", " ; "))

    proxy = subprocess.Popen([GATE, "proxy", "-p", str(PROXY_PORT)], env=ENV, stdout=subprocess.DEVNULL, stderr=subprocess.PIPE)
    px = f"http://127.0.0.1:{PROXY_PORT}"
    try:
        wait_port(PROXY_PORT)
        allowed = curl("-x", px, "-H", f"Authorization: Bearer {bearer}", "-d", f"user=zhangsan&pass={tok}", f"http://127.0.0.1:{ECHO_PORT}/login")
        denied = curl("-i", "-x", px, "-d", f"pass={tok}", f"http://localhost:{ECHO_PORT}/login")
    except RuntimeError as exc:
        proxy.terminate()
        print(exc, "\nPROXY STDERR:\n", proxy.stderr.read().decode()[-1500:])
        return 1
    finally:
        proxy.terminate()
        proxy.wait(timeout=10)
        srv.shutdown()
        shutil.rmtree(HOME, ignore_errors=True)

    print("[1] server received:", received[0] if received else None)
    print("[1] client saw:     ", allowed.strip())
    print("[2] wrong host -> server hits:", len(received), "| client saw:", denied.splitlines()[0] if denied else "")
    ok = (
        len(received) == 1
        and received[0][2] == f"user=zhangsan&pass={FAKE_PASS}"
        and received[0][1] == f"Bearer {FAKE_BEARER}"
        and FAKE_PASS not in allowed and FAKE_BEARER not in allowed
        and "[REDACTED:echo/pass]" in allowed and "[REDACTED:echo/bearer]" in allowed
        and " 403 " in denied and FAKE_PASS not in denied
    )
    print("\nSMOKE", "PASS" if ok else "FAIL")
    return 0 if ok else 1


if __name__ == "__main__":
    sys.exit(main())
