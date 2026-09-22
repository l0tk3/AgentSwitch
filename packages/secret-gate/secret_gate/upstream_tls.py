"""Per-host opt-out of upstream certificate verification.

Internal sites often run on self-signed certificates; mitmproxy then answers "502 Bad Gateway: certificate verify
failed" and the model can do nothing about it. `upstream-insecure.txt` in the gate home lists the hosts whose
certificates are accepted unverified; every other host stays strictly verified. Script addons run before mitmproxy's
own TlsConfig, so providing `tls_start.ssl_conn` here is the supported way to take over one server connection.
"""

from __future__ import annotations

import logging
from pathlib import Path

from OpenSSL import SSL
from mitmproxy import ctx, tls
from mitmproxy.addons.tlsconfig import _default_ciphers  # mirror mitmproxy's own defaults for the context we replace
from mitmproxy.net import tls as net_tls

UPSTREAM_INSECURE_FILE = "upstream-insecure.txt"
_log = logging.getLogger(__name__)


def parse_insecure_hosts(text: str) -> frozenset[str]:
    """One pattern per line: `host`, `host:port` or `*.suffix`; `#` starts a comment. Case-insensitive."""
    out: set[str] = set()
    for raw in text.splitlines():
        line = raw.split("#", 1)[0].strip().lower()
        if line:
            out.add(line)
    return frozenset(out)


def load_insecure_hosts(home: Path) -> frozenset[str]:
    path = home / UPSTREAM_INSECURE_FILE
    return parse_insecure_hosts(path.read_text()) if path.exists() else frozenset()


def host_is_insecure(patterns: frozenset[str], host: str, port: int) -> bool:
    """`host:port` beats `host`; `*.example` matches any subdomain (not the apex)."""
    h = host.lower().rstrip(".")
    if f"{h}:{port}" in patterns or h in patterns:
        return True
    return any(p.startswith("*.") and h.endswith(p[1:]) and h != p[2:] for p in patterns)


class UpstreamTlsAddon:
    """Takes over the proxy→server TLS handshake for listed hosts with verification off."""

    def __init__(self, patterns: frozenset[str]) -> None:
        self._patterns = patterns
        self._warned: set[str] = set()

    def tls_start_server(self, tls_start: tls.TlsData) -> None:
        if tls_start.ssl_conn is not None or not tls_start.conn.address:
            return
        host, port = tls_start.conn.address[0], tls_start.conn.address[1]
        if not host_is_insecure(self._patterns, host, port):
            return
        server = tls_start.conn
        if server.sni is None:
            server.sni = tls_start.context.client.sni or host
        min_version = net_tls.Version[ctx.options.tls_version_server_min]
        ssl_ctx = net_tls.create_proxy_server_context(
            method=net_tls.Method.DTLS_CLIENT_METHOD if tls_start.is_dtls else net_tls.Method.TLS_CLIENT_METHOD,
            min_version=min_version,
            max_version=net_tls.Version[ctx.options.tls_version_server_max],
            cipher_list=tuple(server.cipher_list or _default_ciphers(min_version)),
            ecdh_curve=net_tls.get_curve(ctx.options.tls_ecdh_curve_server),
            verify=net_tls.Verify.VERIFY_NONE,
            ca_path=None,
            ca_pemfile=None,
            client_cert=None,
            legacy_server_connect=True,
        )
        conn = SSL.Connection(ssl_ctx)
        if isinstance(server.sni, str):
            try:
                conn.set_tlsext_host_name(server.sni.encode("idna"))
            except (UnicodeError, ValueError):  # an IP literal has no SNI
                pass
        if server.alpn_offers:
            conn.set_alpn_protos(list(server.alpn_offers))
        conn.set_connect_state()
        tls_start.ssl_conn = conn
        key = f"{host}:{port}"
        if key not in self._warned:
            self._warned.add(key)
            _log.warning("secret-gate: upstream certificate of %s is NOT verified (listed in %s)", key, UPSTREAM_INSECURE_FILE)
