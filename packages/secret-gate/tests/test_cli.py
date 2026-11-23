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
    # The "=" form: a base64url key may start with "-", which argparse would take for an option.
    assert main(["enc", "--label", "x/y", f"--pubkey={pub}", "--value", "v-exec-123", "--use", "exec"]) == 0
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
    monkeypatch.setattr("secret_gate.cli._find_mitmdump", lambda: None)          # POSIX: exec's the mitmdump script
    monkeypatch.setattr("secret_gate.cli._mitmdump_in_process", lambda: None)    # Windows: runs it in this process
    assert main(["proxy"]) == 1
    assert "not found" in capsys.readouterr().err


def test_proxy_argv_listens_locally_without_http2(tmp_path):
    from secret_gate.cli import mitmdump_argv
    argv = mitmdump_argv("/x/mitmdump", tmp_path / "entry.py", 8080)
    assert argv[:2] == ["/x/mitmdump", "-q"]
    assert argv[argv.index("-p") + 1] == "8080"
    assert argv[argv.index("--listen-host") + 1] == "127.0.0.1"
    assert "http2=false" in argv and argv[argv.index("http2=false") - 1] == "--set"


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


def test_one_key_contract_keys_json_and_keygen_force(tmp_path, monkeypatch, capsys):
    """`keys --json` prints a list with exactly one row (or none); `keygen --force` replaces the key, and tokens
    sealed to the old one stop opening (gate-simple-v0 §1)."""
    import json

    monkeypatch.setenv("SECRET_GATE_HOME", str(tmp_path))
    assert main(["keys", "--json"]) == 0
    assert json.loads(capsys.readouterr().out) == []
    assert main(["keygen"]) == 0
    first = capsys.readouterr()
    assert "warning" not in first.err
    assert main(["keys", "--json"]) == 0
    rows = json.loads(capsys.readouterr().out)
    assert rows == [{"name": "main", "public": rows[0]["public"], "current": True, "legacy": False,
                     "created": rows[0]["created"]}] and rows[0]["created"].endswith("Z")
    assert f"public key value: {rows[0]['public']}" in first.out

    assert main(["enc", "--label", "a/pass", "--host", "a.example.com", "--value", "pw-a-1234"]) == 0
    old_token = capsys.readouterr().out.strip()
    assert main(["keygen"]) == 2
    assert "已有密钥" in capsys.readouterr().err
    assert main(["keygen", "--force"]) == 0
    replaced = capsys.readouterr()
    assert "no longer opens" in replaced.err
    assert main(["keys", "--json"]) == 0
    new_rows = json.loads(capsys.readouterr().out)
    assert len(new_rows) == 1 and new_rows[0]["public"] != rows[0]["public"]
    assert main(["check", old_token]) == 2
    capsys.readouterr()
    for gone in (["keys", "new", "x"], ["keys", "use", "main"], ["keys", "retire", "main"], ["keys", "restore", "x"],
                 ["keygen", "--name", "x"], ["credential-info"], ["credential-reissue"],
                 ["enc", "--label", "a/b", "--seed-import-host", "a.example.com", "--value", "12345678"]):
        with pytest.raises(SystemExit) as exc:
            main(gone)
        assert exc.value.code == 2


def test_batch_enc(tmp_path, monkeypatch, capsys):
    import json

    monkeypatch.setenv("SECRET_GATE_HOME", str(tmp_path))
    main(["keygen"]); capsys.readouterr()
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
    assert main(["check", out[0]["token"]]) == 0
    assert "label: a/pass" in capsys.readouterr().out


def test_enc_refuses_short_values(tmp_path, monkeypatch, capsys):
    """gate-simple-v0 §3.3: the Mac app and the daemon seal through this command, so the floor holds for them too."""
    import json

    monkeypatch.setenv("SECRET_GATE_HOME", str(tmp_path))
    main(["keygen"]); capsys.readouterr()
    assert main(["enc", "--label", "x/y", "--host", "a.example.com", "--value", "1234567"]) == 2
    assert "值至少需要 8 个字符" in capsys.readouterr().err
    batch = [
        {"label": "short", "hosts": ["a.example.com"], "uses": ["http", "fill"], "value": "1234567"},
        {"label": "ok", "hosts": ["a.example.com"], "uses": ["http", "fill"], "value": "12345678"},
        {"label": "exec", "uses": ["exec"], "value": "abc"},
        {"label": "seed", "kind": "totp", "uses": ["otp"], "value": "MZXW6YQ"},
    ]
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(batch)))
    assert main(["enc", "--batch"]) == 1
    out = json.loads(capsys.readouterr().out)
    assert "8 个字符" in out[0]["error"] and "1234567" not in json.dumps(out)
    assert out[1]["token"].startswith("enc:v1:") and "8 个字符" in out[2]["error"]
    assert out[3]["token"].startswith("enc:v1:")


def test_batch_rejects_non_array(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("SECRET_GATE_HOME", str(tmp_path))
    main(["keygen"]); capsys.readouterr()
    monkeypatch.setattr("sys.stdin", io.StringIO("{}"))
    assert main(["enc", "--batch"]) == 2
