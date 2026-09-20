import pytest

from secret_gate.errors import PolicyViolation, TokenError, ValidationError
from secret_gate.otp import totp
from tests.conftest import FIXED_TIME
from tests.fixtures import fake_secrets as fs


def test_resolve_http_allowed_host(resolver, portal_pass):
    res = resolver.resolve(portal_pass, use="http", host="portal-a.example.com")
    assert res.value == fs.PORTAL.password and res.label == fs.PORTAL.label


def test_resolve_http_wrong_host(resolver, portal_pass):
    with pytest.raises(PolicyViolation, match="not allowed on host"):
        resolver.resolve(portal_pass, use="http", host=fs.EVIL_HOST)


def test_resolve_http_needs_host(resolver, portal_pass):
    with pytest.raises(PolicyViolation, match="requires a target host"):
        resolver.resolve(portal_pass, use="http")


def test_resolve_wrong_use(resolver, portal_pass, db_pass):
    with pytest.raises(PolicyViolation, match="does not allow use"):
        resolver.resolve(portal_pass, use="exec")
    with pytest.raises(PolicyViolation, match="does not allow use"):
        resolver.resolve(db_pass, use="http", host="portal-a.example.com")


def test_resolve_unknown_use(resolver, portal_pass):
    with pytest.raises(ValidationError):
        resolver.resolve(portal_pass, use="teleport")


def test_otp_requires_totp_kind(resolver, portal_pass, keypair):
    from secret_gate.policy import SecretPayload
    from secret_gate.tokens import make_token

    tok = make_token(keypair.public, SecretPayload.create(value="pw", hosts=[], uses=["otp"], label="l"))
    with pytest.raises(PolicyViolation, match="not a TOTP secret"):
        resolver.resolve(tok, use="otp")


def test_totp_materializes_code(resolver, portal_totp):
    res = resolver.resolve(portal_totp, use="otp")
    assert res.value == totp(fs.TOTP_SECRET_B32, at=FIXED_TIME)
    # base32 secret itself must never come out
    assert fs.TOTP_SECRET_B32 not in res.value


def test_wildcard_host(resolver, bank_pass):
    assert resolver.resolve(bank_pass, use="http", host="online.bank-b.example.net").value == fs.BANK.password
    with pytest.raises(PolicyViolation):
        resolver.resolve(bank_pass, use="http", host="bank-b.example.net")


def test_substitute_multiple_and_repeat(resolver, portal_user, portal_pass):
    text = f"u={portal_user}&p={portal_pass}&again={portal_pass}"
    out, res = resolver.substitute(text, use="http", host="portal-a.example.com")
    assert out == f"u={fs.PORTAL.username}&p={fs.PORTAL.password}&again={fs.PORTAL.password}"
    assert [r.label for r in res] == ["portal-a/user", fs.PORTAL.label]
    assert "enc:v1:" not in out


def test_substitute_no_tokens_is_identity(resolver):
    assert resolver.substitute("plain", use="http", host="a") == ("plain", ())


def test_substitute_tampered_token_fails_closed(resolver, portal_pass):
    broken = portal_pass[:-4] + "AAAA"
    with pytest.raises(TokenError):
        resolver.substitute(f"p={broken}", use="http", host="portal-a.example.com")


def test_describe_hides_value(resolver, portal_pass):
    info = resolver.describe(portal_pass)
    assert info["label"] == fs.PORTAL.label
    assert fs.PORTAL.password not in str(info)
