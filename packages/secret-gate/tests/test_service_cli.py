"""The CLI as a client of the gate service (gate-service-v0 §4), against a real rpc server on a temp socket.

The daemon and the Mac app parse these outputs; each one is compared with what the same command prints
without the service.
"""

from __future__ import annotations

import asyncio
import io
import json
import os
import socket
from functools import partial

import pytest

from secret_gate import bootstrap as bs
from secret_gate.cli import main
from secret_gate.errors import GateError, ServiceUnavailable
from secret_gate.proxy_probe import ProbeResult
from secret_gate.resolver import Resolver
from secret_gate.service_paths import SERVICE_REFUSAL, client_socket
from tests.fixtures import fake_secrets as fs
from tests.service_fixtures import OWNER_CONFIG, running_service, short_dir

SCOPE = "cli-scope-0123456789abcdefghij"
# A uid that is not this process's: what a login user's process is to the service (Windows ignores it: there the
# service's own processes are told apart by their SID, and this test process's is never the service's).
OTHER_UID = getattr(os, "getuid", lambda: 0)() + 1


@pytest.fixture
def service(monkeypatch, tmp_path):
    """A running service this CLI is a client of; SECRET_GATE_HOME points at an empty, unused directory."""
    monkeypatch.setenv("SECRET_GATE_HOME", str(tmp_path / "unused-home"))
    with running_service() as svc:
        monkeypatch.setattr("secret_gate.cli.client_socket", lambda: svc.socket)
        yield svc
    assert not (tmp_path / "unused-home").exists()                       # nothing was written user-side


def _run(capsys, argv, stdin: str | None = None, monkeypatch=None) -> tuple[int, str, str]:
    if stdin is not None:
        monkeypatch.setattr("sys.stdin", io.StringIO(stdin))
    code = main(argv)
    captured = capsys.readouterr()
    return code, captured.out, captured.err


@pytest.mark.posix
def test_client_mode_needs_a_socket_of_another_user(tmp_path):
    with short_dir() as root:
        env = {"SECRET_GATE_PUBLIC": str(root)}
        assert client_socket(env) is None                                  # no socket: local mode
        (root / "gate.sock").write_text("")
        assert client_socket(env) is None                                  # not a socket
        (root / "gate.sock").unlink()
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.bind(str(root / "gate.sock"))
        try:
            assert client_socket(env) is None                              # ours: this process is the service
            assert client_socket(env, uid=os.getuid() + 1) == root / "gate.sock"
        finally:
            sock.close()


def test_keys_shows_the_one_key_from_keys_json_and_cannot_change_it(service, capsys):
    code, out, _ = _run(capsys, ["keys", "--json"])
    rows = json.loads(out)
    public = json.loads((service.public / "keys.json").read_text())[0]["publicKey"]
    created = json.loads((service.public / "keys.json").read_text())[0]["createdAt"]
    assert code == 0 and rows == [{"name": "main", "public": public, "current": True, "legacy": False, "created": created}]
    code, again, _ = _run(capsys, ["keys", "--json", "list"])
    assert code == 0 and json.loads(again) == rows
    code, out, _ = _run(capsys, ["keys"])
    assert code == 0 and out == f"* main                 {public}\n"
    for gone in (["keys", "new", "x"], ["keys", "use", "main"], ["keys", "retire", "main"], ["keys", "restore", "x"],
                 ["credential-info"], ["credential-reissue"]):
        with pytest.raises(SystemExit) as exc:
            main(gone)
        assert exc.value.code == 2
    capsys.readouterr()


def test_logs_tail_over_the_socket(service, capsys):
    (service.home / "logs").mkdir(exist_ok=True)
    (service.home / "logs" / "proxy.log").write_text("a\nb\nc\n")
    code, out, _ = _run(capsys, ["logs", "tail", "--name", "proxy", "--lines", "2"])
    assert code == 0 and out == "b\nc\n"
    code, out, _ = _run(capsys, ["logs", "tail", "--name", "rpc", "--json"])
    assert code == 0 and json.loads(out) == {"text": ""}
    code, out, _ = _run(capsys, ["logs", "--json", "tail", "--name", "proxy"])
    assert json.loads(out) == {"text": "a\nb\nc"}
    with pytest.raises(SystemExit):
        main(["logs", "tail", "--name", "proxy", "--lines", "501"])


