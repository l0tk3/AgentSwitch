"""RFC 6238 TOTP. Kept dependency-free so the gate never prints the shared secret."""

from __future__ import annotations

import base64
import hmac
import struct
import time

from .constants import TOTP_DIGITS, TOTP_STEP_SECONDS
from .errors import ValidationError


def _decode_secret(secret_b32: str) -> bytes:
    cleaned = secret_b32.upper().replace(" ", "")
    cleaned += "=" * (-len(cleaned) % 8)
    try:
        return base64.b32decode(cleaned, casefold=True)
    except (ValueError, TypeError) as exc:
        raise ValidationError("totp secret must be base32") from exc


def totp(
    secret_b32: str,
    at: float | None = None,
    step: int = TOTP_STEP_SECONDS,
    digits: int = TOTP_DIGITS,
) -> str:
    """Current (or `at`-time) code as a zero-padded string."""
    if step <= 0 or digits <= 0:
        raise ValidationError("step and digits must be positive")
    counter = int((time.time() if at is None else at) // step)
    msg = struct.pack(">Q", counter)
    digest = hmac.new(_decode_secret(secret_b32), msg, "sha1").digest()
    offset = digest[-1] & 0x0F
    code = struct.unpack(">I", digest[offset:offset + 4])[0] & 0x7FFFFFFF
    return str(code % (10 ** digits)).zfill(digits)
