"""A gate that holds several private keys resolves tokens minted for any of them."""
import pytest

from secret_gate.constants import USE_HTTP
from secret_gate.crypto import generate_keypair
from secret_gate.errors import TokenError
from secret_gate.policy import SecretPayload
from secret_gate.resolver import Resolver
from secret_gate.tokens import make_token


def _tok(pub, value="v-1234"):
    return make_token(pub, SecretPayload.create(value=value, hosts=["h.example.com"], uses={USE_HTTP}, label="x/y"))


def test_resolver_tries_every_key():
    a, b, c = generate_keypair(), generate_keypair(), generate_keypair()
    r = Resolver(a.private, extra_private_keys=(b.private,))
    assert r.resolve(_tok(a.public), use=USE_HTTP, host="h.example.com").value == "v-1234"
    assert r.resolve(_tok(b.public), use=USE_HTTP, host="h.example.com").value == "v-1234"
    with pytest.raises(TokenError):
        r.resolve(_tok(c.public), use=USE_HTTP, host="h.example.com")
