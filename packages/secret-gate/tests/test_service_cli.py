"""The CLI as a client of the gate service (gate-service-v0 §4), against a real rpc server on a temp socket.

The daemon and the Mac app parse these outputs; each one is compared with what the same command prints
without the service.
"""

from __future__ import annotations

import io
import json
import os
import socket

import pytest

from secret_gate import bootstrap as bs
from secret_gate.cli import main
from secret_gate.proxy_probe import ProbeResult
from secret_gate.service_paths import SERVICE_REFUSAL, client_socket
from tests.fixtures import fake_secrets as fs
from tests.service_fixtures import running_service, short_dir

SCOPE = "cli-scope-0123456789abcdefghij"


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


def test_keys_list_new_use_retire_keep_the_output_format(service, capsys, monkeypatch):
    code, out, _ = _run(capsys, ["keys", "--json"])
    rows = json.loads(out)
    assert code == 0 and rows == [{"name": "main", "public": rows[0]["public"], "current": True, "legacy": False}]
    code, out, _ = _run(capsys, ["keys", "--json", "new", "work", "--use"])
    assert code == 0 and [(r["name"], r["current"]) for r in json.loads(out)] == [("main", False), ("work", True)]
    assert service.signals == ["HUP"]
    code, out, _ = _run(capsys, ["keys", "use", "main"])
    assert code == 0 and out.splitlines()[0].startswith("* main ")
    from secret_gate.crypto import generate_keypair
    from secret_gate.keystore import save_keypair

    save_keypair(service.home / "keys" / "legacy" / "old", generate_keypair())
    code, _, err = _run(capsys, ["keys", "use", "old"])
    assert code == 2 and "已停用（仅解密）" in err
    code, out, _ = _run(capsys, ["keys", "--json", "retire", "old"])
    rows = json.loads(out)                                                  # the updated list, like new/use
    assert code == 0 and [(r["name"], r["legacy"]) for r in rows] == [("main", False), ("work", False)]
    assert all(set(r) == {"name", "public", "current", "legacy"} for r in rows)


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
    _, token, _ = _run(capsys, ["enc", "--label", "x/y", "--host", "x.example", "--value", "v-12345"])
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


def test_credential_commands_over_the_socket(service, capsys, monkeypatch):
    _, token, _ = _run(capsys, ["enc", "--label", "portal-a/totp", "--host", "portal-a.example.com", "--kind", "totp",
                                "--use", "otp", "--seed-import-host", "portal-a.example.com", "--value", fs.TOTP_SECRET_B32])
    code, out, _ = _run(capsys, ["credential-info"], stdin=json.dumps({"token": token.strip()}), monkeypatch=monkeypatch)
    assert code == 0 and json.loads(out)["seed_import_hosts"] == ["portal-a.example.com"]
    request = {"token": token.strip(), "host": "portal-a.example.com", "purpose": "totp_seed_import"}
    code, out, _ = _run(capsys, ["credential-reissue"], stdin=json.dumps(request), monkeypatch=monkeypatch)
    reissued = json.loads(out)
    assert code == 0 and reissued["uses"] == ["fill", "http"] and fs.TOTP_SECRET_B32 not in out
    code, _, err = _run(capsys, ["credential-info"], stdin="[]", monkeypatch=monkeypatch)
    assert code == 2 and "unexpected fields" in err


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
    assert "published by the gate service" in err and str(service.public / "ca.pem") in out


def test_unavailable_service_is_reported_not_bypassed(monkeypatch, capsys, tmp_path):
    monkeypatch.setenv("SECRET_GATE_HOME", str(tmp_path))
    monkeypatch.setattr("secret_gate.cli.client_socket", lambda: tmp_path / "gate.sock")
    (tmp_path / "keys.json").write_text("[]")
    code, _, err = _run(capsys, ["keys", "new", "x"])
    assert code == 2 and "凭据网关服务无响应" in err
    assert not (tmp_path / "keys").exists()                               # never a local keypair instead
