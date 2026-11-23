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


# gate-simple-v0 §3.4: the ciphertext's length must not follow the value's.

def _sealed(token: str) -> bytes:
    from secret_gate.crypto import b64url_decode

    return b64url_decode(token[len("enc:v1:"):])


def test_ciphertexts_of_1_to_200_characters_come_in_64_byte_steps(keypair):
    from secret_gate.crypto import decrypt
    from secret_gate.tokens import sealed_plaintext

    lengths = set()
    for n in range(1, 201):
        payload = SecretPayload.create(value="x" * n, hosts=["a.com"], uses=["http"], label="a/pw")
        tok = make_token(keypair.public, payload)
        sealed = _sealed(tok)
        assert (len(sealed) - 48) % 64 == 0  # 32-byte ephemeral key + 16-byte MAC around the padded plaintext
        lengths.add(len(sealed))
        plain = decrypt(keypair.private, sealed)
        assert plain == sealed_plaintext(payload) and plain.rstrip(b" ") == payload.to_json().encode()
        assert open_token(keypair.private, tok) == payload
    assert len(lengths) == 4  # 200 lengths collapse into four sizes


def test_padding_is_exact_and_stripped():
    from secret_gate.tokens import pad_plaintext, unpad_plaintext

    assert pad_plaintext(b"{}") == b"{}" + b" " * 62
    exact = b"{" + b"a" * 62 + b"}"
    assert pad_plaintext(exact) == exact  # already a multiple of 64: nothing added
    assert len(pad_plaintext(b"{" + b"a" * 63 + b"}")) == 128
    assert unpad_plaintext(pad_plaintext(b'{"v":"a "}')) == b'{"v":"a "}'  # a value's own spaces stay inside the JSON


def test_value_with_trailing_spaces_survives(keypair):
    payload = SecretPayload.create(value="pass word  ", hosts=["a.com"], uses=["http"], label="a/pw")
    assert open_token(keypair.private, make_token(keypair.public, payload)).value == "pass word  "


def test_unpadded_plaintext_still_opens(keypair):
    """The reader strips padding it finds; a plaintext sealed without any opens the same."""
    from secret_gate.crypto import b64url_encode, encrypt

    tok = "enc:v1:" + b64url_encode(encrypt(keypair.public, _payload().to_json().encode()))
    assert open_token(keypair.private, tok) == _payload()


def test_json_loads_accepts_the_padding_without_the_strip():
    padded = _payload().to_json() + " " * 40
    assert SecretPayload.from_json(padded) == _payload()
