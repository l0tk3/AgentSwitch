"""Replace resolved plaintext values in outbound-to-model text with [REDACTED:label]."""

from __future__ import annotations

from typing import Iterable
from urllib.parse import quote

from .constants import MIN_REDACT_LENGTH, REDACTED_FORMAT
from .resolver import Resolution


def redact(text: str | None, resolutions: Iterable[Resolution]) -> str | None:
    """Longest values first so a short value that is a substring of a longer one cannot leak."""
    if text is None:
        return None
    pairs = {(r.value, r.label) for r in resolutions if len(r.value) >= MIN_REDACT_LENGTH}
    # A site may echo the value back URL-encoded (form fields, query strings): catch that form too.
    pairs |= {(quote(value, safe=""), label) for value, label in pairs if quote(value, safe="") != value}
    ordered = sorted(pairs, key=lambda pair: len(pair[0]), reverse=True)
    out = text
    for value, label in ordered:
        out = out.replace(value, REDACTED_FORMAT.format(label=label))
    return out


def contains_any(text: str | None, resolutions: Iterable[Resolution]) -> bool:
    if not text:
        return False
    return any(r.value and (r.value in text or quote(r.value, safe="") in text) for r in resolutions)
