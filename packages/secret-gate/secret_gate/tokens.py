"""Token wire format: `enc:v1:<base64url(sealed_box(payload_json))>`; short references `enc:ref:<id>` (refs.py)."""

from __future__ import annotations

from urllib.parse import quote, unquote

from .constants import ENCODED_REF_PATTERN, ENCODED_TOKEN_PATTERN, REF_PATTERN, TOKEN_PATTERN, TOKEN_PREFIX
from .crypto import b64url_decode, b64url_encode, decrypt, encrypt
from .errors import TokenError
from .policy import SecretPayload


def make_token(public_key: bytes, payload: SecretPayload) -> str:
    sealed = encrypt(public_key, payload.to_json().encode("utf-8"))
    return TOKEN_PREFIX + b64url_encode(sealed)


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
    return SecretPayload.from_json(plaintext)


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
