"""Tokens arrive URL-encoded whenever a client uses `curl --data-urlencode` or a browser submits a
form: `enc:v1:` becomes `enc%3Av1%3A`. The gate must recognise that form, substitute the
URL-encoded plaintext, and redact the URL-encoded plaintext on the way back. Found by
scripts/codex_e2e.py (Codex always uses --data-urlencode)."""
from urllib.parse import quote

import pytest

from mitmproxy import http
from mitmproxy.test import tflow

from secret_gate.proxy_addon import SecretGateAddon
from secret_gate.redact import redact
from secret_gate.resolver import Resolver
from secret_gate.tokens import find_tokens
from tests.fixtures import fake_secrets as fs

PORTAL_PASS = fs.PORTAL.password


@pytest.fixture
def addon(resolver: Resolver) -> SecretGateAddon:
    return SecretGateAddon(resolver)


def test_find_tokens_sees_urlencoded_form(portal_pass):
    encoded = quote(portal_pass, safe="")
    assert encoded != portal_pass  # the colons really are encoded
    assert find_tokens(f"user=a&pass={encoded}") == (portal_pass,)


def test_find_tokens_mixed_forms_dedup(portal_pass):
    text = f"{portal_pass} and {quote(portal_pass, safe='')}"
    assert find_tokens(text) == (portal_pass,)


def test_substitute_urlencoded_token_yields_urlencoded_value(resolver: Resolver, portal_pass):
    body = f"user=zhangsan&pass={quote(portal_pass, safe='')}"
    out, res = resolver.substitute(body, use="http", host="portal-a.example.com")
    assert out == f"user=zhangsan&pass={quote(PORTAL_PASS, safe='')}"
    assert [r.label for r in res] == ["portal-a/pass"]


def test_redact_catches_urlencoded_plaintext(resolver: Resolver, portal_pass):
    _, res = resolver.substitute(portal_pass, use="http", host="portal-a.example.com")
    echoed = f'{{"got": "pass={quote(PORTAL_PASS, safe="")}"}}'
    cleaned = redact(echoed, res)
    assert PORTAL_PASS not in cleaned and quote(PORTAL_PASS, safe="") not in cleaned
    assert "[REDACTED:portal-a/pass]" in cleaned


def test_proxy_form_urlencoded_login(addon: SecretGateAddon, portal_pass):
    flow = tflow.tflow()
    flow.request.host, flow.request.scheme, flow.request.port = "portal-a.example.com", "https", 443
    flow.request.path, flow.request.method = "/login", "POST"
    flow.request.headers["Content-Type"] = "application/x-www-form-urlencoded"
    flow.request.text = f"user=zhangsan&pass={quote(portal_pass, safe='')}"
    addon.request(flow)
    assert flow.response is None
    assert flow.request.text == f"user=zhangsan&pass={quote(PORTAL_PASS, safe='')}"
    flow.response = http.Response.make(200, f'{{"got":"pass={quote(PORTAL_PASS, safe="")}"}}'.encode())
    addon.response(flow)
    assert PORTAL_PASS not in flow.response.text and quote(PORTAL_PASS, safe="") not in flow.response.text