def test_logs_tail_without_the_service(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("SECRET_GATE_HOME", str(tmp_path))
    (tmp_path / "logs").mkdir()
    (tmp_path / "logs" / "proxy.err.log").write_text("launch agent line\n")    # service.py's LaunchAgent log
    code, out, _ = _run(capsys, ["logs", "tail", "--name", "proxy"])
    assert code == 0 and out == "launch agent line\n"
    code, out, _ = _run(capsys, ["logs", "tail", "--name", "rpc", "--json"])
    assert json.loads(out) == {"text": ""}


def test_pubkey_and_enc_use_keys_json(service, capsys, monkeypatch):
    code, out, _ = _run(capsys, ["pubkey"])
    public = json.loads((service.public / "keys.json").read_text())[0]["publicKey"]
    assert code == 0 and out.strip() == public
    code, out, _ = _run(capsys, ["enc", "--label", "portal-a/pass", "--host", "portal-a.example.com", "--stdin"],
                        stdin=fs.PORTAL.password + "\n", monkeypatch=monkeypatch)
    token = out.strip()
    assert code == 0 and token.startswith("enc:v1:")
    assert service.client.call("mcp.describe", {"token": token})["label"] == "portal-a/pass"   # the service opens it
    batch = json.dumps([{"label": "a/pass", "hosts": ["a.example.com"], "value": "pw-a-1234"}])
    code, out, _ = _run(capsys, ["enc", "--batch"], stdin=batch, monkeypatch=monkeypatch)
    assert code == 0 and json.loads(out)[0]["token"].startswith("enc:v1:")


def test_refs_register_and_release_over_the_socket(service, capsys, monkeypatch):
    _, token, _ = _run(capsys, ["enc", "--label", "x/y", "--host", "x.example", "--value", "v-1234567"])
    request = json.dumps({"scope": SCOPE, "tokens": [token.strip(), "enc:v1:" + "A" * 30]})
    code, out, _ = _run(capsys, ["refs", "register"], stdin=request, monkeypatch=monkeypatch)
    result = json.loads(out)
    assert code == 1 and result["refs"][0]["ref"].startswith("enc:ref:") and "error" in result["refs"][1]
    code, out, _ = _run(capsys, ["refs", "release"], stdin=json.dumps({"scope": SCOPE}), monkeypatch=monkeypatch)
    assert code == 0 and json.loads(out) == {"released": 1}
    code, out, err = _run(capsys, ["refs", "register"], stdin=json.dumps({"scope": SCOPE, "tokens": [token.strip()]}),
                          monkeypatch=monkeypatch)
    assert code == 2 and "released" in err and SCOPE not in err
    code, _, err = _run(capsys, ["refs", "release"], stdin="{}", monkeypatch=monkeypatch)
    assert code == 2 and "refs request needs exactly" in err                # checked before anything is sent


@pytest.mark.parametrize("argv", [["keygen"], ["check", "enc:v1:" + "A" * 30], ["proxy"], ["service", "status"],
                                  ["install-ca"], ["rpc"]])
def test_commands_the_service_owns_are_refused(service, capsys, argv):
    code, out, err = _run(capsys, argv)
    assert code == 2 and out == "" and SERVICE_REFUSAL in err


def test_bootstrap_checks_the_published_keys_and_ca(service, capsys, monkeypatch, tmp_path):
    from datetime import datetime, timezone

    from cryptography import x509
    from cryptography.hazmat.primitives import hashes, serialization
    from cryptography.hazmat.primitives.asymmetric import ec
    from cryptography.x509.oid import NameOID

    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "mitmproxy")])
    now = datetime.now(timezone.utc)
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(1).not_valid_before(now).not_valid_after(now.replace(year=now.year + 1)).sign(key, hashes.SHA256()))
    (service.public / "ca.pem").write_bytes(cert.public_bytes(serialization.Encoding.PEM))
    deps = bs.BootstrapDeps(user_home=tmp_path, mitmproxy_ca=tmp_path / "none.pem", env={}, tcp=lambda _p: True,
                            probe=lambda _p: ProbeResult("gate", "refused the probe"), now=lambda: now)
    monkeypatch.setattr(bs, "system_deps", lambda: deps)
    code, out, err = _run(capsys, ["bootstrap", "claude-code"])
    assert code == 0, err
    assert "[ok  ] keypair: the gate service publishes a current keypair" in err
    assert "published by the gate service" in err and json.dumps(str(service.public / "ca.pem")) in out


