from __future__ import annotations

import pytest

from secret_gate.constants import KIND_TOTP, USE_EXEC, USE_HTTP, USE_OTP
from secret_gate.crypto import generate_keypair
from secret_gate.policy import SecretPayload
from secret_gate.resolver import Resolver
from secret_gate.tokens import make_token

from .fixtures import fake_secrets as fs

FIXED_TIME = 1_700_000_000.0


@pytest.fixture(scope="session")
def keypair():
    return generate_keypair()


@pytest.fixture(scope="session")
def other_keypair():
    return generate_keypair()


@pytest.fixture
def resolver(keypair):
    return Resolver(keypair.private, clock=lambda: FIXED_TIME)


def _tok(pub, *, value, hosts, uses, label, kind="secret"):
    return make_token(pub, SecretPayload.create(value=value, hosts=hosts, uses=uses, label=label, kind=kind))


@pytest.fixture
def portal_pass(keypair):
    return _tok(keypair.public, value=fs.PORTAL.password, hosts=fs.PORTAL.hosts, uses={USE_HTTP}, label=fs.PORTAL.label)


@pytest.fixture
def portal_user(keypair):
    return _tok(keypair.public, value=fs.PORTAL.username, hosts=fs.PORTAL.hosts, uses={USE_HTTP}, label="portal-a/user")


@pytest.fixture
def portal_totp(keypair):
    return _tok(keypair.public, value=fs.TOTP_SECRET_B32, hosts=fs.PORTAL.hosts, uses={USE_HTTP, USE_OTP}, label=fs.TOTP_LABEL, kind=KIND_TOTP)


@pytest.fixture
def bank_pass(keypair):
    return _tok(keypair.public, value=fs.BANK.password, hosts=fs.BANK.hosts, uses={USE_HTTP}, label=fs.BANK.label)


@pytest.fixture
def api_bearer(keypair):
    return _tok(keypair.public, value=fs.API_BEARER.password, hosts=fs.API_BEARER.hosts, uses={USE_HTTP}, label=fs.API_BEARER.label)


@pytest.fixture
def db_pass(keypair):
    return _tok(keypair.public, value=fs.DB.password, hosts=(), uses={USE_EXEC}, label=fs.DB.label)


@pytest.fixture
def gate_home(tmp_path, monkeypatch, keypair):
    from secret_gate.keystore import save_keypair

    home = tmp_path / "gate"
    save_keypair(home, keypair)
    monkeypatch.setenv("SECRET_GATE_HOME", str(home))
    return home
