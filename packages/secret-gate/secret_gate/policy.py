"""Secret payload model: the plaintext value plus the policy bound to it.

The policy travels inside the ciphertext, so a token can only ever be used
for the hosts and actions its creator allowed.
"""

from __future__ import annotations

import base64
import binascii
import json
from dataclasses import dataclass

from .constants import (
    HOST_PATTERN,
    KIND_SECRET,
    KIND_TOTP,
    LABEL_PATTERN,
    VALID_KINDS,
    VALID_USES,
)
from .errors import ValidationError


def split_host_port(text: str) -> tuple[str, int | None]:
    """'host' -> ('host', None); 'host:8001' -> ('host', 8001). Raises on a malformed port."""
    name, sep, port_text = text.rpartition(":")
    if not sep:
        return text, None
    if not name or not port_text.isdigit() or not 1 <= int(port_text) <= 65535 or ":" in name:
        raise ValidationError(f"invalid host:port {text!r}")
    return name, int(port_text)


def normalize_host(host: str) -> str:
    """Lowercase, strip a trailing dot, keep an optional :port; reject anything else.

    'site.example.com' allows every port; 'site.example.com:8001' allows only that port.
    """
    if not isinstance(host, str):
        raise ValidationError("host must be a string")
    name, port = split_host_port(host.strip().lower())
    name = name.rstrip(".")
    if not HOST_PATTERN.match(name):
        raise ValidationError(f"invalid host pattern: {host!r}")
    return name if port is None else f"{name}:{port}"


def host_matches(pattern: str, host: str) -> bool:
    """Name: exact, or '*.example.com' for any subdomain (not the apex).
    Port: a pattern without a port matches any port; with a port it must equal the request's."""
    p_name, p_port = split_host_port(pattern)
    h_name, h_port = split_host_port(host)
    if p_port is not None and p_port != h_port:
        return False
    if p_name.startswith("*."):
        suffix = p_name[1:]  # ".example.com"
        return h_name.endswith(suffix) and len(h_name) > len(suffix)
    return p_name == h_name


def _validate_base32(value: str) -> None:
    padded = value.upper().replace(" ", "")
    padded += "=" * (-len(padded) % 8)
    try:
        base64.b32decode(padded, casefold=True)
    except (binascii.Error, ValueError) as exc:
        raise ValidationError("totp value must be base32") from exc


@dataclass(frozen=True)
class SecretPayload:
    """Immutable plaintext + policy. Construct via `create` or `from_json`."""

    value: str
    hosts: tuple[str, ...]
    uses: frozenset[str]
    label: str
    kind: str = KIND_SECRET

    @classmethod
    def create(
        cls,
        *,
        value: str,
        hosts: tuple[str, ...] | list[str],
        uses: frozenset[str] | set[str] | list[str],
        label: str,
        kind: str = KIND_SECRET,
    ) -> "SecretPayload":
        if not isinstance(value, str) or not value:
            raise ValidationError("value must be a non-empty string")
        if not isinstance(label, str) or not LABEL_PATTERN.match(label):
            raise ValidationError(f"invalid label: {label!r}")
        if kind not in VALID_KINDS:
            raise ValidationError(f"invalid kind: {kind!r}")
        use_set = frozenset(uses)
        if not use_set or not use_set <= VALID_USES:
            raise ValidationError(f"uses must be a non-empty subset of {sorted(VALID_USES)}")
        host_tuple = tuple(normalize_host(h) for h in hosts)
        if kind == KIND_TOTP:
            _validate_base32(value)
        return cls(value=value, hosts=host_tuple, uses=use_set, label=label, kind=kind)

    def to_json(self) -> str:
        return json.dumps(
            {
                "v": self.value,
                "host": list(self.hosts),
                "use": sorted(self.uses),
                "label": self.label,
                "kind": self.kind,
            },
            separators=(",", ":"),
        )

    @classmethod
    def from_json(cls, raw: str | bytes) -> "SecretPayload":
        try:
            data = json.loads(raw)
        except (json.JSONDecodeError, UnicodeDecodeError) as exc:
            raise ValidationError("payload is not valid JSON") from exc
        if not isinstance(data, dict):
            raise ValidationError("payload must be a JSON object")
        try:
            return cls.create(
                value=data["v"],
                hosts=data.get("host", []),
                uses=data["use"],
                label=data["label"],
                kind=data.get("kind", KIND_SECRET),
            )
        except KeyError as exc:
            raise ValidationError(f"payload missing field {exc.args[0]!r}") from exc
        except TypeError as exc:
            raise ValidationError("payload has wrong field types") from exc

    def allows_host(self, host: str) -> bool:
        target = host.strip().lower().rstrip(".")
        return any(host_matches(p, target) for p in self.hosts)

    def allows_use(self, use: str) -> bool:
        return use in self.uses

    def describe(self) -> dict:
        """Metadata only. Never includes the value."""
        return {
            "label": self.label,
            "kind": self.kind,
            "hosts": list(self.hosts),
            "uses": sorted(self.uses),
        }
