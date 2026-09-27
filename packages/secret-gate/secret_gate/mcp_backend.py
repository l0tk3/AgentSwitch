"""What the `secret-gate mcp` tools do, local or forwarded to the gate service (gate-service-v0 §4).

`LocalMcpBackend` is the gate as it always was: this process holds the keys. `RemoteMcpBackend` is the forwarder a
login user's MCP server becomes once the gate runs as a service: each call goes to `mcp.*` on `gate.sock` with
this process's execution scope (SECRET_GATE_SCOPE) and, for `secret_repair`, its dispatcher bridge
(SECRET_GATE_REPAIR_URL/KEY). Tool names, descriptions and signatures are defined once, in mcp_server.py.
"""

from __future__ import annotations

import asyncio
import os
from collections.abc import Mapping
from pathlib import Path
from typing import Any, Protocol

from .constants import SCOPE_ENV_VAR
from .credential_repair import REPAIR_PURPOSE, repair_scoped
from .errors import ValidationError
from .exec_templates import ExecTemplate, load_templates
from .gate_ops import op_describe, op_exec, op_http, op_otp
from .keystore import gate_home
from .remote_resolver import repair_params
from .resolver import Resolver
from .rpc_client import RpcClient
from .service_paths import client_socket


class McpBackend(Protocol):
    def describe(self, token: str) -> dict: ...

    def otp(self, token: str) -> str: ...

    def http(self, method: str, url: str, headers: dict | None, body: str | None) -> dict: ...

    def exec(self, template: str, token: str, args: list[str] | None) -> dict: ...

    async def repair(self, token: str, host: str, purpose: str) -> dict: ...


class LocalMcpBackend:
    def __init__(self, resolver: Resolver, templates: dict[str, ExecTemplate]) -> None:
        self._resolver = resolver
        self._templates = templates

    @classmethod
    def from_home(cls, home: Path, scope: str | None) -> LocalMcpBackend:
        return cls(Resolver.from_home(home, scope=scope), load_templates(home))

    def describe(self, token: str) -> dict:
        return op_describe(self._resolver, token)

    def otp(self, token: str) -> str:
        return op_otp(self._resolver, token)

    def http(self, method: str, url: str, headers: dict | None, body: str | None) -> dict:
        result = op_http(self._resolver, method=method, url=url, headers=headers, body=body)
        return {"status": result.status, "headers": result.headers, "body": result.body}

    def exec(self, template: str, token: str, args: list[str] | None) -> dict:
        result = op_exec(self._resolver, self._templates, template=template, token=token, args=tuple(args or ()))
        return {"returncode": result.returncode, "stdout": result.stdout, "stderr": result.stderr}

    async def repair(self, token: str, host: str, purpose: str = REPAIR_PURPOSE) -> dict:
        return await repair_scoped(self._resolver, token, host, purpose)


class RemoteMcpBackend:
    def __init__(self, client: RpcClient, scope: str | None, env: Mapping[str, str] | None = None) -> None:
        self._client = client
        self._scope = scope
        self._env = dict(os.environ if env is None else env)

    def _call(self, rpc_method: str, params: dict[str, Any]) -> Any:
        return self._client.call(rpc_method, {**({"scope": self._scope} if self._scope else {}), **params})

    def describe(self, token: str) -> dict:
        return _dict(self._call("mcp.describe", {"token": token}))

    def otp(self, token: str) -> str:
        code = self._call("mcp.otp", {"token": token})
        if not isinstance(code, str):
            raise ValidationError("凭据网关服务返回了无效的响应")
        return code

    def http(self, method: str, url: str, headers: dict | None, body: str | None) -> dict:
        params: dict[str, Any] = {"method": method, "url": url}
        if headers is not None:
            params["headers"] = {str(k): str(v) for k, v in headers.items()}
        if body is not None:
            params["body"] = body
        return _dict(self._call("mcp.http", params))

    def exec(self, template: str, token: str, args: list[str] | None) -> dict:
        return _dict(self._call("mcp.exec", {"template": template, "token": token, "args": list(args or [])}))

    async def repair(self, token: str, host: str, purpose: str = REPAIR_PURPOSE) -> dict:
        params = {"token": token, "host": host, "purpose": purpose, **repair_params(self._env)}
        return _dict(await asyncio.to_thread(self._call, "mcp.repair", params))


def _dict(result: Any) -> dict:
    if not isinstance(result, dict):
        raise ValidationError("凭据网关服务返回了无效的响应")
    return result


def default_backend(env: Mapping[str, str] | None = None) -> McpBackend:
    env = os.environ if env is None else env
    scope = env.get(SCOPE_ENV_VAR) or None
    sock = client_socket(env)
    if sock is not None:
        return RemoteMcpBackend(RpcClient(sock), scope, env)
    return LocalMcpBackend.from_home(gate_home(), scope)
