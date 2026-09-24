"""Turn tokens into values, but only when the token's policy allows the host and use.

An `enc:ref:` reference is first looked up in the registry for this resolver's execution scope
(refs.py); the ciphertext it points to is then checked exactly like a token given directly.
"""

from __future__ import annotations

import time
from collections.abc import Callable
from dataclasses import dataclass

from .constants import KIND_TOTP, USE_FILL, USE_HTTP, USE_OTP, VALID_USES
from .errors import PolicyViolation, TokenError, ValidationError
from .otp import totp
from .policy import SecretPayload
from .refs import RefRegistry, check_scope
from .tokens import find_secrets, is_ref, open_token, replace_token


@dataclass(frozen=True)
class Resolution:
    """One token (or reference) resolved for one request. `value` must never be logged or returned to the model."""

    token: str
    label: str
    value: str


class Resolver:
    def __init__(
        self,
        private_key: bytes,
        clock: Callable[[], float] = time.time,
        extra_private_keys: tuple[bytes, ...] = (),
        refs: RefRegistry | None = None,
        scope: str | None = None,
    ) -> None:
        self._keys: tuple[bytes, ...] = (private_key, *extra_private_keys)
        self._clock = clock
        self._refs = refs
        self._scope = None if scope is None else check_scope(scope)

    @property
    def refs(self) -> RefRegistry | None:
        return self._refs

    @property
    def scope(self) -> str | None:
        return self._scope

    def scoped(self, scope: str | None) -> Resolver:
        """The same keys and registry, resolving references of another execution scope."""
        return Resolver(self._keys[0], clock=self._clock, extra_private_keys=self._keys[1:], refs=self._refs, scope=scope)

    def ciphertext(self, token_or_ref: str) -> str:
        """The enc:v1: token itself, or the one a reference in this scope points to."""
        if not is_ref(token_or_ref):
            return token_or_ref
        if self._refs is None:
            raise ValidationError("enc:ref: references are not available in this gate process")
        return self._refs.lookup(self._scope, token_or_ref).token

    def register(self, token: str) -> str:
        """Give `token` a reference in this resolver's scope (the gate itself minted or repaired it)."""
        if self._refs is None or self._scope is None:
            raise ValidationError("no execution scope to register a reference in")
        return self._refs.register(self._scope, token, self.describe(token)["label"])

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
    def from_home(cls, home, clock: Callable[[], float] = time.time, scope: str | None = None) -> Resolver:
        from .keystore import load_all_private_keys

        keys = load_all_private_keys(home)
        if not keys:
            from .errors import KeyStoreError

            raise KeyStoreError(f"no keypair in {home}; run `secret-gate keygen`")
        return cls(keys[0], clock=clock, extra_private_keys=keys[1:], refs=RefRegistry.from_home(home), scope=scope)

    def describe(self, token: str) -> dict:
        """Policy metadata for a token or reference. Safe to show to the model."""
        info = self._open(self.ciphertext(token)).describe()
        return {"ref": token.strip(), **info} if is_ref(token) else info

    def resolve(self, token: str, *, use: str, host: str | None = None) -> Resolution:
        if use not in VALID_USES:
            raise ValidationError(f"unknown use {use!r}")
        payload = self._open(self.ciphertext(token))
        self._check_policy(payload, use=use, host=host)
        value = self._materialize(payload, use=use)
        return Resolution(token=token, label=payload.label, value=value)

    def substitute(
        self, text: str, *, use: str, host: str | None = None
    ) -> tuple[str, tuple[Resolution, ...]]:
        """Replace every token and reference in `text`. Returns (new_text, resolutions); `text` is untouched."""
        tokens = find_secrets(text)
        if not tokens:
            return text, ()
        resolutions = tuple(self.resolve(t, use=use, host=host) for t in tokens)
        out = text
        for res in resolutions:
            out = replace_token(out, res.token, res.value)
        return out, resolutions

    @staticmethod
    def _check_policy(payload: SecretPayload, *, use: str, host: str | None) -> None:
        allowed = payload.allows_use(use) or (use == USE_FILL and payload.allows_use(USE_HTTP))
        if not allowed:
            shown = USE_HTTP if use == USE_FILL else use  # a browser fill is HTTP to the site; keep one message
            raise PolicyViolation(
                f"token {payload.label!r} does not allow use {shown!r} (allowed: {sorted(payload.uses)})"
            )
        if use in (USE_HTTP, USE_FILL):
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
