"""Replace resolved plaintext values in outbound-to-model text with [REDACTED:label] (gate-simple-v0 §3.1).

One rule for every path that returns text to the model (proxy responses, the browser gate's results, `secret_http`,
`secret_exec`, `logs.tail`, error text). For every value used in the call or session:

1. **The whole value in every encoding** a channel may give it back in: raw, URL-encoded (`%20` and `+` styles, every
   byte escaped, twice escaped), browser form encoding, `encodeURIComponent`, JSON (with or without `\\uXXXX`, `\\/`),
   JS string escapes (`\\'`, `\\xNN`, `\\uNNNN`), HTML (named and numeric entities), hexadecimal, and base64 (standard
   or URL-safe, padded or not, at any offset of a longer payload, `Basic base64(user:pass)` too).
2. **Case-insensitively**: a value echoed upper- or lower-cased is still found (hex in either case with it).
3. **Fragments**: every run of `FRAGMENT_CHARS` (4) or more characters of the raw value, in any case, is replaced, so
   the output never keeps more than 3 consecutive characters of a value and the pieces of a split or truncated echo
   cannot be put back together. Fragments are matched on the raw form only: an encoded form is matched whole (its
   characters that encoding leaves alone are raw characters and are caught as fragments anyway). Harmless text that
   shares 4 characters with a value is over-redacted; that is accepted.

Overlapping and touching hits merge into one `[REDACTED:label]`. A marker this redactor itself writes is never
redacted again (so a label that shares 4 characters with its value does not swallow every later marker). Base64 runs,
URL-encoded and JSON-escaped spans are matched whole; MIME line-wrapped base64 and other transformations a program
applies on purpose (reversing, spacing out the characters) are not, which is the "deliberate theft" gate-simple-v0
§0 leaves out of scope.

Callers that cannot redact (a body too large to hold, an encoding they cannot decode, an exception here) withhold
the whole output instead (§3.2); see `withheld`.
"""

from __future__ import annotations

import base64
import html
import json
import re
from collections.abc import Iterable
from urllib.parse import quote, quote_plus

from .constants import MIN_REDACT_LENGTH, REDACTED_FORMAT
from .resolver import Resolution

FRAGMENT_CHARS = 4  # the output keeps at most FRAGMENT_CHARS - 1 consecutive characters of a value


def encodings(value: str) -> frozenset[str]:
    """Every textual form a value may take on its way back to the model (raw form included), as written; matching
    is case-insensitive, so upper-case hex or `%7e` need no form of their own."""
    json_escaped = json.dumps(value, ensure_ascii=False)[1:-1]
    raw = value.encode("utf-8")
    forms = {
        value,
        quote(value, safe=""),
        quote_plus(value),
        quote(value, safe="*-._"),
        quote(value, safe="!'()*~"),  # JS encodeURIComponent
        quote_plus(value, safe="*").replace("~", "%7E"),  # WHATWG application/x-www-form-urlencoded (browsers)
        quote(quote(value, safe=""), safe=""),  # escaped twice (a URL inside a query string)
        "".join(f"%{b:02X}" for b in raw),  # every byte escaped
        json_escaped,
        json.dumps(value)[1:-1],  # non-ASCII as \uXXXX
        json_escaped.replace("/", "\\/"),
        json_escaped.replace("\\\"", "\"").replace("'", "\\'"),  # JS single-quoted (Playwright echo)
        "".join(f"\\u{ord(c):04x}" if ord(c) <= 0xFFFF else c for c in value),  # every character \uXXXX
        "".join(f"\\x{b:02x}" for b in raw),  # every byte \xNN
        html.escape(value, quote=True),
        html.escape(value, quote=False),
        html.escape(value, quote=True).replace("&#x27;", "&#39;"),
        "".join(f"&#{ord(c)};" for c in value),  # numeric character references
        "".join(f"&#x{ord(c):x};" for c in value),
        raw.hex(),  # hexadecimal (upper case matches case-insensitively)
    }
    return frozenset(f for f in forms if f)


def fold(text: str) -> str:
    """Lower case, keeping every index: a character whose lower case is longer (`İ`) stays as it is."""
    low = text.lower()
    if len(low) == len(text):
        return low
    return "".join(c.lower() if len(c.lower()) == 1 else c for c in text)


_BASE64_CHARS = "A-Za-z0-9+/_-"


