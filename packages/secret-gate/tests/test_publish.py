"""keys.json / ca.pem publication (gate-service-v0 §3.3), proxy.pid, and SIGHUP key reload in the proxy (§2)."""

from __future__ import annotations

import asyncio
import json
import os
import signal
import stat

import pytest

from secret_gate.constants import USE_HTTP
from secret_gate.crypto import generate_keypair
from secret_gate.errors import KeyStoreError, TokenError
from secret_gate.keyring import create_keypair, set_current
from secret_gate.keystore import save_keypair
from secret_gate.policy import SecretPayload
from secret_gate.proxy_addon import SecretGateAddon
from secret_gate.proxy_pid import PidFileAddon, alive, proxy_running, read_pid, remove_pid, signal_proxy, write_pid
from secret_gate.publish import current_public_key, parse_rows, publish_ca, publish_keys, read_rows
from secret_gate.reload import InsecureHostsReloader
from secret_gate.resolver import Resolver
from secret_gate.tokens import make_token
from secret_gate.upstream_tls import UpstreamTlsAddon

CERT = b"-----BEGIN CERTIFICATE-----\nMIIB\n-----END CERTIFICATE-----\n"


def _mode(path) -> int:
    return stat.S_IMODE(path.stat().st_mode)


def test_keys_json_is_published_atomically_with_public_keys_only(tmp_path):
    home, public = tmp_path / "gate", tmp_path / "pub"
    public.mkdir()
    old = generate_keypair()
    save_keypair(home / "keys" / "legacy" / "default", old)
    main = create_keypair(home, "main")
    rows = publish_keys(home, public)
    data = json.loads((public / "keys.json").read_text())
    assert [(r["name"], r["current"], r["legacy"]) for r in data] == [("main", True, False), ("default", False, True)]
    assert set(data[0]) == {"name", "publicKey", "current", "legacy", "createdAt"}
    assert data[0]["publicKey"] == main.public and _mode(public / "keys.json") == 0o644
    assert "key.priv" not in (public / "keys.json").read_text()
    assert read_rows(public) == rows
    assert current_public_key(rows) == current_public_key(read_rows(public))
    assert [p.name for p in public.iterdir()] == ["keys.json"]            # no temp file left behind
    create_keypair(home, "next")
    set_current(home, "next")
    publish_keys(home, public)
    assert [r.name for r in read_rows(public) if r.current] == ["next"]


@pytest.mark.parametrize("bad", [
    {}, [{"name": "x"}], [{"name": "../x", "publicKey": "A" * 43, "current": True, "legacy": False, "createdAt": ""}],
    [{"name": "a", "publicKey": "short", "current": True, "legacy": False, "createdAt": ""}],
    [{"name": "a", "publicKey": "A" * 43, "current": True, "legacy": True, "createdAt": ""}],
    [{"name": "a", "publicKey": "A" * 43, "current": "yes", "legacy": False, "createdAt": ""}],
])
def test_keys_json_is_validated_as_untrusted_input(bad):
    with pytest.raises(KeyStoreError, match="keys.json"):
        parse_rows(bad)


def test_reading_keys_json_errors(tmp_path):
    with pytest.raises(KeyStoreError, match="未找到"):
        read_rows(tmp_path)
    (tmp_path / "keys.json").write_text("not json")
    with pytest.raises(KeyStoreError, match="有效的 JSON"):
        read_rows(tmp_path)
    (tmp_path / "keys.json").write_text("[]")
    with pytest.raises(KeyStoreError, match="无当前密钥"):
        current_public_key(read_rows(tmp_path))


def test_ca_publication_copies_the_certificate_never_the_key(tmp_path):
    confdir, public = tmp_path / "mitm", tmp_path / "pub"
    confdir.mkdir()
    public.mkdir()
    assert publish_ca(confdir, public) is False                           # the proxy has not made its CA yet
    (confdir / "mitmproxy-ca-cert.pem").write_bytes(CERT)
    assert publish_ca(confdir, public) is True
    assert (public / "ca.pem").read_bytes() == CERT and _mode(public / "ca.pem") == 0o644
    assert publish_ca(confdir, public) is True                            # unchanged: nothing rewritten
    (confdir / "mitmproxy-ca-cert.pem").write_bytes(b"-----BEGIN RSA PRIVATE KEY-----\n" + CERT)
    with pytest.raises(KeyStoreError, match="不是证书"):
        publish_ca(confdir, public)


# -- proxy.pid ----------------------------------------------------------------------------------

