"""`secret-gate bootstrap`: checks, guarded --write, report. No network, no keychain, no real harness config."""

from __future__ import annotations

import json
from dataclasses import replace
from datetime import datetime, timedelta, timezone
from pathlib import Path

import pytest
from cryptography import x509
from cryptography.hazmat.primitives import hashes, serialization
from cryptography.hazmat.primitives.asymmetric import ec
from cryptography.x509.oid import NameOID

from secret_gate import bootstrap as bs
from secret_gate.bootstrap import (
    STATUS_FAIL,
    STATUS_OK,
    STATUS_SKIP,
    BootstrapDeps,
    check_ca,
    check_gate,
    check_keypair,
    check_listener,
    checks_pass,
    global_config_paths,
    run_checks,
    write_snippet,
)
from secret_gate.cli import main
from secret_gate.errors import ValidationError
from secret_gate.proxy_probe import VERDICT_GATE, VERDICT_OTHER_HTTP, ProbeResult

NOW = datetime(2026, 9, 24, tzinfo=timezone.utc)
GATE = ProbeResult(VERDICT_GATE, "refused the probe value with 403 X-Secret-Gate: denied")


def _pem(not_after: datetime) -> bytes:
    key = ec.generate_private_key(ec.SECP256R1())
    name = x509.Name([x509.NameAttribute(NameOID.COMMON_NAME, "test ca")])
    cert = (x509.CertificateBuilder().subject_name(name).issuer_name(name).public_key(key.public_key())
            .serial_number(1).not_valid_before(not_after - timedelta(days=3650)).not_valid_after(not_after)
            .sign(key, hashes.SHA256()))
    return cert.public_bytes(serialization.Encoding.PEM)


@pytest.fixture
def deps(tmp_path) -> BootstrapDeps:
    user_home = tmp_path / "user"
    user_home.mkdir()
    return BootstrapDeps(user_home=user_home, mitmproxy_ca=tmp_path / "mitmproxy-ca-cert.pem", env={},
                         tcp=lambda _port: True, probe=lambda _port: GATE, now=lambda: NOW)


@pytest.fixture
def ready(gate_home, deps):
    """A gate home with key and a ca.pem identical to the proxy's CA."""
    pem = _pem(NOW + timedelta(days=365))
    (gate_home / "ca.pem").write_bytes(pem)
    deps.mitmproxy_ca.write_bytes(pem)
    return gate_home


# -- checks --------------------------------------------------------------------------------------

def test_check_keypair(gate_home, tmp_path):
    assert check_keypair(gate_home).status == STATUS_OK
    failed = check_keypair(tmp_path / "nowhere")
    assert failed.status == STATUS_FAIL and "keygen" in failed.detail


def test_check_ca_states(tmp_path):
    home, proxy_ca = tmp_path / "home", tmp_path / "proxy-ca.pem"
    home.mkdir()
    ca = home / "ca.pem"
    missing = check_ca(home, proxy_ca, NOW)
    assert missing.status == STATUS_FAIL and "not found" in missing.detail and f"cp {proxy_ca} {ca}" in missing.detail
    ca.write_text("not a certificate")
    assert "not a PEM certificate" in check_ca(home, proxy_ca, NOW).detail
    ca.write_bytes(_pem(NOW - timedelta(days=1)))
    assert "expired" in check_ca(home, proxy_ca, NOW).detail
    good = _pem(NOW + timedelta(days=30))
    ca.write_bytes(good)
    uncompared = check_ca(home, proxy_ca, NOW)
    assert uncompared.status == STATUS_OK and "not compared" in uncompared.detail
    proxy_ca.write_bytes(_pem(NOW + timedelta(days=30)))
    stale = check_ca(home, proxy_ca, NOW)
    assert stale.status == STATUS_FAIL and "not the CA the proxy signs with" in stale.detail
    proxy_ca.write_bytes(good)
    assert check_ca(home, proxy_ca, NOW).status == STATUS_OK


def test_check_ca_unreadable(tmp_path):
    home = tmp_path
    ca, proxy_ca = home / "ca.pem", tmp_path / "proxy.pem"
    ca.write_bytes(_pem(NOW + timedelta(days=30)))
    proxy_ca.write_bytes(b"x")
    proxy_ca.chmod(0o000)
    try:
        assert "cannot read" in check_ca(home, proxy_ca, NOW).detail
        ca.chmod(0o000)
        assert "cannot read" in check_ca(home, proxy_ca, NOW).detail
    finally:
        ca.chmod(0o600)
        proxy_ca.chmod(0o600)


def test_check_listener_and_gate():
    assert check_listener(8080, lambda _p: True).status == STATUS_OK
    down = check_listener(8080, lambda _p: False)
    assert down.status == STATUS_FAIL and "service install" in down.detail
    assert check_gate(8080, lambda _p: GATE, listening=True).status == STATUS_OK
    other = check_gate(8080, lambda _p: ProbeResult(VERDICT_OTHER_HTTP, "nginx"), listening=True)
    assert other.status == STATUS_FAIL and other.detail == "nginx"

    def never(_p):
        raise AssertionError("must not probe without a listener")
    assert check_gate(8080, never, listening=False).status == STATUS_SKIP


