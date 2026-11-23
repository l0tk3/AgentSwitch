"""A local HTTPS site for the Windows service smoke (windows_service_smoke.ps1): it echoes the Authorization header it
received in its body and appends it to a file, so the smoke can check both sides of the proxy: the site got the real
value, the client saw it redacted. Self-signed (the smoke lists it in the gate's upstream-insecure.txt).

    python echo_https.py <port> <received-file>
"""

from __future__ import annotations

import datetime
import http.server
import ssl
import sys
import tempfile
from pathlib import Path

from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID


def self_signed(directory: Path) -> tuple[Path, Path]:
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "localhost")])
    now = datetime.datetime.now(datetime.timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(x509.random_serial_number()).not_valid_before(now - datetime.timedelta(minutes=5))
            .not_valid_after(now + datetime.timedelta(days=1))
            .add_extension(x509.SubjectAlternativeName([x509.DNSName("localhost")]), critical=False)
            .sign(key, hashes.SHA256()))
    cert_path, key_path = directory / "echo.pem", directory / "echo.key"
    cert_path.write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    key_path.write_bytes(key.private_bytes(serialization.Encoding.PEM, serialization.PrivateFormat.PKCS8,
                                           serialization.NoEncryption()))
    return cert_path, key_path


def main() -> None:
    port, received = int(sys.argv[1]), Path(sys.argv[2])

    class Echo(http.server.BaseHTTPRequestHandler):
        def do_GET(self) -> None:  # noqa: N802
            value = self.headers.get("Authorization", "")
            with received.open("a", encoding="utf-8") as fh:
                fh.write(value + "\n")
            body = f"you sent: {value}\n".encode()
            self.send_response(200)
            self.send_header("Content-Type", "text/plain; charset=utf-8")
            self.send_header("Content-Length", str(len(body)))
            self.end_headers()
            self.wfile.write(body)

        def log_message(self, *_args) -> None:
            pass

    context = ssl.SSLContext(ssl.PROTOCOL_TLS_SERVER)
    context.load_cert_chain(*self_signed(Path(tempfile.mkdtemp())))
    server = http.server.ThreadingHTTPServer(("127.0.0.1", port), Echo)
    server.socket = context.wrap_socket(server.socket, server_side=True)
    print(f"echo on https://localhost:{port}", flush=True)
    server.serve_forever()


if __name__ == "__main__":
    main()