def test_unavailable_service_is_reported_not_bypassed(monkeypatch, capsys, tmp_path):
    monkeypatch.setenv("SECRET_GATE_HOME", str(tmp_path))
    monkeypatch.setattr("secret_gate.cli.client_socket", lambda: tmp_path / "gate.sock")
    request = json.dumps({"scope": SCOPE, "tokens": ["enc:v1:" + "A" * 30]})
    monkeypatch.setattr("sys.stdin", io.StringIO(request))
    code, _, err = _run(capsys, ["refs", "register"])
    assert code == 2 and "凭据网关服务无响应" in err
    assert not (tmp_path / "key.priv").exists()                           # never a local keypair instead


# -- service mode is decided by gate-service.json, never by the socket (no local fallback) ---------------------

def _installed(svc) -> None:
    """gate-service.json next to the public directory, as `system install` leaves it."""
    (svc.public.parent / "gate-service.json").write_text(json.dumps(OWNER_CONFIG.to_json()))


@pytest.fixture
def stopped_service(monkeypatch, tmp_path):
    """An installed service whose rpc server stopped (and so removed gate.sock), seen from a login user's process;
    the user's gate home holds a keypair another process of this uid planted there."""
    from secret_gate.keyring import create_keypair

    planted = tmp_path / "user-home"
    create_keypair(planted)
    monkeypatch.setenv("SECRET_GATE_HOME", str(planted))
    with running_service() as svc:
        _installed(svc)
        svc.server.shutdown()
        svc.server.server_close()
        assert not svc.socket.exists()
        monkeypatch.setenv("SECRET_GATE_PUBLIC", str(svc.public))
        monkeypatch.setattr("secret_gate.cli.client_socket", partial(client_socket, uid=OTHER_UID))
        yield svc, planted


def test_installed_service_without_its_socket_is_unavailable_never_local(stopped_service, capsys, monkeypatch):
    svc, planted = stopped_service
    keys_before = sorted((p.name, p.read_bytes()) for p in planted.iterdir())
    for argv in (["keygen"], ["keygen", "--force"], ["check", "enc:v1:" + "A" * 30]):
        code, out, err = _run(capsys, argv)
        assert code == 2 and out == "" and SERVICE_REFUSAL in err
    code, _, err = _run(capsys, ["refs", "release"], stdin=json.dumps({"scope": SCOPE}), monkeypatch=monkeypatch)
    assert code == 2 and "凭据网关服务无响应" in err
    assert sorted((p.name, p.read_bytes()) for p in planted.iterdir()) == keys_before  # nothing made user-side
    # What only needs the service's keys.json keeps working, and seals to the service's key, not the planted one.
    service_key = json.loads((svc.public / "keys.json").read_text())[0]["publicKey"]
    code, out, _ = _run(capsys, ["pubkey"])
    assert code == 0 and out.strip() == service_key
    code, out, _ = _run(capsys, ["enc", "--batch"], monkeypatch=monkeypatch,
                        stdin=json.dumps([{"label": "a/pass", "hosts": ["a.example.com"], "value": "pw-a-1234"}]))
    token = json.loads(out)[0]["token"]
    assert code == 0 and Resolver.from_home(svc.home).describe(token)["label"] == "a/pass"
    with pytest.raises(GateError):
        Resolver.from_home(planted).describe(token)


