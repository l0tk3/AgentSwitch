"""Turn tokens into values, but only when the token's policy allows the host and use."""

from __future__ import annotations

import time
from dataclasses import dataclass
from typing import Callable

from .constants import KIND_TOTP, USE_HTTP, USE_OTP, VALID_USES
from .errors import PolicyViolation, TokenError, ValidationError
from .otp import totp
from .policy import SecretPayload
from .tokens import find_tokens, replace_token, open_token


@dataclass(frozen=True)
class Resolution:
    """One token resolved for one request. `value` must never be logged or returned to the model."""

    token: str
    label: str
    value: str


class Resolver:
    def __init__(
        self,
        private_key: bytes,
        clock: Callable[[], float] = time.time,
        extra_private_keys: tuple[bytes, ...] = (),
    ) -> None:
        self._keys: tuple[bytes, ...] = (private_key, *extra_private_keys)
        self._clock = clock

    def _open(self, token: str) -> SecretPayload:
        """Try every key the gate holds; the last failure is what the caller sees."""
        last: TokenError | None = None
        for key in self._keys:
            try:
                return open_token(key, token)
            except TokenError as exc:
                last = exc
        assert last is not None
        raise last

    @classmethod
    def from_home(cls, home, clock: Callable[[], float] = time.time) -> "Resolver":
        from .keystore import load_all_private_keys

        keys = load_all_private_keys(home)
        if not keys:
            from .errors import KeyStoreError

            raise KeyStoreError(f"no keypair in {home}; run `secret-gate keygen`")
        return cls(keys[0], clock=clock, extra_private_keys=keys[1:])

    def describe(self, token: str) -> dict:
        """Policy metadata for a token. Safe to show to the model."""
        return self._open(token).describe()

    def resolve(self, token: str, *, use: str, host: str | None = None) -> Resolution:
        if use not in VALID_USES:
            raise ValidationError(f"unknown use {use!r}")
        payload = self._open(token)
        self._check_policy(payload, use=use, host=host)
        value = self._materialize(payload, use=use)
        return Resolution(token=token, label=payload.label, value=value)

    def substitute(
        self, text: str, *, use: str, host: str | None = None
    ) -> tuple[str, tuple[Resolution, ...]]:
        """Replace every token in `text`. Returns (new_text, resolutions); `text` is untouched."""
        tokens = find_tokens(text)
        if not tokens:
            return text, ()
        resolutions = tuple(self.resolve(t, use=use, host=host) for t in tokens)
        out = text
        for res in resolutions:
            out = replace_token(out, res.token, res.value)
        return out, resolutions

    @staticmethod
    def _check_policy(payload: SecretPayload, *, use: str, host: str | None) -> None:
        if not payload.allows_use(use):
            raise PolicyViolation(
                f"token {payload.label!r} does not allow use {use!r} (allowed: {sorted(payload.uses)})"
            )
        if use == USE_HTTP:
            if not host:
                raise PolicyViolation("http use requires a target host")
            if not payload.allows_host(host):
                raise PolicyViolation(
                    f"token {payload.label!r} is not allowed on host {host!r} (allowed: {list(payload.hosts)})"
                )
        if use == USE_OTP and payload.kind != KIND_TOTP:
            raise PolicyViolation(f"token {payload.label!r} is not a TOTP secret")

    def _materialize(self, payload: SecretPayload, *, use: str) -> str:
        if payload.kind == KIND_TOTP:
            return totp(payload.value, at=self._clock())
        return payload.value
