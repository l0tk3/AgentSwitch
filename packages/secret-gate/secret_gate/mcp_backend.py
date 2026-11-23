"""What the `secret-gate mcp` tools do, local or forwarded to the gate service (gate-service-v0 §4).

`LocalMcpBackend` is the gate without a service: this process holds the key. `RemoteMcpBackend` is the forwarder a
login user's MCP server becomes once the gate runs as a service: each call goes to `mcp.*` on `gate.sock` with this
process's execution scope (SECRET_GATE_SCOPE). Tool names, descriptions and signatures are defined once, in
mcp_server.py.

`secret_exec` is the exception (gate-simple-v0 §2.1): in both backends the command runs here, as the login user,
never in the service. The remote backend only asks the service for each `exec` value (`exec.resolve`).
"""

from __future__ import annotations

import os
from collections.abc import Callable, Mapping
from pathlib import Path
from typing import Any, Protocol

from .constants import SCOPE_ENV_VAR, USE_EXEC
from .errors import ValidationError
from .gate_ops import op_describe, op_exec, op_http, op_otp
from .keystore import gate_home
from .resolver import Resolution, Resolver
from .rpc_client import RpcClient
from .service_paths import client_socket


class McpBackend(Protocol):
    def describe(self, token: str) -> dict: ...

    def otp(self, token: str) -> str: ...

    def http(self, method: str, url: str, headers: dict | None, body: str | None) -> dict: ...

    def exec(self, argv: list[str], env: dict[str, str]) -> dict: ...


def _exec(resolve: Callable[[str], Resolution], argv: list[str], env: dict[str, str], runner: Any) -> dict:
    kwargs = {"runner": runner} if runner is not None else {}
    result = op_exec(resolve, argv=argv, env=env, **kwargs)
    return {"returncode": result.returncode, "stdout": result.stdout, "stderr": result.stderr}


class LocalMcpBackend:
    def __init__(self, resolver: Resolver, *, exec_runner: Any = None) -> None:
        self._resolver = resolver
        self._exec_runner = exec_runner

    @classmethod
    def from_home(cls, home: Path, scope: str | None) -> LocalMcpBackend:
        return cls(Resolver.from_home(home, scope=scope))

    def describe(self, token: str) -> dict:
        return op_describe(self._resolver, token)

    def otp(self, token: str) -> str:
        return op_otp(self._resolver, token)

    def http(self, method: str, url: str, headers: dict | None, body: str | None) -> dict:
        result = op_http(self._resolver, method=method, url=url, headers=headers, body=body)
        return {"status": result.status, "headers": result.headers, "body": result.body}

    def exec(self, argv: list[str], env: dict[str, str]) -> dict:
        return _exec(lambda token: self._resolver.resolve_exact(token, use=USE_EXEC), argv, env, self._exec_runner)


class RemoteMcpBackend:
    def __init__(self, client: RpcClient, scope: str | None, *, exec_runner: Any = None) -> None:
        self._client = client
        self._scope = scope
        self._exec_runner = exec_runner

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

    def _resolve_exec(self, token: str) -> Resolution:
        result = _dict(self._call("exec.resolve", {"token": token}))
        value, label = result.get("value"), result.get("label")
        if not isinstance(value, str) or not isinstance(label, str):
            raise ValidationError("凭据网关服务返回了无效的响应")
        return Resolution(token=token, label=label, value=value)

    def exec(self, argv: list[str], env: dict[str, str]) -> dict:
        return _exec(self._resolve_exec, argv, env, self._exec_runner)


def _dict(result: Any) -> dict:
    if not isinstance(result, dict):
        raise ValidationError("凭据网关服务返回了无效的响应")
    return result


def default_backend(env: Mapping[str, str] | None = None) -> McpBackend:
    env = os.environ if env is None else env
    scope = env.get(SCOPE_ENV_VAR) or None
    sock = client_socket(env)
    if sock is not None:
        return RemoteMcpBackend(RpcClient(sock), scope)
    return LocalMcpBackend.from_home(gate_home(), scope)
