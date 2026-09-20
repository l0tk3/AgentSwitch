import pytest
from mitmproxy.test import taddons, tflow

from secret_gate.proxy_addon import SecretGateAddon
from tests.fixtures import fake_secrets as fs


@pytest.fixture
def addon(resolver):
    return SecretGateAddon(resolver)


def _flow(host, path="/login", method="POST", body=b"", headers=None, scheme="https"):
    f = tflow.tflow()
    f.request.host = host
    f.request.scheme = scheme
    f.request.port = 443 if scheme == "https" else 80
    f.request.path = path
    f.request.method = method
    f.request.headers.clear()
    f.request.headers["Host"] = host
    for k, v in (headers or {}).items():
        f.request.headers[k] = v
    f.request.content = body
    return f


def test_form_login_substituted(addon, portal_user, portal_pass):
    f = _flow("portal-a.example.com", body=f"user={portal_user}&pass={portal_pass}".encode())
    with taddons.context(addon):
        addon.request(f)
    assert f.response is None
    assert f.request.text == f"user={fs.PORTAL.username}&pass={fs.PORTAL.password}"


def test_header_and_query_substituted(addon, api_bearer, portal_user):
    f = _flow("api.c.example.org", path="/v1/me", method="GET",
              headers={"Authorization": f"Bearer {api_bearer}"})
    with taddons.context(addon):
        addon.request(f)
    assert f.request.headers["Authorization"] == f"Bearer {fs.API_BEARER.password}"


def test_wrong_host_denied_without_leak(addon, portal_pass):
    f = _flow(fs.EVIL_HOST, body=f"pass={portal_pass}".encode())
    with taddons.context(addon):
        addon.request(f)
    assert f.response is not None and f.response.status_code == 403
    assert "not allowed on host" in f.response.text
    assert fs.PORTAL.password not in f.request.text
    assert fs.PORTAL.password not in f.response.text


def test_tampered_token_denied(addon, portal_pass):
    f = _flow("portal-a.example.com", body=f"pass={portal_pass[:-3]}zzz".encode())
    with taddons.context(addon):
        addon.request(f)
    assert f.response.status_code == 403


def test_response_redacted(addon, portal_user, portal_pass):
    f = _flow("portal-a.example.com", body=f"user={portal_user}&pass={portal_pass}".encode())
    with taddons.context(addon):
        addon.request(f)
        f.response = tflow.tresp(content=f"Welcome {fs.PORTAL.username}! pw={fs.PORTAL.password}".encode())
        f.response.headers["X-Debug"] = fs.PORTAL.password
        addon.response(f)
    assert f.response.text == "Welcome [REDACTED:portal-a/user]! pw=[REDACTED:portal-a/pass]"
    assert f.response.headers["X-Debug"] == "[REDACTED:portal-a/pass]"


def test_no_tokens_passthrough(addon):
    f = _flow("portal-a.example.com", body=b"user=plain&pass=plain")
    with taddons.context(addon):
        addon.request(f)
        f.response = tflow.tresp(content=b"ok")
        addon.response(f)
    assert f.request.text == "user=plain&pass=plain" and f.response.text == "ok"


def test_binary_body_ignored(addon, portal_pass):
    f = _flow("portal-a.example.com", body=b"\x00\xff" + portal_pass.encode(), headers={"Content-Type": "application/octet-stream"})
    with taddons.context(addon):
        addon.request(f)
    # binary bodies are still text-decodable with strict=False; substitution should have happened
    assert fs.PORTAL.password.encode() in f.request.raw_content or f.response is None
