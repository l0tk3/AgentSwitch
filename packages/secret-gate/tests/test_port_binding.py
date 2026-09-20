"""Same host, different ports = different sites. A token may be bound to `host:port`.

Without a port in the policy the old behaviour stays (any port). With a port, only that port.
Found by a user running many services on one hostname.
"""
import pytest
from mitmproxy.test import tflow

from secret_gate.constants import USE_HTTP
from secret_gate.errors import PolicyViolation, ValidationError
from secret_gate.policy import SecretPayload, host_matches, normalize_host
from secret_gate.proxy_addon import SecretGateAddon
from secret_gate.resolver import Resolver
from secret_gate.tokens import make_token


@pytest.mark.parametrize("raw,norm", [
    ("10.0.0.5:8001", "10.0.0.5:8001"),
    ("Site.Example.COM.:443", "site.example.com:443"),
    ("*.example.com:9000", "*.example.com:9000"),
    ("site.example.com", "site.example.com"),
])
def test_normalize_keeps_port(raw, norm):
    assert normalize_host(raw) == norm


@pytest.mark.parametrize("bad", ["h:0", "h:70000", "h:abc", "h:", ":80", "h:80:90"])
def test_bad_ports_rejected(bad):
    with pytest.raises(ValidationError):
        normalize_host(bad)


@pytest.mark.parametrize("pattern,host,expected", [
    ("10.0.0.5:8001", "10.0.0.5:8001", True),
    ("10.0.0.5:8001", "10.0.0.5:8002", False),
    ("10.0.0.5:8001", "10.0.0.5", False),          # port required but unknown -> deny
    ("10.0.0.5", "10.0.0.5:8002", True),            # no port in policy -> any port
    ("*.example.com:9000", "a.example.com:9000", True),
    ("*.example.com:9000", "a.example.com:9001", False),
    ("*.example.com", "a.example.com:9001", True),
])
def test_host_matches_with_ports(pattern, host, expected):
    assert host_matches(pattern, host) is expected


def _tok(pub, hosts):
    return make_token(pub, SecretPayload.create(value="pw-1234", hosts=hosts, uses={USE_HTTP}, label="svc/pass"))


def test_resolver_enforces_port(keypair):
    r = Resolver(keypair.private)
    tok = _tok(keypair.public, ["10.0.0.5:8001"])
    assert r.resolve(tok, use=USE_HTTP, host="10.0.0.5:8001").value == "pw-1234"
    with pytest.raises(PolicyViolation, match="8002"):
        r.resolve(tok, use=USE_HTTP, host="10.0.0.5:8002")


def test_proxy_passes_port(keypair):
    addon = SecretGateAddon(Resolver(keypair.private))
    tok = _tok(keypair.public, ["10.0.0.5:8001"])
    for port, allowed in ((8001, True), (8002, False)):
        f = tflow.tflow()
        f.request.host, f.request.scheme, f.request.port, f.request.method = "10.0.0.5", "http", port, "POST"
        f.request.text = f"pass={tok}"
        addon.request(f)
        if allowed:
            assert f.response is None and f.request.text == "pass=pw-1234"
        else:
            assert f.response is not None and f.response.status_code == 403
            assert "pw-1234" not in f.request.text


def test_op_http_passes_port(keypair, respx_mock):
    import httpx

    from secret_gate.gate_ops import op_http

    r = Resolver(keypair.private)
    tok = _tok(keypair.public, ["svc.example.com:8443"])
    respx_mock.post("https://svc.example.com:8443/login").mock(return_value=httpx.Response(200, text="ok"))
    res = op_http(r, method="POST", url="https://svc.example.com:8443/login", body=f"pass={tok}")
    assert res.status == 200
    with pytest.raises(PolicyViolation):
        op_http(r, method="POST", url="https://svc.example.com/login", body=f"pass={tok}")  # implicit 443
