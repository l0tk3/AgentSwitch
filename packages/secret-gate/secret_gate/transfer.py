"""Authorized field transfer (gate-next-v0 §5.2): page data sealed into task-scoped references.

The dispatcher derives a grant from the user's own task (which fields, from which system, to which
system, for what) and hands it to this execution's browser gate as SECRET_GATE_TRANSFER. On a
source page, values of the granted kinds in tool output are encrypted on the spot into enc:v1:
tokens allowed only on the destination hosts and only for a browser fill (use `fill`), registered as references in the
execution scope, and the model sees only the references. `secret_fill` then places them on the
destination, where the ordinary host policy of the ciphertext applies.

A grant never widens anything: without a grant nothing is sealed and output is unchanged; a
reference minted here cannot be used outside the destination hosts, and nothing here reads the page
beyond the output the model had asked for anyway.
"""

from __future__ import annotations

import json
from collections.abc import Callable
from dataclasses import dataclass

from .constants import USE_FILL
from .errors import ValidationError
from .pii import EMAIL, KINDS, PHONE, check_kinds, find_pii
from .policy import SecretPayload, host_matches, normalize_host
from .redact import encodings
from .resolver import Resolution

TRANSFER_ENV_VAR = "SECRET_GATE_TRANSFER"
MAX_HOSTS = 8
MAX_PURPOSE_CHARS = 200
LABEL_PREFIX = "page"
_KEYS = frozenset({"source", "destination", "fields", "purpose"})


def _exact_hosts(raw: object, name: str) -> tuple[str, ...]:
    if not isinstance(raw, list) or not 1 <= len(raw) <= MAX_HOSTS or not all(isinstance(h, str) for h in raw):
        raise ValidationError(f"transfer grant: {name} must list 1-{MAX_HOSTS} hosts")
    hosts = tuple(dict.fromkeys(normalize_host(h) for h in raw))
    if any("*" in h for h in hosts):
        raise ValidationError(f"transfer grant: {name} hosts must be exact, not wildcards")
    return hosts


@dataclass(frozen=True)
class TransferGrant:
    source: tuple[str, ...]
    destination: tuple[str, ...]
    fields: tuple[str, ...]
    purpose: str

    @classmethod
    def parse(cls, raw: str) -> TransferGrant:
        try:
            data = json.loads(raw)
        except (ValueError, TypeError):
            raise ValidationError("transfer grant must be a JSON object") from None
        if not isinstance(data, dict) or set(data) != _KEYS:
            raise ValidationError(f"transfer grant needs exactly {sorted(_KEYS)}")
        fields = data["fields"]
        if not isinstance(fields, list) or not fields or not all(isinstance(f, str) for f in fields):
            raise ValidationError("transfer grant: fields must be a non-empty list")
        try:
            kinds = check_kinds(fields)
        except ValueError as exc:
            raise ValidationError(f"transfer grant: {exc}") from None
        purpose = data["purpose"]
        if not isinstance(purpose, str) or not purpose.strip() or len(purpose) > MAX_PURPOSE_CHARS:
            raise ValidationError(f"transfer grant: purpose must be 1-{MAX_PURPOSE_CHARS} characters")
        return cls(source=_exact_hosts(data["source"], "source"), destination=_exact_hosts(data["destination"], "destination"),
                   fields=kinds, purpose=purpose.strip())

    def is_source(self, page_host: str) -> bool:
        """`page_host` is 'host:port' (browser_policy.page_host)."""
        return any(host_matches(pattern, page_host) for pattern in self.source)

    def allows_destination(self, host_port: str) -> bool:
        return any(host_matches(pattern, host_port) for pattern in self.destination)

    def describe(self) -> str:
        return (f"fields {', '.join(self.fields)} from {', '.join(self.source)} to {', '.join(self.destination)}; "
                f"purpose: {self.purpose}")


Mint = Callable[[SecretPayload], str]  # payload -> enc:ref: reference in this execution's scope


def seal_matches(text: str, grant: TransferGrant, known: tuple[Resolution, ...], mint: Mint) -> tuple[Resolution, ...]:
    """New sealed values for the granted kinds found in `text`, each already registered via `mint`.

    `known` are values sealed earlier (same value -> same reference). Labels count per kind:
    page/email-1, page/email-2, ...
    """
    seen = {r.value for r in known}
    counts: dict[str, int] = {}
    for r in known:
        kind = kind_of(r.label).replace("_", "-")
        counts[kind] = counts.get(kind, 0) + 1
    fresh: list[Resolution] = []
    for match in find_pii(text, grant.fields):
        if match.value in seen:
            continue
        seen.add(match.value)
        kind = match.kind.replace("_", "-")
        counts[kind] = counts.get(kind, 0) + 1
        label = f"{LABEL_PREFIX}/{kind}-{counts[kind]}"
        # `fill` only: placed by the browser gate, which also checks the form's destination; never via proxy or secret_http.
        payload = SecretPayload.create(value=match.value, hosts=grant.destination, uses={USE_FILL}, label=label)
        fresh.append(Resolution(token=mint(payload), label=label, value=match.value))
    return tuple(fresh)


def kind_of(label: str) -> str:
    """page/id-number-2 -> id_number."""
    return label.removeprefix(f"{LABEL_PREFIX}/").rsplit("-", 1)[0].replace("-", "_")


def _normalized(kind: str, value: str) -> str:
    if kind == EMAIL:
        return value.strip().casefold()
    return "".join(c for c in value.upper() if c.isdigit() or c == "X")


def _same(kind: str, shown: str, sealed: str) -> bool:
    if kind == PHONE:  # "+86 138-0013-8000" is the sealed "13800138000"
        short, long_ = sorted((shown, sealed), key=len)
        return len(short) >= 7 and long_.endswith(short)
    return shown == sealed


def show_sealed(text: str, sealed: tuple[Resolution, ...]) -> str:
    """Every form of a sealed value becomes its reference (longest forms first, like redact), including the
    same value shown in another format (a confirmation page re-formatting a phone number or an e-mail's case)."""
    pairs = sorted(((form, r.token) for r in sealed for form in encodings(r.value)), key=lambda p: len(p[0]), reverse=True)
    out = text
    for form, ref in pairs:
        out = out.replace(form, ref)
    if not sealed:
        return out
    known = [(kind_of(r.label), _normalized(kind_of(r.label), r.value), r.token) for r in sealed]
    kinds = {k for k, _, _ in known if k in KINDS}
    for match in find_pii(out, kinds):
        shown = _normalized(match.kind, match.value)
        ref = next((token for kind, value, token in known if kind == match.kind and _same(kind, shown, value)), None)
        if ref is not None:
            out = out.replace(match.value, ref)
    return out


def legend(sealed: tuple[Resolution, ...], grant: TransferGrant) -> str:
    lines = [f"- {r.token} = {r.label}" for r in sealed]
    return ("### secret-gate sealed page data\n" + "\n".join(lines) +
            f"\nThese references stand for page values sealed under the task's transfer grant ({grant.describe()}). "
            f"Place them with secret_fill(target, reference) on {', '.join(grant.destination)} only; the gate refuses any other host.")