def test_pid_file_round_trip_and_trust_rules(tmp_path):
    assert read_pid(tmp_path) is None and not proxy_running(tmp_path)
    write_pid(tmp_path)
    assert read_pid(tmp_path) == os.getpid() and _mode(tmp_path / "proxy.pid") == 0o600
    assert proxy_running(tmp_path)
    assert read_pid(tmp_path, uid=os.getuid() + 1) is None               # someone else's file is ignored
    (tmp_path / "proxy.pid").chmod(0o666)
    assert read_pid(tmp_path) is None                                     # writable by others: ignored
    (tmp_path / "proxy.pid").chmod(0o600)
    remove_pid(tmp_path, pid=1234)                                        # names another process: kept
    assert read_pid(tmp_path) == os.getpid()
    remove_pid(tmp_path)
    assert not (tmp_path / "proxy.pid").exists()
    (tmp_path / "proxy.pid").write_text("garbage")
    (tmp_path / "proxy.pid").chmod(0o600)
    assert read_pid(tmp_path) is None


def test_signal_proxy_sends_sighup_only_to_a_live_recorded_proxy(tmp_path):
    sent: list[tuple[int, int]] = []

    def kill(pid: int, signum: int) -> None:
        sent.append((pid, signum))
        if pid == 4242:
            raise ProcessLookupError

    assert signal_proxy(tmp_path, kill=kill) is False and sent == []
    write_pid(tmp_path, pid=4242)
    assert signal_proxy(tmp_path, kill=kill) is False                    # recorded but gone
    write_pid(tmp_path, pid=5151)
    assert signal_proxy(tmp_path, kill=kill) is True
    assert sent[-2:] == [(5151, 0), (5151, signal.SIGHUP)]
    assert alive(os.getpid())


def test_pid_file_addon_writes_on_running_and_removes_on_done(tmp_path, capsys):
    addon = PidFileAddon(tmp_path)
    addon.running()
    assert read_pid(tmp_path) == os.getpid()
    addon.done()
    assert not (tmp_path / "proxy.pid").exists()
    PidFileAddon(tmp_path / "missing" / "dir").running()                 # unwritable: reported, not raised
    assert "proxy.pid not written" in capsys.readouterr().err


# -- SIGHUP reloads keys --------------------------------------------------------------------------

def _token(public: bytes) -> str:
    return make_token(public, SecretPayload.create(value="pw-reload-1", hosts=["a.example"], uses=[USE_HTTP], label="a/p"))


def test_sighup_reloads_every_key_of_the_home(tmp_path):
    first = create_keypair(tmp_path, "first")
    gate = SecretGateAddon(Resolver.from_home(tmp_path))
    lines: list[str] = []
    reloader = InsecureHostsReloader(UpstreamTlsAddon(frozenset()), tmp_path, emit=lines.append, keys=gate)
    create_keypair(tmp_path, "second")
    set_current(tmp_path, "second")
    from secret_gate.keystore import load_public_key

    token = _token(load_public_key(tmp_path))
    with pytest.raises(TokenError):
        gate.resolver.resolve(token, use=USE_HTTP, host="a.example:443")  # the running proxy has not seen it
    reloader.reload()
    assert gate.resolver.resolve(token, use=USE_HTTP, host="a.example:443").value == "pw-reload-1"
    assert gate.resolver.key_count == 2 and first.public
    assert lines[-1] == "secret-gate: keys reloaded: 2 private key(s)"


def test_a_failed_key_reload_keeps_the_previous_keys(tmp_path):
    create_keypair(tmp_path, "only")
    before = Resolver.from_home(tmp_path)
    gate = SecretGateAddon(before)
    lines: list[str] = []
    reloader = InsecureHostsReloader(UpstreamTlsAddon(frozenset()), tmp_path, emit=lines.append, keys=gate,
                                     load_resolver=lambda _home: (_ for _ in ()).throw(KeyStoreError("no keypair")))
    assert reloader.reload_keys() is False
    assert gate.resolver is before and "keys reload FAILED" in lines[-1]
    assert InsecureHostsReloader(UpstreamTlsAddon(frozenset()), tmp_path).reload_keys() is False  # no addon given


def test_real_sighup_reloads_keys_through_an_asyncio_loop(tmp_path):
    create_keypair(tmp_path, "first")
    gate = SecretGateAddon(Resolver.from_home(tmp_path))
    reloader = InsecureHostsReloader(UpstreamTlsAddon(frozenset()), tmp_path, emit=lambda _line: None, keys=gate)

    async def scenario() -> int:
        reloader.running()
        create_keypair(tmp_path, "second")
        os.kill(os.getpid(), signal.SIGHUP)
        for _ in range(100):
            await asyncio.sleep(0.01)
            if gate.resolver.key_count == 2:
                break
        reloader.done()
        return gate.resolver.key_count

    assert asyncio.run(scenario()) == 2
