"""Narrow TOTP-seed import repair: trusted local CLI, or an authenticated daemon bridge.

Only the CLI operation decrypts and re-signs. The MCP operation only forwards ciphertext;
it cannot authorize a repair itself and never calls the local reissuer directly.
"""

from __future__ import annotations

import asyncio
import os
import re
from collections.abc import Mapping
from typing import Any

import httpx

from .constants import KIND_SECRET, KIND_TOTP, LABEL_PATTERN, USE_HTTP
from .errors import GateError, PolicyViolation, ValidationError
from .policy import SecretPayload, normalize_host
from .resolver import Resolver
from .tokens import is_token, make_token

REPAIR_PURPOSE = "totp_seed_import"
REPAIR_TIMEOUT_SECONDS = 65
REPAIR_TOOL = "secret_repair"
REPAIR_DESCRIPTION = (
    "Ask the task dispatcher to repair an existing TOTP token for explicitly authorized seed import "
    "into the same allowed host. Returns a new secret/http ciphertext only after authorization. "
    "Does not add hosts, generate a code, fill a field, or bypass a provider refusal. "
    "Use only for importing the seed itself; use secret_otp for a current verification code."
)
REPAIR_SCHEMA = {
    "type": "object", "additionalProperties": False,
    "properties": {
        "token": {"type": "string"},
        "host": {"type": "string", "description": "Existing allowed destination host, with :port when applicable; no URL or wildcard."},
        "purpose": {"type": "string", "enum": [REPAIR_PURPOSE], "default": REPAIR_PURPOSE},
    },
    "required": ["token", "host"],
}
_MAX_TOKEN_CHARS = 131072
_BRIDGE_URL = re.compile(r"http://127\.0\.0\.1:([0-9]{1,5})/credential-repair\Z")


def checked_token(token: Any) -> str:
    if not isinstance(token, str) or len(token) > _MAX_TOKEN_CHARS or not is_token(token):
        raise ValidationError("a complete ciphertext token is required")
    return token.strip()


def repair_request(token: Any, host: Any, purpose: Any = REPAIR_PURPOSE) -> dict[str, str]:
    if purpose != REPAIR_PURPOSE:
        raise ValidationError("only totp_seed_import repair is supported")
    if not isinstance(host, str) or len(host) > 260:
        raise ValidationError("repair requires a concrete destination host")
    try:
        target = normalize_host(host)
    except GateError:
        raise ValidationError("repair requires a concrete host[:port], not a URL") from None
    if "*" in target:
        raise ValidationError("repair requires a concrete host, not a wildcard")
    return {"token": checked_token(token), "host": target, "purpose": REPAIR_PURPOSE}


def credential_info(resolver: Resolver, token: Any) -> dict:
    """Trusted CLI: return only policy metadata, including for a token signed with an older key."""
    return _open_for_repair(resolver, checked_token(token)).describe()


def _open_for_repair(resolver: Resolver, token: str) -> SecretPayload:
    try:
        return resolver._open(token)  # plaintext remains inside the gate boundary
    except GateError:
        # Malformed encrypted metadata must not escape in parser exception text.
        raise ValidationError("credential token cannot be opened or has invalid policy") from None


def reissue_totp_seed(resolver: Resolver, public_key: bytes, token: Any, host: Any, purpose: Any) -> dict:
    """Trusted daemon only: turn a TOTP payload into a secret/http token for one existing host."""
    request = repair_request(token, host, purpose)
    original = _open_for_repair(resolver, request["token"])
    if original.kind != KIND_TOTP:
        raise PolicyViolation("credential repair requires an existing TOTP token")
    if not original.allows_host(request["host"]):
        raise PolicyViolation("credential repair cannot add or broaden the allowed destination")
    if request["host"] not in original.seed_import_hosts:
        raise PolicyViolation("原密文未授权种子导入，请通过新消息重新提交此字段和目标")
    payload = SecretPayload.create(value=original.value, hosts=[request["host"]], uses=[USE_HTTP],
                                   label=original.label, kind=KIND_SECRET)
    return {"token": make_token(public_key, payload), "label": payload.label, "kind": payload.kind,
            "hosts": list(payload.hosts), "uses": sorted(payload.uses)}


def bridge_config(env: Mapping[str, str]) -> tuple[str, str]:
    url, key = env.get("SECRET_GATE_REPAIR_URL", ""), env.get("SECRET_GATE_REPAIR_KEY", "")
    if not url or not key:
        raise PolicyViolation("credential repair is unavailable outside an active dispatcher task")
    match = _BRIDGE_URL.fullmatch(url)
    if not match or not 1 <= int(match.group(1)) <= 65535:
        raise ValidationError("credential repair bridge must use http://127.0.0.1:<port>/credential-repair")
    if not re.fullmatch(r"[A-Za-z0-9_-]{16,256}", key):
        raise ValidationError("invalid credential repair bridge authorization")
    return url, key


def _bridge_result(data: Any, host: str) -> dict:
    # A buggy service must not return plaintext, arbitrary text, or broaden the requested capability.
    if not isinstance(data, dict) or data.get("ok") is not True:
        raise PolicyViolation("credential repair was not authorized by the dispatcher; check the task repair event")
    required = {"ok", "token", "label", "kind", "hosts", "uses"}
    if not required <= set(data) or set(data) - required - {"seed_import_hosts"}:
        raise ValidationError("invalid credential repair response")
    if (data.get("kind") != KIND_SECRET or data.get("hosts") != [host] or data.get("uses") != [USE_HTTP]
            or data.get("seed_import_hosts", []) != []
            or not isinstance(data.get("label"), str) or not LABEL_PATTERN.fullmatch(data["label"])):
        raise ValidationError("invalid credential repair response policy")
    return {"token": checked_token(data["token"]), "label": data["label"], "kind": KIND_SECRET,
            "hosts": [host], "uses": [USE_HTTP]}


async def request_repair(token: str, host: str, purpose: str = REPAIR_PURPOSE, *,
                         env: Mapping[str, str] | None = None, transport: httpx.AsyncBaseTransport | None = None) -> dict:
    """MCP: ciphertext-only call to the current task's exact loopback bridge; never follows redirects/proxies."""
    request = repair_request(token, host, purpose)
    url, key = bridge_config(os.environ if env is None else env)
    try:
        async with httpx.AsyncClient(timeout=REPAIR_TIMEOUT_SECONDS, follow_redirects=False,
                                     trust_env=False, transport=transport) as client:
            response = await asyncio.wait_for(
                client.post(url, json=request, headers={"Authorization": f"Bearer {key}"}),
                timeout=REPAIR_TIMEOUT_SECONDS,
            )
    except (httpx.HTTPError, TimeoutError):
        raise GateError("credential repair bridge is unavailable or timed out") from None
    if response.status_code != 200:
        raise GateError(f"credential repair bridge returned HTTP {response.status_code}")
    try:
        data = response.json()
    except (ValueError, UnicodeDecodeError):
        raise ValidationError("invalid credential repair response") from None
    return _bridge_result(data, request["host"])
