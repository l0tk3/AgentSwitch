"""Replace resolved plaintext values in outbound-to-model text with [REDACTED:label].

A value comes back in whatever encoding the channel used: raw, URL-encoded (query strings, form
bodies, both `%20` and `+` styles), JSON-escaped (API bodies, Playwright's "Ran code" echo),
JS single-quoted, or HTML-entity-escaped (server pages). Every form is matched.
"""

from __future__ import annotations

import html
import json
from collections.abc import Iterable
from urllib.parse import quote, quote_plus

from .constants import MIN_REDACT_LENGTH, REDACTED_FORMAT
from .resolver import Resolution


def encodings(value: str) -> frozenset[str]:
    """Every textual form a value may take on its way back to the model (raw form included)."""
    json_escaped = json.dumps(value, ensure_ascii=False)[1:-1]
    forms = {
        value,
        quote(value, safe=""),
        quote_plus(value),
        quote(value, safe="*-._"),
        quote(value, safe="!'()*~"),  # JS encodeURIComponent
        quote_plus(value, safe="*").replace("~", "%7E"),  # WHATWG application/x-www-form-urlencoded (browsers)
        json_escaped,
        json.dumps(value)[1:-1],  # non-ASCII as \uXXXX
        json_escaped.replace("/", "\\/"),
        json_escaped.replace("\\\"", "\"").replace("'", "\\'"),  # JS single-quoted (Playwright echo)
        html.escape(value, quote=True),
        html.escape(value, quote=False),
        html.escape(value, quote=True).replace("&#x27;", "&#39;"),
    }
    return frozenset(f for f in forms if f)


def redact(text: str | None, resolutions: Iterable[Resolution]) -> str | None:
    """Longest forms first so a short value that is a substring of a longer one cannot leak."""
    if text is None:
        return None
    pairs = {
        (form, r.label)
        for r in resolutions
        if len(r.value) >= MIN_REDACT_LENGTH
        for form in encodings(r.value)
    }
    ordered = sorted(pairs, key=lambda pair: len(pair[0]), reverse=True)
    out = text
    for form, label in ordered:
        out = out.replace(form, REDACTED_FORMAT.format(label=label))
    return out


def contains_any(text: str | None, resolutions: Iterable[Resolution]) -> bool:
    if not text:
        return False
    return any(r.value and any(form in text for form in encodings(r.value)) for r in resolutions)
