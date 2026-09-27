"""The resolver the browser gate works with, local or through the gate service (gate-service-v0 §4).

`GateResolver` is everything `BrowserGate` asks of a resolver. `Resolver` (resolver.py) is the local one: this
process holds the private keys. `RemoteResolver` is the one a login user's browser component uses once the gate
runs as a service: this process holds no key and asks `gate.sock`:

* `browser.resolve` for a value to type (browser fill only; the service checks that the token allows `fill`
  and the page's host:port, and records the call),
* `browser.register` for a reference to a value the gate sealed on a source page (transfer.py),
* `mcp.repair` for `secret_repair`, with this process's dispatcher bridge.

The browser still redacts what it filled, so a resolution carries the value; that is the gap §1 documents.
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import Mapping
from typing import Any, Protocol

from .constants import USE_FILL
from .credential_repair import REPAIR_PURPOSE
from .errors import PolicyViolation, ValidationError
from .resolver import Resolution, substitute_with
from .rpc_client import RpcClient
from .tokens import is_ref

REPAIR_URL_ENV = "SECRET_GATE_REPAIR_URL"
REPAIR_KEY_ENV = "SECRET_GATE_REPAIR_KEY"


class GateResolver(Protocol):
    @property
    def scope(self) -> str | None: ...

    def resolve(self, token: str, *, use: str, host: str | None = None) -> Resolution: ...

    def substitute(self, text: str, *, use: str, host: str | None = None) -> tuple[str, tuple[Resolution, ...]]: ...

    def register(self, token: str) -> str: ...

    async def repair(self, token: object, host: object, purpose: object = REPAIR_PURPOSE) -> dict: ...


def repair_params(env: Mapping[str, str]) -> dict[str, str]:
    """The dispatcher bridge of this execution, handed to the service with each repair call (§4)."""
    return {name: env[var] for name, var in (("repairUrl", REPAIR_URL_ENV), ("repairKey", REPAIR_KEY_ENV)) if env.get(var)}


class RemoteResolver:
    def __init__(self, client: RpcClient, scope: str | None, env: Mapping[str, str] | None = None) -> None:
        self._client = client
        self._scope = scope
        self._env = dict(os.environ if env is None else env)

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

    async def repair(self, token: object, host: object, purpose: object = REPAIR_PURPOSE) -> dict:
        params: dict[str, Any] = {"scope": self._scope, "token": token, "host": host, "purpose": purpose,
                                  **repair_params(self._env)}
        result = await asyncio.to_thread(self._client.call, "mcp.repair", params)
        if not isinstance(result, dict):
            raise ValidationError("invalid credential repair response")
        return result


def _field(result: object, name: str) -> str:
    if not isinstance(result, dict) or not isinstance(result.get(name), str):
        raise ValidationError("凭据网关服务返回了无效的响应")
    return result[name]