def test_run_checks(ready, deps):
    checks = run_checks(ready, 8080, deps)
    assert [c.name for c in checks] == ["keypair", "ca", "listener", "gate"] and checks_pass(checks)
    down = run_checks(ready, 8080, replace(deps, tcp=lambda _p: False))
    assert not checks_pass(down) and down[-1].status == STATUS_SKIP


# -- --write -------------------------------------------------------------------------------------

def test_global_config_paths(tmp_path):
    user = tmp_path / "u"
    paths = global_config_paths(user, {"CODEX_HOME": str(tmp_path / "ch"), "XDG_CONFIG_HOME": str(tmp_path / "x")})
    assert (user / ".claude" / "settings.json").resolve() in paths
    assert (user / ".claude.json").resolve() in paths
    assert (user / ".codex" / "config.toml").resolve() in paths
    assert (tmp_path / "ch" / "config.toml").resolve() in paths
    assert (tmp_path / "x" / "opencode" / "opencode.json").resolve() in paths
    assert (user / ".config" / "opencode" / "opencode.json").resolve() in global_config_paths(user, {})


def test_write_creates_private_file_and_refuses_to_overwrite(tmp_path, deps):
    target = tmp_path / "out.json"
    assert write_snippet(target, "{}\n", force=False, deps=deps) == target
    assert target.read_text() == "{}\n" and target.stat().st_mode & 0o777 == 0o600
    with pytest.raises(ValidationError, match="--force"):
        write_snippet(target, "new", force=False, deps=deps)
    write_snippet(target, "new", force=True, deps=deps)
    assert target.read_text() == "new" and target.stat().st_mode & 0o777 == 0o600


def test_write_never_touches_global_configs(tmp_path, deps):
    claude_dir = deps.user_home / ".claude"
    claude_dir.mkdir()
    settings = claude_dir / "settings.json"
    settings.write_text('{"keep": true}')
    for force in (False, True):
        with pytest.raises(ValidationError, match="global config"):
            write_snippet(settings, "x", force=force, deps=deps)
    link = tmp_path / "innocent.json"
    link.symlink_to(settings)
    with pytest.raises(ValidationError, match="global config"):
        write_snippet(link, "x", force=True, deps=deps)
    assert settings.read_text() == '{"keep": true}'


def test_write_needs_an_existing_directory_and_a_file_target(tmp_path, deps):
    with pytest.raises(ValidationError, match="does not exist"):
        write_snippet(tmp_path / "missing" / "f.json", "x", force=False, deps=deps)
    with pytest.raises(ValidationError, match="is a directory"):
        write_snippet(tmp_path, "x", force=True, deps=deps)


# -- CLI -----------------------------------------------------------------------------------------

@pytest.fixture
def cli(monkeypatch, deps):
    holder = {"deps": deps}
    monkeypatch.setattr(bs, "system_deps", lambda: holder["deps"])
    return holder


def test_cli_prints_snippet_and_report(ready, cli, capsys):
    assert main(["bootstrap", "claude-code", "--port", "9100"]) == 0
    captured = capsys.readouterr()
    settings = json.loads(captured.out)
    assert settings["env"]["HTTPS_PROXY"] == "http://127.0.0.1:9100"
    assert settings["env"]["SECRET_GATE_HOME"] == str(ready)
    for expected in ("[ok  ] keypair", "[ok  ] ca", "[ok  ] listener", "[ok  ] gate", "scope:",
                     "never touches the keychain", "apply (by hand):"):
        assert expected in captured.err, expected


def test_cli_failing_check_exits_nonzero_and_does_not_write(ready, cli, capsys, tmp_path):
    cli["deps"] = replace(cli["deps"], tcp=lambda _p: False)
    target = tmp_path / "codex.toml"
    assert main(["bootstrap", "codex", "--write", str(target)]) == 1
    captured = capsys.readouterr()
    assert not target.exists() and "not written" in captured.err and "[FAIL] listener" in captured.err
    assert "[mcp_servers.secret-gate]" in captured.out


def test_cli_write(ready, cli, capsys, tmp_path):
    target = tmp_path / "opencode.json"
    assert main(["bootstrap", "opencode", "--write", str(target)]) == 0
    captured = capsys.readouterr()
    assert captured.out == "" and f"wrote {target}" in captured.err
    assert json.loads(target.read_text())["mcp"]["secret-gate"]["environment"]["SECRET_GATE_HOME"] == str(ready)
    assert main(["bootstrap", "opencode", "--write", str(target)]) == 2       # exists, no --force
    captured = capsys.readouterr()
    assert "error:" in captured.err and captured.out.startswith("{")
    assert main(["bootstrap", "opencode", "--write", str(target), "--force"]) == 0


def test_cli_argument_errors(ready, cli, capsys):
    assert main(["bootstrap", "codex", "--force"]) == 2
    assert "--force only applies" in capsys.readouterr().err
    with pytest.raises(SystemExit):
        main(["bootstrap", "vim"])
    with pytest.raises(SystemExit):
        main(["bootstrap", "codex", "--port", "0"])


def test_system_deps_reads_the_real_environment_without_side_effects():
    deps = bs.system_deps()
    assert deps.user_home == Path.home() and deps.env is not None and deps.now().tzinfo is not None
