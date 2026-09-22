from pathlib import Path

from mitmproxy import connection, options, tls
from mitmproxy.addons import tlsconfig
from mitmproxy.proxy import context
from mitmproxy.test import taddons, tflow

from secret_gate.upstream_tls import UpstreamTlsAddon, host_is_insecure, load_insecure_hosts, parse_insecure_hosts


def test_parse_and_match():
    pats = parse_insecure_hosts("# internal\ncore.internal.example:8600\nMail.internal.example\n*.lab.example\n\n")
    assert pats == {"core.internal.example:8600", "mail.internal.example", "*.lab.example"}
    assert host_is_insecure(pats, "core.internal.example", 8600)
    assert not host_is_insecure(pats, "core.internal.example", 8400)      # port-specific entry
    assert host_is_insecure(pats, "MAIL.internal.example", 443)           # any port, case-insensitive
    assert host_is_insecure(pats, "db.lab.example", 5432)
    assert not host_is_insecure(pats, "lab.example", 443)                 # wildcard excludes the apex
    assert not host_is_insecure(pats, "github.com", 443)


def test_load_missing_file_is_empty(tmp_path: Path):
    assert load_insecure_hosts(tmp_path) == frozenset()
    (tmp_path / "upstream-insecure.txt").write_text("a.example\n")
    assert load_insecure_hosts(tmp_path) == {"a.example"}


def _tls_start(host: str, port: int) -> tls.TlsData:
    client = tflow.tclient_conn()
    server = connection.Server(address=(host, port))
    return tls.TlsData(conn=server, context=context.Context(client, options.Options()))


def test_addon_only_takes_over_listed_hosts():
    addon = UpstreamTlsAddon(frozenset({"core.internal.example:8600"}))
    with taddons.context(tlsconfig.TlsConfig(), addon):                    # TlsConfig registers the tls_* options a running proxy has
        listed = _tls_start("core.internal.example", 8600)
        addon.tls_start_server(listed)
        assert listed.ssl_conn is not None                                # our unverified connection object
        other = _tls_start("github.com", 443)
        addon.tls_start_server(other)
        assert other.ssl_conn is None                                      # left to mitmproxy's strict TlsConfig
        again = _tls_start("core.internal.example", 8600)
        again.ssl_conn = listed.ssl_conn
        addon.tls_start_server(again)                                      # never replaces a connection someone else set
        assert again.ssl_conn is listed.ssl_conn
