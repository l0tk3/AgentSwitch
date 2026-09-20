import pytest

from secret_gate.errors import TokenError, ValidationError
from secret_gate.policy import SecretPayload
from secret_gate.tokens import find_tokens, is_token, make_token, open_token


def _payload():
    return SecretPayload.create(value="pw", hosts=["a.com"], uses=["http"], label="a/pw")


def test_make_and_open(keypair):
    tok = make_token(keypair.public, _payload())
    assert tok.startswith("enc:v1:") and is_token(tok)
    assert open_token(keypair.private, tok) == _payload()


def test_open_rejects_garbage(keypair):
    for bad in ["", "enc:v1:", "plain", "enc:v2:abc", "enc:v1:@@@"]:
        with pytest.raises(TokenError):
            open_token(keypair.private, bad)


def test_open_rejects_other_gate(keypair, other_keypair):
    tok = make_token(other_keypair.public, _payload())
    with pytest.raises(TokenError):
        open_token(keypair.private, tok)


def test_open_rejects_valid_crypto_bad_payload(keypair):
    from secret_gate.crypto import b64url_encode, encrypt

    tok = "enc:v1:" + b64url_encode(encrypt(keypair.public, b'{"nope": 1}'))
    with pytest.raises(ValidationError):
        open_token(keypair.private, tok)


def test_find_tokens_dedup_and_order(keypair):
    t1 = make_token(keypair.public, _payload())
    t2 = make_token(keypair.public, _payload())
    text = f"user=x&pass={t1}&again={t1}&other={t2} trailing"
    assert find_tokens(text) == (t1, t2)
    assert find_tokens("nothing here") == ()
    assert find_tokens(None) == ()  # type: ignore[arg-type]
    assert not is_token("enc:v1:short")
