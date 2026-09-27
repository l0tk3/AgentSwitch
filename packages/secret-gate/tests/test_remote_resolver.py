"""The browser component as a client of the gate service (gate-service-v0 §1, §4): fill-only values, host check,
sealed page data registered by the service, mask configuration from the service, output in a user temp dir."""

from __future__ import annotations

import asyncio
import json
import stat

import pytest

from secret_gate.browser_gate import BrowserGate
from secret_gate.browser_mcp import service_setup, user_output_dir
from secret_gate.constants import USE_FILL, USE_HTTP
from secret_gate.errors import PolicyViolation, ValidationError
from secret_gate.keystore import load_public_key
from secret_gate.policy import SecretPayload
from secret_gate.remote_resolver import RemoteResolver, repair_params
from secret_gate.rpc_protocol import RemoteError
from secret_gate.tokens import make_token
from tests.fixtures import fake_secrets as fs
from tests.service_fixtures import running_service
from tests.test_browser_gate import FakePlaywright, texts

SCOPE = "browser-scope-0123456789abcdef"
PAGE = "https://login.portal-a.example.com/signin"


def _token(home, uses, label="portal-a/pass") -> str:
    payload = SecretPayload.create(value=fs.PORTAL.password, hosts=list(fs.PORTAL.hosts), uses=set(uses), label=label)
    return make_token(load_public_key(home), payload)


def test_remote_resolver_policy():
    with running_service() as svc:
        resolver = RemoteResolver(svc.client, SCOPE, env={})
        fill = _token(svc.home, {USE_FILL})
        res = resolver.resolve(fill, use=USE_FILL, host="login.portal-a.example.com:443")
        assert res.value == fs.PORTAL.password and res.label == "portal-a/pass" and res.token == fill
        with pytest.raises(PolicyViolation, match="only for a fill"):
            resolver.resolve(fill, use=USE_HTTP, host="login.portal-a.example.com:443")
        with pytest.raises(PolicyViolation, match="requires a target host"):
            resolver.resolve(fill, use=USE_FILL)
        with pytest.raises(RemoteError, match="does not allow use 'fill'"):
            resolver.resolve(_token(svc.home, {USE_HTTP}), use=USE_FILL, host="login.portal-a.example.com:443")
        with pytest.raises(RemoteError, match="not allowed on host"):
            resolver.resolve(fill, use=USE_FILL, host="evil.example:443")
        text, resolutions = resolver.substitute(f"user {fill}", use=USE_FILL, host="login.portal-a.example.com:443")
        assert text == f"user {fs.PORTAL.password}" and len(resolutions) == 1
        ref = resolver.register(fill)
        assert resolver.resolve(ref, use=USE_FILL, host="login.portal-a.example.com:443").value == fs.PORTAL.password
        with pytest.raises(ValidationError, match="no execution scope"):
            RemoteResolver(svc.client, None, env={}).register(fill)
    assert repair_params({"SECRET_GATE_REPAIR_URL": "u", "SECRET_GATE_REPAIR_KEY": "", "OTHER": "x"}) == {"repairUrl": "u"}


def test_browser_gate_fills_through_the_service_and_redacts():
    with running_service() as svc:
        pw = FakePlaywright(PAGE)
        gate = BrowserGate(RemoteResolver(svc.client, SCOPE, env={}), pw)
        fill = _token(svc.home, {USE_FILL})
        out = asyncio.run(gate.call_tool("secret_fill", {"target": "e7", "token": fill}))
        assert pw.typed["e7"] == fs.PORTAL.password
        assert fs.PORTAL.password not in texts(out) and "[REDACTED:portal-a/pass]" not in fill
        snapshot = asyncio.run(gate.call_tool("browser_snapshot", {}))
        assert "[REDACTED:portal-a/pass]" in texts(snapshot) and fs.PORTAL.password not in texts(snapshot)
        with pytest.raises(RuntimeError, match="does not allow use 'fill'"):
            asyncio.run(gate.call_tool("secret_fill", {"target": "e9", "token": _token(svc.home, {USE_HTTP})}))
        assert "e9" not in pw.typed
        audit = [json.loads(line) for line in svc.audit.read_text().splitlines()]
        assert any(line["method"] == "browser.resolve" and line["ok"] for line in audit)


def test_transfer_sealing_registers_references_in_the_service():
    from secret_gate.transfer import TransferGrant

    grant = TransferGrant.parse(json.dumps({"source": ["crm.example.com"], "destination": ["erp.example.com:8443"],
                                            "fields": ["email"], "purpose": "copy the contact e-mail"}))
    with running_service() as svc:
        pw = FakePlaywright("https://crm.example.com/customers/42")
        pw.echo = '- paragraph [ref=e9]: "Contact alice.demo@example.com"'
        gate = BrowserGate(RemoteResolver(svc.client, SCOPE, env={}), pw, transfer=grant,
                           public_key=load_public_key(svc.home))
        out = texts(asyncio.run(gate.call_tool("browser_snapshot", {})))
        assert "alice.demo@example.com" not in out and "enc:ref:" in out
        ref = next(word for word in out.split() if word.startswith("enc:ref:"))[:24]
        described = svc.client.call("mcp.describe", {"scope": SCOPE, "token": ref})
        assert described["uses"] == ["fill"] and described["hosts"] == ["erp.example.com:8443"]


def test_service_setup_takes_key_and_mask_from_the_service(monkeypatch):
    with running_service() as svc, user_output_dir() as out_dir:
        (svc.home / "screenshot-mask.json").write_text(json.dumps({"regions": {"a.example": [".card"]}}))
        env = {"SECRET_GATE_PUBLIC": str(svc.public), "SECRET_GATE_SCOPE": SCOPE,
               "SECRET_GATE_TRANSFER": json.dumps({"source": ["a.example"], "destination": ["b.example"],
                                                   "fields": ["email"], "purpose": "p"})}
        setup = service_setup(env, svc.client, out_dir)
        assert setup.public_key == load_public_key(svc.home) and setup.grant is not None
        assert setup.mask.selectors_for("a.example:443") == (".card",)
        assert setup.resolver.scope == SCOPE and setup.out_dir == out_dir
        assert stat.S_IMODE(out_dir.stat().st_mode) == 0o700
    assert not out_dir.exists()                                          # removed at exit
