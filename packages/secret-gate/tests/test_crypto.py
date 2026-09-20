import pytest

from secret_gate.crypto import b64url_decode, b64url_encode, decrypt, encrypt, generate_keypair
from secret_gate.errors import TokenError


def test_roundtrip(keypair):
    ct = encrypt(keypair.public, b"hello")
    assert decrypt(keypair.private, ct) == b"hello"


def test_ciphertext_is_randomized(keypair):
    assert encrypt(keypair.public, b"x") != encrypt(keypair.public, b"x")


def test_wrong_key_fails(keypair, other_keypair):
    ct = encrypt(keypair.public, b"secret")
    with pytest.raises(TokenError):
        decrypt(other_keypair.private, ct)


def test_tampered_ciphertext_fails(keypair):
    ct = bytearray(encrypt(keypair.public, b"secret"))
    ct[-1] ^= 0x01
    with pytest.raises(TokenError):
        decrypt(keypair.private, bytes(ct))


def test_bad_key_length():
    with pytest.raises(TokenError):
        encrypt(b"short", b"x")
    with pytest.raises(TokenError):
        decrypt(b"short", b"x")


def test_b64url_roundtrip_and_error():
    raw = bytes(range(256))
    assert b64url_decode(b64url_encode(raw)) == raw
    with pytest.raises(TokenError):
        b64url_decode("!!!not base64!!!")


def test_generate_unique():
    assert generate_keypair().private != generate_keypair().private
