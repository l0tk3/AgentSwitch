"""Hybrid public-key encryption via libsodium sealed boxes (X25519 + XSalsa20-Poly1305).

Anyone with the public key can encrypt; only the gate's private key can decrypt.
"""

from __future__ import annotations

import base64
from dataclasses import dataclass

from nacl.exceptions import CryptoError
from nacl.public import PrivateKey, PublicKey, SealedBox

from .errors import TokenError

KEY_BYTES = 32


def b64url_encode(data: bytes) -> str:
    return base64.urlsafe_b64encode(data).decode("ascii").rstrip("=")


def b64url_decode(text: str) -> bytes:
    padded = text + "=" * (-len(text) % 4)
    try:
        return base64.urlsafe_b64decode(padded)
    except (ValueError, TypeError) as exc:
        raise TokenError("invalid base64url") from exc


@dataclass(frozen=True)
class KeyPair:
    public: bytes
    private: bytes


def generate_keypair() -> KeyPair:
    priv = PrivateKey.generate()
    return KeyPair(public=bytes(priv.public_key), private=bytes(priv))


def _check_key(raw: bytes, name: str) -> None:
    if not isinstance(raw, (bytes, bytearray)) or len(raw) != KEY_BYTES:
        raise TokenError(f"{name} key must be {KEY_BYTES} bytes")


def encrypt(public_key: bytes, plaintext: bytes) -> bytes:
    _check_key(public_key, "public")
    return SealedBox(PublicKey(bytes(public_key))).encrypt(plaintext)


def decrypt(private_key: bytes, ciphertext: bytes) -> bytes:
    _check_key(private_key, "private")
    try:
        return SealedBox(PrivateKey(bytes(private_key))).decrypt(ciphertext)
    except CryptoError as exc:
        raise TokenError("decryption failed: token is tampered or not for this gate") from exc
