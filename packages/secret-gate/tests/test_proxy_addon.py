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


# -- execution scope and enc:ref: references (gate-next-v0 §1) -------------------------------------

SCOPE = "proxy-scope-0123456789abcdef"


def _basic(user: str, secret: str) -> str:
    import base64

    return "Basic " + base64.b64encode(f"{user}:{secret}".encode()).decode()


@pytest.fixture
def ref_setup(tmp_path, keypair, portal_pass):
    from secret_gate.refs import RefRegistry
    from secret_gate.resolver import Resolver

    registry = RefRegistry(tmp_path / "refs.sqlite3")
    ref = registry.register(SCOPE, portal_pass, fs.PORTAL.label)
    return SecretGateAddon(Resolver(keypair.private, refs=registry)), ref


def test_scope_header_parsing():
    from secret_gate.proxy_addon import scope_from_header

    assert scope_from_header(_basic("scope", SCOPE)) == SCOPE
    assert scope_from_header(_basic("other", SCOPE)) is None
    assert scope_from_header(_basic("scope", "short")) is None
    assert scope_from_header("Bearer x") is None and scope_from_header("Basic !!!") is None
    assert scope_from_header(None) is None


def test_reference_resolves_with_scope_on_connect(ref_setup):
    addon, ref = ref_setup
    connect = _flow("portal-a.example.com", method="CONNECT", headers={"Proxy-Authorization": _basic("scope", SCOPE)})
    inner = _flow("portal-a.example.com", body=f"pass={ref}".encode())
    inner.client_conn = connect.client_conn
    with taddons.context(addon):
        addon.http_connect(connect)
        addon.request(inner)
    assert inner.response is None and inner.request.text == f"pass={fs.PORTAL.password}"
    addon.client_disconnected(connect.client_conn)
    again = _flow("portal-a.example.com", body=f"pass={ref}".encode())
    again.client_conn = connect.client_conn
    with taddons.context(addon):
        addon.request(again)
    assert again.response.status_code == 403  # scope forgotten with the connection


def test_plain_http_request_scope_is_used_and_never_forwarded(ref_setup):
    addon, ref = ref_setup
    f = _flow("portal-a.example.com", scheme="http", body=f"pass=enc%3Aref%3A{ref[8:]}".encode(),
              headers={"Proxy-Authorization": _basic("scope", SCOPE)})
    f.request.port = 443  # the token allows any port of the host
    with taddons.context(addon):
        addon.request(f)
    assert f.response is None and "Proxy-Authorization" not in f.request.headers
    assert fs.PORTAL.password.replace("!", "%21") in f.request.text


def test_reference_without_scope_is_denied_with_guidance(ref_setup):
    addon, ref = ref_setup
    f = _flow("portal-a.example.com", body=f"pass={ref}".encode(),
              headers={"Proxy-Authorization": _basic("someone", "else")})
    with taddons.context(addon):
        addon.request(f)
    assert f.response.status_code == 403 and f.response.headers["X-Secret-Gate"] == "denied"
    assert "task scope" in f.response.text and "Proxy-Authorization" not in f.request.headers


def test_reference_keeps_host_policy_behind_the_proxy(ref_setup):
    addon, ref = ref_setup
    f = _flow(fs.EVIL_HOST, body=f"pass={ref}".encode(), headers={"Proxy-Authorization": _basic("scope", SCOPE)})
    with taddons.context(addon):
        addon.request(f)
    assert f.response.status_code == 403 and "not allowed on host" in f.response.text
    assert fs.PORTAL.password not in f.request.text


# -- fail closed (security review 2026-09-24) -------------------------------------------------------

def test_spoofed_host_header_cannot_redirect_a_value(addon, portal_pass):
    f = _flow(fs.EVIL_HOST, body=f"pass={portal_pass}".encode(), headers={"Host": "portal-a.example.com"})
    with taddons.context(addon):
        addon.request(f)
    assert f.response is not None and f.response.status_code == 403
    assert fs.PORTAL.password not in f.request.text


def test_host_header_must_match_the_real_destination(addon, portal_pass):
    f = _flow("portal-a.example.com", body=f"pass={portal_pass}".encode(), headers={"Host": "cdn-front.example.net"})
    with taddons.context(addon):
        addon.request(f)
    assert f.response.status_code == 403 and "Host header" in f.response.text
    assert fs.PORTAL.password not in f.request.text
    plain = _flow("portal-a.example.com", body=b"nothing secret", headers={"Host": "cdn-front.example.net"})
    with taddons.context(addon):
        addon.request(plain)
    assert plain.response is None  # without a value the header is none of the gate's business


def test_unexpected_error_denies_and_leaves_the_request_untouched(addon, portal_user, monkeypatch):
    f = _flow("portal-a.example.com", path=f"/login?u={portal_user}", method="GET")
    original = f.request.url

    def boom(*args, **kwargs):
        raise RuntimeError("database is locked")

    monkeypatch.setattr(addon._resolver, "scoped", lambda scope: type("R", (), {"substitute": boom})())
    with taddons.context(addon):
        addon.request(f)
    assert f.response.status_code == 403 and "nothing was sent" in f.response.text
    assert f.request.url == original and fs.PORTAL.username not in f.request.url


def test_response_that_cannot_be_redacted_is_withheld(addon, portal_pass, monkeypatch):
    from mitmproxy import http

    f = _flow("portal-a.example.com", body=f"pass={portal_pass}".encode())
    with taddons.context(addon):
        addon.request(f)
    f.response = http.Response.make(200, f"hello {fs.PORTAL.password}".encode(), {"Content-Type": "text/plain"})
    monkeypatch.setattr("secret_gate.proxy_addon.redact", lambda *a: (_ for _ in ()).throw(ValueError("x")))
    with taddons.context(addon):
        addon.response(f)
    assert f.response.status_code == 502 and fs.PORTAL.password not in f.response.text