class Redactor:
    """The values of one call or session, prepared once; call it on every text that goes back to the model."""

    def __init__(self, resolutions: Iterable[Resolution]) -> None:
        labels: dict[str, str] = {}
        for r in resolutions:
            if r.value and len(r.value) >= MIN_REDACT_LENGTH:
                labels.setdefault(r.value, r.label)
        self._labels = labels
        self._markers = frozenset(REDACTED_FORMAT.format(label=label) for label in labels.values())
        forms: dict[str, str] = {}
        grams: dict[str, str] = {}
        for value, label in labels.items():
            for form in encodings(value):
                forms.setdefault(fold(form), label)
            folded = fold(value)
            for i in range(len(folded) - FRAGMENT_CHARS + 1):
                grams.setdefault(folded[i:i + FRAGMENT_CHARS], label)
        self._forms = forms
        self._grams = grams
        self._b64 = [(value.encode("utf-8"), label) for value, label in labels.items()]
        if self._b64:
            shortest = min(len(v) for v, _ in self._b64)
            # A run shorter than the base64 of the shortest value cannot hold it at any offset.
            self._b64_run = re.compile(f"[{_BASE64_CHARS}]{{{max(2, (shortest * 4) // 3)},}}={{0,2}}")

    def __bool__(self) -> bool:
        return bool(self._labels)

    def spans(self, text: str) -> list[tuple[int, int, str]]:
        """Merged (start, end, label) of everything to replace, in order."""
        if not self._labels or not text:
            return []
        folded = fold(text)
        hits: list[tuple[int, int, str]] = []
        for needle, label in (*self._forms.items(), *self._grams.items()):
            at = folded.find(needle)
            while at != -1:
                hits.append((at, at + len(needle), label))
                at = folded.find(needle, at + 1)
        hits.extend(self._base64_hits(text))
        if not hits:
            return []
        markers = self._marker_spans(text)
        hits.sort(key=lambda h: (h[0], -h[1]))  # at one start, the widest hit names the span
        merged: list[list] = []
        for start, end, label in hits:
            if any(m_start <= start and end <= m_end for m_start, m_end in markers):
                continue  # inside a marker this redactor wrote: the label is not the value
            if merged and start <= merged[-1][1]:
                merged[-1][1] = max(merged[-1][1], end)
            else:
                merged.append([start, end, label])
        return [(s, e, label) for s, e, label in merged]

    def __call__(self, text: str | None) -> str | None:
        if text is None:
            return None
        spans = self.spans(text)
        if not spans:
            return text
        out: list[str] = []
        last = 0
        for start, end, label in spans:
            out.append(text[last:start])
            out.append(REDACTED_FORMAT.format(label=label))
            last = end
        out.append(text[last:])
        return "".join(out)

    def finds(self, text: str | None) -> bool:
        return bool(text) and bool(self.spans(text))

    def _marker_spans(self, text: str) -> list[tuple[int, int]]:
        found = []
        for marker in self._markers:
            at = text.find(marker)
            while at != -1:
                found.append((at, at + len(marker)))
                at = text.find(marker, at + 1)
        return found

    def _base64_hits(self, text: str) -> list[tuple[int, int, str]]:
        if not self._b64:
            return []
        hits = []
        for match in self._b64_run.finditer(text):
            decoded = _decodings(match.group(0))
            for value, label in self._b64:
                if any(value in d for d in decoded):
                    hits.append((match.start(), match.end(), label))
                    break
        return hits


def redact(text: str | None, resolutions: Iterable[Resolution]) -> str | None:
    """Every form and every 4-character fragment of every value becomes [REDACTED:label] (module docstring)."""
    if text is None:
        return None
    return Redactor(resolutions)(text)


_BASE64_RUN = re.compile(f"[{_BASE64_CHARS}]{{6,}}={{0,2}}")


def redact_base64(text: str | None, resolutions: Iterable[Resolution]) -> str | None:
    """Replace base64 (standard or URL-safe, padded or not) whose decoded bytes hold a value: `btoa(password)` in a
    request body, `Authorization: Basic base64(user:pass)` a page set itself (security review 2026-11-23, L1).

    `redact` does this too; this is for values that are matched whole only (sealed page data, whose other forms
    become their references). Every run of base64 characters is decoded at each of the four offsets, so a value
    encoded inside a longer payload (`{"p":"..."}`, `user:pass`) or after a `/` that belongs to a path is found too;
    the whole run is replaced."""
    if not text:
        return text
    values = [(r.value.encode("utf-8"), r.label) for r in resolutions if len(r.value) >= MIN_REDACT_LENGTH]
    if not values:
        return text

    def replace(match: re.Match[str]) -> str:
        run = match.group(0)
        decoded = _decodings(run)
        for value, label in values:
            if any(value in d for d in decoded):
                return REDACTED_FORMAT.format(label=label)
        return run

    return _BASE64_RUN.sub(replace, text)


def _decodings(run: str) -> list[bytes]:
    alphabet = run.rstrip("=").replace("-", "+").replace("_", "/")
    out = []
    for offset in range(4):
        part = alphabet[offset:]
        if len(part) % 4 == 1:  # a lone trailing character carries no whole byte
            part = part[:-1]
        if part:
            out.append(base64.b64decode(part + "=" * (-len(part) % 4)))  # base64 characters, padded: cannot fail
    return out


def contains_any(text: str | None, resolutions: Iterable[Resolution]) -> bool:
    """Whether `redact` would change anything (a whole form, a fragment or base64 of a value)."""
    return Redactor(resolutions).finds(text)


def withheld(what: str, reason: str) -> str:
    """What the model sees instead of output that could not be redacted (gate-simple-v0 §3.2)."""
    return f"[secret-gate withheld this {what}: {reason}]"
