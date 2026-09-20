"""Fabricated sensitive data for tests. NONE of these are real credentials.

Card / ID numbers are standard test values; hosts are RFC 2606 reserved names.
"""

from __future__ import annotations

from dataclasses import dataclass


@dataclass(frozen=True)
class FakeAccount:
    label: str
    username: str
    password: str
    hosts: tuple[str, ...]


PORTAL = FakeAccount(
    label="portal-a/pass",
    username="zhangsan.test",
    password="Hunter2-Fake-Pa55!",
    hosts=("portal-a.example.com", "login.portal-a.example.com"),
)

BANK = FakeAccount(
    label="bank-b/pass",
    username="lisi_demo",
    password="B4nk-N0t-Re4l-9x",
    hosts=("*.bank-b.example.net",),
)

API_BEARER = FakeAccount(
    label="api-c/token",
    username="",
    password="sk-fake-1234567890abcdefFAKEFAKEFAKE",
    hosts=("api.c.example.org",),
)

DB = FakeAccount(
    label="db-d/pass",
    username="app_ro",
    password="Db#Fake-Pw-2026",
    hosts=(),
)

# RFC 6238 reference secret; codes are publicly known test vectors.
TOTP_SECRET_B32 = "GEZDGNBVGY3TQOJQGEZDGNBVGY3TQOJQ"
TOTP_LABEL = "portal-a/totp"

# PII the redactor must never let back to the model.
FAKE_PHONE = "13800000000"
FAKE_ID_NUMBER = "110101199001011234"
FAKE_CARD = "4111111111111111"

EVIL_HOST = "evil.attacker.example"
