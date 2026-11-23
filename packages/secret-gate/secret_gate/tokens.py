"""Token wire format: `enc:v1:<base64url(sealed_box(payload_json + spaces))>`; short references `enc:ref:<id>` (refs.py).

The payload JSON is padded with trailing spaces to a multiple of SEAL_PAD_BLOCK bytes before sealing (gate-simple-v0
§3.4), so every value up to the same block gives a ciphertext of the same length. JSON permits trailing whitespace and
the JSON never ends in a space itself, so the padding is unambiguous; `open_token` strips it anyway.
"""

from __future__ import annotations

from urllib.parse import quote, unquote

from .constants import ENCODED_REF_PATTERN, ENCODED_TOKEN_PATTERN, REF_PATTERN, SEAL_PAD_BLOCK, TOKEN_PATTERN, TOKEN_PREFIX
from .crypto import b64url_decode, b64url_encode, decrypt, encrypt
from .errors import TokenError
from .policy import SecretPayload


def pad_plaintext(plaintext: bytes) -> bytes:
    """Trailing ASCII spaces up to the next multiple of SEAL_PAD_BLOCK (nothing added when already a multiple)."""
    return plaintext + b" " * (-len(plaintext) % SEAL_PAD_BLOCK)


def unpad_plaintext(plaintext: bytes) -> bytes:
    """The payload JSON without its padding. The JSON ends in `}`, never in a space."""
    return plaintext.rstrip(b" ")


def sealed_plaintext(payload: SecretPayload) -> bytes:
    """Exactly the bytes `make_token` seals; the phones seal the same bytes (SecretPayload.sealedData)."""
    return pad_plaintext(payload.to_json().encode("utf-8"))


def make_token(public_key: bytes, payload: SecretPayload) -> str:
    return TOKEN_PREFIX + b64url_encode(encrypt(public_key, sealed_plaintext(payload)))


def is_token(text: str) -> bool:
    return isinstance(text, str) and TOKEN_PATTERN.fullmatch(text.strip()) is not None


def is_ref(text: str) -> bool:
    return isinstance(text, str) and REF_PATTERN.fullmatch(text.strip()) is not None


def is_secret(text: str) -> bool:
    """A single enc:v1: token or enc:ref: reference: what a fill or an MCP tool accepts."""
    return is_token(text) or is_ref(text)


def open_token(private_key: bytes, token: str) -> SecretPayload:
    if not isinstance(token, str) or not token.startswith(TOKEN_PREFIX):
        raise TokenError("token must start with " + TOKEN_PREFIX)
    body = token[len(TOKEN_PREFIX):].strip()
    if not body:
        raise TokenError("token body is empty")
    plaintext = decrypt(private_key, b64url_decode(body))
    return SecretPayload.from_json(unpad_plaintext(plaintext))


def _find(text: str, plain_pattern, encoded_pattern) -> tuple[str, ...]:
    if not isinstance(text, str):
        return ()
    seen: list[str] = []
    plain = [(m.start(), m.group(0)) for m in plain_pattern.finditer(text)]
    encoded = [(m.start(), unquote(m.group(0))) for m in encoded_pattern.finditer(text)]
    for _, tok in sorted(plain + encoded):
        if tok not in seen:
            seen.append(tok)
    return tuple(seen)


def find_tokens(text: str) -> tuple[str, ...]:
    """All distinct tokens in `text`, in first-seen order."""
    return _find(text, TOKEN_PATTERN, ENCODED_TOKEN_PATTERN)


def find_refs(text: str) -> tuple[str, ...]:
    """All distinct enc:ref: references in `text` (plain or URL-encoded), in first-seen order."""
    return _find(text, REF_PATTERN, ENCODED_REF_PATTERN)


def find_secrets(text: str) -> tuple[str, ...]:
    """Tokens, then references: everything the resolver has to turn into a value."""
    return find_tokens(text) + find_refs(text)


def encoded_forms(token: str) -> tuple[str, ...]:
    """The URL-encoded spellings of `token` that may appear in a form body or query string."""
    upper = quote(token, safe="")
    return tuple(dict.fromkeys((upper, upper.replace("%3A", "%3a").replace("%3D", "%3d"))))


def replace_token(text: str, token: str, value: str) -> str:
    """Replace plain and URL-encoded occurrences of `token`, keeping each occurrence's encoding."""
    out = text.replace(token, value)
    encoded_value = quote(value, safe="")
    for form in encoded_forms(token):
        out = out.replace(form, encoded_value)
    return out
