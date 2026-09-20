import io

import pytest

from secret_gate.cli import main
from tests.fixtures import fake_secrets as fs


def test_keygen_enc_check_flow(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("SECRET_GATE_HOME", str(tmp_path / "home"))
    assert main(["keygen"]) == 0
    assert main(["keygen"]) == 2  # refuses overwrite
    assert main(["keygen", "--force"]) == 0
    capsys.readouterr()

    assert main(["pubkey"]) == 0
    pub = capsys.readouterr().out.strip()
    assert len(pub) > 30

    monkeypatch.setattr("sys.stdin", io.StringIO(fs.PORTAL.password + "\n"))
    assert main(["enc", "--label", "portal-a/pass", "--host", "portal-a.example.com", "--stdin"]) == 0
    token = capsys.readouterr().out.strip()
    assert token.startswith("enc:v1:") and fs.PORTAL.password not in token

    assert main(["check", token]) == 0
    out = capsys.readouterr().out
    assert "label: portal-a/pass" in out and "uses: ['http']" in out
    assert fs.PORTAL.password not in out


def test_enc_with_explicit_pubkey_and_value(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("SECRET_GATE_HOME", str(tmp_path))
    main(["keygen"]); capsys.readouterr()
    main(["pubkey"]); pub = capsys.readouterr().out.strip()
    assert main(["enc", "--label", "x/y", "--pubkey", pub, "--value", "v", "--use", "exec"]) == 0
    tok = capsys.readouterr().out.strip()
    main(["check", tok])
    assert "uses: ['exec']" in capsys.readouterr().out


def test_enc_prompt(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("SECRET_GATE_HOME", str(tmp_path))
    main(["keygen"]); capsys.readouterr()
    monkeypatch.setattr("getpass.getpass", lambda prompt="": "prompted-value")
    assert main(["enc", "--label", "p/q"]) == 0
    assert capsys.readouterr().out.startswith("enc:v1:")


def test_errors_are_reported(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("SECRET_GATE_HOME", str(tmp_path / "nokeys"))
    assert main(["check", "enc:v1:abc"]) == 2
    assert "error:" in capsys.readouterr().err
    with pytest.raises(SystemExit):
        main(["nonsense"])


def test_proxy_requires_key_and_mitmdump(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("SECRET_GATE_HOME", str(tmp_path))
    assert main(["proxy"]) == 2
    main(["keygen"]); capsys.readouterr()
    monkeypatch.setattr("secret_gate.cli._find_mitmdump", lambda: None)
    assert main(["proxy"]) == 1


def test_install_ca_missing(tmp_path, monkeypatch):
    monkeypatch.setenv("SECRET_GATE_HOME", str(tmp_path))
    monkeypatch.setattr("secret_gate.cli.MITMPROXY_CA_PATH", tmp_path / "missing.pem")
    assert main(["install-ca"]) == 1


def test_install_ca_copies(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("SECRET_GATE_HOME", str(tmp_path))
    ca = tmp_path / "ca-src.pem"; ca.write_text("PEM")
    monkeypatch.setattr("secret_gate.cli.MITMPROXY_CA_PATH", ca)
    monkeypatch.setattr("subprocess.run", lambda *a, **k: None)
    assert main(["install-ca"]) == 0
    assert (tmp_path / "ca.pem").read_text() == "PEM"


def test_named_keys_and_batch(tmp_path, monkeypatch, capsys):
    import json

    monkeypatch.setenv("SECRET_GATE_HOME", str(tmp_path))
    assert main(["keys", "new", "work"]) == 0
    assert main(["keys", "new", "home"]) == 0
    capsys.readouterr()
    assert main(["keys", "--json"]) == 0
    rows = json.loads(capsys.readouterr().out)
    assert [(r["name"], r["current"]) for r in rows] == [("home", False), ("work", True)]
    assert main(["keys", "use", "home"]) == 0
    capsys.readouterr()
    assert main(["keys", "--json"]) == 0
    assert [r["name"] for r in json.loads(capsys.readouterr().out) if r["current"]] == ["home"]

    batch = [
        {"label": "a/pass", "hosts": ["a.example.com"], "value": "pw-a-1234"},
        {"label": "a/totp", "kind": "totp", "uses": ["otp"], "value": "JBSWY3DPEHPK3PXP"},
        {"label": "bad/host", "hosts": ["not a host"], "value": "x"},
    ]
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(batch)))
    assert main(["enc", "--batch"]) == 1  # one entry failed
    out = json.loads(capsys.readouterr().out)
    assert out[0]["token"].startswith("enc:v1:") and out[1]["token"].startswith("enc:v1:")
    assert "error" in out[2] and "pw-a-1234" not in json.dumps(out)
    # tokens minted for the current keypair (home) resolve; the gate also still holds "work"
    assert main(["check", out[0]["token"]]) == 0
    assert "label: a/pass" in capsys.readouterr().out


def test_batch_rejects_non_array(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("SECRET_GATE_HOME", str(tmp_path))
    main(["keygen"]); capsys.readouterr()
    monkeypatch.setattr("sys.stdin", io.StringIO("{}"))
    assert main(["enc", "--batch"]) == 2