def test_mcp_and_browser_components_never_go_local_once_installed(stopped_service, monkeypatch):
    from secret_gate import browser_mcp
    from secret_gate.mcp_backend import RemoteMcpBackend, default_backend

    monkeypatch.setattr("secret_gate.mcp_backend.client_socket", partial(client_socket, uid=OTHER_UID))
    backend = default_backend()
    assert isinstance(backend, RemoteMcpBackend)
    with pytest.raises(ServiceUnavailable, match="凭据网关服务无响应"):
        backend.describe("enc:v1:" + "A" * 30)
    monkeypatch.setattr(browser_mcp, "client_socket", partial(client_socket, uid=OTHER_UID))
    monkeypatch.setattr(browser_mcp, "local_setup", lambda *_a: pytest.fail("a local browser gate was set up"))
    with pytest.raises(ServiceUnavailable, match="凭据网关服务无响应"):
        asyncio.run(browser_mcp.serve(["true"]))


@pytest.mark.posix
def test_installed_service_refuses_a_socket_that_is_not_the_services(monkeypatch):
    with short_dir() as root:
        public = root / "gate-public"
        public.mkdir()
        (root / "gate-service.json").write_text("{}")                        # its presence decides, not its content
        env = {"SECRET_GATE_PUBLIC": str(public)}
        other = os.getuid() + 1
        assert client_socket(env, uid=other) == public / "gate.sock"          # missing: calls fail, nothing local
        assert client_socket(env) is None                                     # the public directory's owner is the service
        (public / "gate.sock").write_text("")
        with pytest.raises(ServiceUnavailable, match="不是 socket"):
            client_socket(env, uid=other)
        (public / "gate.sock").unlink()
        sock = socket.socket(socket.AF_UNIX, socket.SOCK_STREAM)
        sock.bind(str(public / "gate.sock"))
        try:
            assert client_socket(env, uid=other) == public / "gate.sock"      # the service's socket
            # A socket this very process made, in a public directory the service account owns.
            monkeypatch.setattr("secret_gate.service_paths._owner", lambda _p: other)
            with pytest.raises(ServiceUnavailable, match="不属于网关服务账户"):
                client_socket(env)
            with pytest.raises(ServiceUnavailable, match="不属于网关服务账户"):
                client_socket(env, uid=other + 1)
        finally:
            sock.close()


def test_windows_decides_by_gate_service_json_and_the_service_sid():
    """Windows: no socket file to look at; gate-service.json decides, and only the service's account is not a
    client (its pipe is checked when connecting, winpipe.connect)."""
    from secret_gate.fsacl import GATE_SERVICE_SID

    user = "S-1-5-21-1004336348-1177238915-682003330-1001"
    with short_dir() as root:
        public = root / "gate-public"
        public.mkdir()
        env = {"SECRET_GATE_PUBLIC": str(public)}
        assert client_socket(env, windows=True, sid=user) is None             # no service: a local gate
        (root / "gate-service.json").write_text("{}")
        assert client_socket(env, windows=True, sid=user) == public / "gate.sock"
        assert client_socket(env, windows=True, sid=GATE_SERVICE_SID) is None  # the service's own processes


def test_without_gate_service_json_the_cli_is_a_local_gate(monkeypatch, capsys, tmp_path):
    with short_dir() as root:
        monkeypatch.setenv("SECRET_GATE_PUBLIC", str(root / "gate-public"))
        monkeypatch.setenv("SECRET_GATE_HOME", str(tmp_path / "home"))
        assert client_socket() is None
        code, out, _ = _run(capsys, ["keys", "--json"])
        assert code == 0 and json.loads(out) == []
        code, out, _ = _run(capsys, ["keygen"])
        assert code == 0 and (tmp_path / "home" / "key.priv").is_file()
        code, out, _ = _run(capsys, ["keys", "--json"])
        assert code == 0 and [(r["name"], r["current"], r["legacy"]) for r in json.loads(out)] == [("main", True, False)]
