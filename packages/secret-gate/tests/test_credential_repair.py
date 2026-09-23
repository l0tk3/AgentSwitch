"""Fake credentials only: repair grants are sealed and MCP never receives plaintext."""
import asyncio
import io
import json

import httpx
import pytest

from secret_gate.cli import main
from secret_gate.credential_repair import REPAIR_PURPOSE, bridge_config, credential_info, reissue_totp_seed, request_repair
from secret_gate.errors import GateError, PolicyViolation, ValidationError
from secret_gate.policy import SecretPayload
from secret_gate.tokens import make_token, open_token
from tests.fixtures import fake_secrets as fs
from tests.test_browser_gate import FakePlaywright, PAGE

HOST = "login.portal-a.example.com"
BRIDGE = "http://127.0.0.1:4799/credential-repair"
ENV = {"SECRET_GATE_REPAIR_URL": BRIDGE, "SECRET_GATE_REPAIR_KEY": "fixture_key_1234567890"}


def token(keypair, *, hosts=(HOST,), grants=(HOST,), kind="totp"):
    return make_token(keypair.public, SecretPayload.create(value=fs.TOTP_SECRET_B32, hosts=hosts,
        uses=["otp"] if kind == "totp" else ["http"], label="fixture/2fa", kind=kind, seed_import_hosts=grants))


def repaired(keypair, resolver, tok):
    return reissue_totp_seed(resolver, keypair.public, tok, HOST, REPAIR_PURPOSE)


def test_seed_reissue_materializes_seed_not_current_code(keypair, resolver):
    tok = token(keypair)
    assert credential_info(resolver, tok) == {"label": "fixture/2fa", "kind": "totp", "hosts": [HOST], "uses": ["otp"], "seed_import_hosts": [HOST]}
    code = resolver.resolve(tok, use="otp").value
    with pytest.raises(PolicyViolation, match="does not allow"):
        resolver.resolve(tok, use="http", host=HOST)
    result = repaired(keypair, resolver, tok)
    assert result == {"token": result["token"], "label": "fixture/2fa", "kind": "secret", "hosts": [HOST], "uses": ["http"]}
    assert fs.TOTP_SECRET_B32 not in json.dumps(result)
    assert resolver.resolve(result["token"], use="http", host=HOST).value == fs.TOTP_SECRET_B32
    assert open_token(keypair.private, result["token"]).seed_import_hosts == ()
    assert resolver.resolve(tok, use="otp").value == code
    with pytest.raises(PolicyViolation): resolver.resolve(result["token"], use="otp")
    dual = make_token(keypair.public, SecretPayload.create(value=fs.TOTP_SECRET_B32, hosts=[HOST], uses=["otp", "http"], label="fixture/dual", kind="totp"))
    assert resolver.resolve(dual, use="http", host=HOST).value == code


@pytest.mark.parametrize("host", ["evil.example.com", HOST + ":8443", "*.example.com", "https://" + HOST])
def test_reissue_never_broadens_a_sealed_grant(keypair, resolver, host):
    with pytest.raises(GateError): reissue_totp_seed(resolver, keypair.public, token(keypair), host, REPAIR_PURPOSE)


def test_reissue_needs_explicit_grant_and_totp_kind(keypair, resolver):
    with pytest.raises(PolicyViolation, match="原密文未授权种子导入"): repaired(keypair, resolver, token(keypair, grants=()))
    with pytest.raises(PolicyViolation, match="TOTP"): repaired(keypair, resolver, token(keypair, kind="secret", grants=()))
    with pytest.raises(ValidationError, match="only totp_seed_import"):
        reissue_totp_seed(resolver, keypair.public, token(keypair), HOST, "export")
    with pytest.raises(ValidationError, match="ciphertext"): credential_info(resolver, "plaintext is never an input")


def test_grants_validate_and_legacy_payloads_have_none(keypair, resolver):
    base = dict(value=fs.TOTP_SECRET_B32, hosts=[HOST + ":443"], uses=["otp"], label="fixture/2fa", kind="totp")
    for grants in [[HOST], ["evil.example.com"], ["*.example.com"], "bad"]:
        with pytest.raises(ValidationError): SecretPayload.create(**base, seed_import_hosts=grants)
    with pytest.raises(ValidationError, match="only to TOTP"):
        SecretPayload.create(**{**base, "kind": "secret"}, seed_import_hosts=[HOST + ":443"])
    normalized = SecretPayload.create(**base, seed_import_hosts=[HOST.upper() + ":443"])
    assert normalized.seed_import_hosts == (HOST + ":443",)
    assert SecretPayload.from_json(normalized.to_json()) == normalized
    old = json.loads(normalized.to_json()); del old["seed_import_hosts"]
    assert SecretPayload.from_json(json.dumps(old)).seed_import_hosts == ()
    result = reissue_totp_seed(resolver, keypair.public, make_token(keypair.public, normalized), HOST + ":443", REPAIR_PURPOSE)
    with pytest.raises(PolicyViolation): resolver.resolve(result["token"], use="http", host=HOST + ":8443")


