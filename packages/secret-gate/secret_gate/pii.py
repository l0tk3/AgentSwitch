"""Pattern detection of common personal data in tool output (gate-next-v0 §5).

Used for two things only: choosing what to mask in a screenshot, and which values an explicit
transfer grant seals (transfer.py). A match never grants anything by itself: it only marks a value
as something to protect. Patterns err on the side of matching too much; the cost of a false match is
a masked region or a sealed value the model sees as a reference instead of text.
"""

from __future__ import annotations

import re
from collections.abc import Iterable
from dataclasses import dataclass

EMAIL = "email"
PHONE = "phone"
ID_NUMBER = "id_number"
BANK_CARD = "bank_card"
KINDS = (EMAIL, PHONE, ID_NUMBER, BANK_CARD)

_PATTERNS: dict[str, re.Pattern[str]] = {
    EMAIL: re.compile(r"(?<![\w.%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}(?![\w-])"),
    # Mainland mobile numbers, and grouped numbers such as +1 202-555-0147 or (010) 6552-9988.
    PHONE: re.compile(
        r"(?<![\w+])(?:\+?86[- ]?)?1[3-9]\d{9}(?!\d)"
        r"|(?<![\w+])(?:\+\d{1,3}[-. ]?)?\(?\d{2,4}\)?[-. ]\d{3,4}[-. ]\d{4}(?![\d-])"
    ),
    ID_NUMBER: re.compile(r"(?<![\w])\d{17}[\dXx](?![\w])"),
    BANK_CARD: re.compile(r"(?<![\w-])\d{4}(?:[ -]?\d{4}){2,3}(?:[ -]?\d{1,3})?(?![\w-])"),
}
_ID_WEIGHTS = (7, 9, 10, 5, 8, 4, 2, 1, 6, 3, 7, 9, 10, 5, 8, 4, 2)
_ID_CHECK = "10X98765432"


@dataclass(frozen=True)
class Match:
    kind: str
    value: str


def _id_checksum_ok(value: str) -> bool:
    body, check = value[:17], value[17].upper()
    return _ID_CHECK[sum(int(d) * w for d, w in zip(body, _ID_WEIGHTS)) % 11] == check


def _luhn_ok(value: str) -> bool:
    digits = [int(c) for c in value if c.isdigit()]
    if not 13 <= len(digits) <= 19:
        return False
    total = 0
    for i, d in enumerate(reversed(digits)):
        if i % 2:
            d = d * 2 - 9 if d * 2 > 9 else d * 2
        total += d
    return total % 10 == 0


_VALIDATORS = {ID_NUMBER: _id_checksum_ok, BANK_CARD: _luhn_ok}


def check_kinds(kinds: Iterable[str]) -> tuple[str, ...]:
    out = tuple(dict.fromkeys(kinds))
    unknown = [k for k in out if k not in KINDS]
    if unknown:
        raise ValueError(f"unknown personal data kinds {unknown}; known: {list(KINDS)}")
    return out


def find_pii(text: str, kinds: Iterable[str] = KINDS) -> tuple[Match, ...]:
    """Distinct matches in first-seen order. An ID number is never also reported as a card or phone."""
    if not text:
        return ()
    found: list[tuple[int, int, Match]] = []
    for kind in check_kinds(kinds):
        valid = _VALIDATORS.get(kind, lambda _v: True)
        for m in _PATTERNS[kind].finditer(text):
            if valid(m.group(0)):
                found.append((m.start(), m.end(), Match(kind, m.group(0))))
    found.sort(key=lambda item: (item[0], -(item[1] - item[0])))
    out: list[Match] = []
    last_end = -1
    for start, end, match in found:
        if start < last_end:
            continue  # overlaps a longer or earlier match
        last_end = end
        if match not in out:
            out.append(match)
    return tuple(out)
