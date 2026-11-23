"""The resolver the browser gate works with, local or through the gate service (gate-service-v0 §4).

`GateResolver` is everything `BrowserGate` asks of a resolver. `Resolver` (resolver.py) is the local one: this
process holds the private key. `RemoteResolver` is the one a login user's browser component uses once the gate
runs as a service: this process holds no key and asks `gate.sock`:

* `browser.resolve` for a value to type (browser fill only; the service checks that the token allows `fill`
  and the page's host:port, and records the call),
* `browser.register` for a reference to a value the gate sealed on a source page (transfer.py).

The browser still redacts what it filled, so a resolution carries the value; that is the gap gate-simple-v0 §4
documents.
"""

from __future__ import annotations

from typing import Protocol

from .constants import USE_FILL
from .errors import PolicyViolation, ValidationError
from .resolver import Resolution, substitute_with
from .rpc_client import RpcClient
from .tokens import is_ref


class GateResolver(Protocol):
    @property
    def scope(self) -> str | None: ...

    def resolve(self, token: str, *, use: str, host: str | None = None) -> Resolution: ...

    def substitute(self, text: str, *, use: str, host: str | None = None) -> tuple[str, tuple[Resolution, ...]]: ...

    def register(self, token: str) -> str: ...


class RemoteResolver:
    def __init__(self, client: RpcClient, scope: str | None) -> None:
        self._client = client
        self._scope = scope

    @property
    def scope(self) -> str | None:
        return self._scope

    def resolve(self, token: str, *, use: str, host: str | None = None) -> Resolution:
        if use != USE_FILL:
            raise PolicyViolation("the gate service hands values to the browser only for a fill")
        if not host:
            raise PolicyViolation("http use requires a target host")
        result = self._client.call("browser.resolve", {"scope": self._scope, "token": token, "host": host})
        value, label = _field(result, "value"), _field(result, "label")
        return Resolution(token=token, label=label, value=value)

    def substitute(self, text: str, *, use: str, host: str | None = None) -> tuple[str, tuple[Resolution, ...]]:
        return substitute_with(self.resolve, text, use=use, host=host)

    def register(self, token: str) -> str:
        if self._scope is None:
            raise ValidationError("no execution scope to register a reference in")
        ref = _field(self._client.call("browser.register", {"scope": self._scope, "token": token}), "ref")
        if not is_ref(ref):
            raise ValidationError("凭据网关服务返回了无效的引用")
        return ref


def _field(result: object, name: str) -> str:
    if not isinstance(result, dict) or not isinstance(result.get(name), str):
        raise ValidationError("凭据网关服务返回了无效的响应")
    return result[name]