def test_cli_stdin_metadata_ciphertext_and_grant_inputs(gate_home, keypair, resolver, monkeypatch, capsys):
    tok = token(keypair)
    for command, request in [("credential-info", {"token": tok}), ("credential-reissue", {"token": tok, "host": HOST, "purpose": REPAIR_PURPOSE})]:
        monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps(request)))
        assert main([command]) == 0
        captured = capsys.readouterr()
        assert fs.TOTP_SECRET_B32 not in captured.out + captured.err
        data = json.loads(captured.out)
        assert "value" not in data and "v" not in data
        if command == "credential-reissue": assert resolver.resolve(data["token"], use="http", host=HOST).value == fs.TOTP_SECRET_B32
    for raw in ["bad json", "[]", json.dumps({"token": tok, "value": fs.TOTP_SECRET_B32})]:
        monkeypatch.setattr("sys.stdin", io.StringIO(raw))
        assert main(["credential-info"]) == 2
        captured = capsys.readouterr()
        assert not captured.out and fs.TOTP_SECRET_B32 not in captured.err
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps({"token": token(keypair, grants=()), "host": HOST, "purpose": REPAIR_PURPOSE})))
    assert main(["credential-reissue"]) == 2
    assert "原密文未授权种子导入" in capsys.readouterr().err
    entry = {"value": fs.TOTP_SECRET_B32, "label": "fixture/2fa", "kind": "totp", "hosts": [HOST], "uses": ["otp"], "seed_import_hosts": [HOST]}
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps([entry])))
    assert main(["enc", "--batch"]) == 0
    assert resolver.describe(json.loads(capsys.readouterr().out)[0]["token"])["seed_import_hosts"] == [HOST]
    monkeypatch.setattr("sys.stdin", io.StringIO(fs.TOTP_SECRET_B32))
    assert main(["enc", "--stdin", "--kind", "totp", "--use", "otp", "--host", HOST, "--label", "fixture/2fa", "--seed-import-host", HOST]) == 0
    assert resolver.describe(capsys.readouterr().out.strip())["seed_import_hosts"] == [HOST]


def test_reissue_can_open_previous_key_and_uses_current_key(gate_home, keypair, monkeypatch, capsys):
    from secret_gate.keyring import create_keypair, set_current
    from secret_gate.keystore import load_private_key
    from secret_gate.resolver import Resolver
    tok = token(keypair)
    create_keypair(gate_home, "next"); set_current(gate_home, "next")
    monkeypatch.setattr("sys.stdin", io.StringIO(json.dumps({"token": tok, "host": HOST, "purpose": REPAIR_PURPOSE})))
    assert main(["credential-reissue"]) == 0
    result = json.loads(capsys.readouterr().out)
    assert open_token(load_private_key(gate_home), result["token"]).value == fs.TOTP_SECRET_B32
    assert Resolver.from_home(gate_home).describe(tok)["seed_import_hosts"] == [HOST]


def test_invalid_encrypted_metadata_is_not_echoed(keypair, resolver):
    from secret_gate.crypto import b64url_encode, encrypt
    malformed = json.dumps({"v": fs.TOTP_SECRET_B32, "host": ["https://" + fs.TOTP_SECRET_B32], "use": ["otp"], "label": "fixture/2fa", "kind": "totp"})
    tok = "enc:v1:" + b64url_encode(encrypt(keypair.public, malformed.encode()))
    with pytest.raises(ValidationError) as exc: credential_info(resolver, tok)
    assert fs.TOTP_SECRET_B32 not in str(exc.value)


def test_downstream_browser_does_not_inherit_bridge_capability():
    from secret_gate.browser_mcp import downstream_env
    assert downstream_env({**ENV, "PATH": "/bin"}) == {"PATH": "/bin"}


@pytest.mark.parametrize("url", ["https://127.0.0.1:4799/credential-repair", "http://localhost:4799/credential-repair", "http://127.0.0.2:4799/credential-repair", "http://127.0.0.1:0/credential-repair", "http://127.0.0.1:65536/credential-repair", "http://u:p@127.0.0.1:4799/credential-repair", BRIDGE + "?x=1", BRIDGE + "#x", BRIDGE + "/", "http://127.0.0.1/credential-repair"])
def test_bridge_rejects_other_destinations_and_redirect_shapes(url):
    with pytest.raises(ValidationError): bridge_config({**ENV, "SECRET_GATE_REPAIR_URL": url})


def test_bridge_needs_task_config_and_ciphertext(keypair):
    with pytest.raises(PolicyViolation, match="active dispatcher task"): asyncio.run(request_repair(token(keypair), HOST, env={}))
    with pytest.raises(ValidationError, match="authorization"): bridge_config({**ENV, "SECRET_GATE_REPAIR_KEY": "x\nheader"})


@pytest.mark.parametrize("extra", [{}, {"seed_import_hosts": []}])
def test_bridge_is_authenticated_ciphertext_only_no_proxy_or_redirect(keypair, resolver, monkeypatch, extra):
    tok = token(keypair); result = repaired(keypair, resolver, tok)
    calls = []
    def handler(request):
        calls.append(request)
        assert request.url == httpx.URL(BRIDGE)
        assert request.headers["Authorization"] == "Bearer " + ENV["SECRET_GATE_REPAIR_KEY"]
        assert json.loads(request.content) == {"token": tok, "host": HOST, "purpose": REPAIR_PURPOSE}
        assert fs.TOTP_SECRET_B32 not in request.content.decode()
        return httpx.Response(200, json={"ok": True, **result, **extra})
    client_class = httpx.AsyncClient; options = []
    def factory(**kwargs): options.append(kwargs); return client_class(**kwargs)
    monkeypatch.setattr("secret_gate.credential_repair.httpx.AsyncClient", factory)
    got = asyncio.run(request_repair(tok, HOST, env=ENV, transport=httpx.MockTransport(handler)))
    assert got == result and fs.TOTP_SECRET_B32 not in json.dumps(got)
    assert options[0]["trust_env"] is False and options[0]["follow_redirects"] is False and options[0]["timeout"] == 65
    assert len(calls) == 1


@pytest.mark.parametrize("mode", ["redirect", "denied", "plaintext", "host", "uses", "grant", "json", "network", "timeout"])
def test_bridge_errors_never_return_response_text_or_plaintext(keypair, resolver, monkeypatch, mode):
    tok = token(keypair); result = {"ok": True, **repaired(keypair, resolver, tok)}; calls = []
    async def handler(request):
        calls.append(request)
        if mode == "redirect": return httpx.Response(302, headers={"location": "http://evil.example.com/"}, text=fs.TOTP_SECRET_B32)
        if mode == "denied": return httpx.Response(200, json={"ok": False, "error": fs.TOTP_SECRET_B32})
        if mode == "plaintext": return httpx.Response(200, json={**result, "value": fs.TOTP_SECRET_B32})
        if mode == "host": return httpx.Response(200, json={**result, "hosts": ["evil.example.com"]})
        if mode == "uses": return httpx.Response(200, json={**result, "uses": ["http", "exec"]})
        if mode == "grant": return httpx.Response(200, json={**result, "seed_import_hosts": [HOST]})
        if mode == "json": return httpx.Response(200, text=fs.TOTP_SECRET_B32)
        if mode == "network": raise httpx.ConnectError(fs.TOTP_SECRET_B32)
        await asyncio.sleep(10)
    monkeypatch.setattr("secret_gate.credential_repair.REPAIR_TIMEOUT_SECONDS", .01)
    with pytest.raises(GateError) as exc: asyncio.run(request_repair(tok, HOST, env=ENV, transport=httpx.MockTransport(handler)))
    assert fs.TOTP_SECRET_B32 not in str(exc.value) and len(calls) == 1


def test_browser_error_keeps_denial_and_points_to_repair_without_fill(keypair, resolver):
    from secret_gate.browser_gate import BrowserGate
    pw = FakePlaywright(PAGE); gate = BrowserGate(resolver, pw)
    with pytest.raises(RuntimeError) as exc: asyncio.run(gate.call_tool("secret_fill", {"target": "seed", "token": token(keypair)}))
    assert "does not allow use 'http'" in str(exc.value) and "secret_repair" in str(exc.value)
    assert fs.TOTP_SECRET_B32 not in str(exc.value) and not pw.typed


def test_both_mcp_surfaces_forward_repair_only(gate_home, keypair, resolver, monkeypatch):
    from secret_gate.browser_gate import BrowserGate
    from secret_gate.mcp_server import build_server
    tok = token(keypair); result = repaired(keypair, resolver, tok); calls = []
    async def bridge(token, host, purpose=REPAIR_PURPOSE): calls.append((token, host, purpose)); return result
    monkeypatch.setattr("secret_gate.browser_gate.request_repair", bridge)
    monkeypatch.setattr("secret_gate.mcp_server.request_repair", bridge)
    async def scenario():
        browser = BrowserGate(resolver, FakePlaywright())
        assert "secret_repair" in {tool.name for tool in await browser.list_tools()}
        out = await browser.call_tool("secret_repair", {"token": tok, "host": HOST})
        assert json.loads(out[0].text) == result
        server = build_server()
        assert "secret_repair" in {tool.name for tool in await server.list_tools()}
        response = await server.call_tool("secret_repair", {"token": tok, "host": HOST})
        assert fs.TOTP_SECRET_B32 not in str(response)
    asyncio.run(scenario())
    assert calls == [(tok, HOST, REPAIR_PURPOSE)] * 2
