"""MCP (stdio) wiring around an McpBackend. Not unit-tested; the backends it calls are (mcp_backend.py).

`SECRET_GATE_SCOPE` (set by the dispatcher for this execution only) lets `enc:ref:` references of
that execution resolve; without it only enc:v1: tokens work. With the gate service installed
(gate-service-v0 §4) the same tools forward every call to it; this process then holds no key.
"""

from __future__ import annotations

from mcp.server.fastmcp import FastMCP

from .credential_repair import REPAIR_PURPOSE
from .errors import GateError
from .mcp_backend import McpBackend, default_backend


def build_server(backend: McpBackend | None = None) -> FastMCP:
    gate = backend or default_backend()
    mcp = FastMCP("secret-gate")

    @mcp.tool()
    def secret_describe(token: str) -> dict:
        """Show the label, kind, allowed hosts and uses of an enc:v1: token or enc:ref: reference. Never reveals the value."""
        return _guard(lambda: gate.describe(token))

    @mcp.tool()
    async def secret_repair(token: str, host: str, purpose: str = REPAIR_PURPOSE) -> dict:
        """Ask the task dispatcher to authorize TOTP seed import at an already granted host.
        Returns secret/http ciphertext (or a reference to it) only. Does not generate a code, fill a field, or add hosts."""
        try:
            return await gate.repair(token, host, purpose)
        except GateError as exc:
            raise RuntimeError(f"secret-gate: {exc}") from None

    @mcp.tool()
    def secret_otp(token: str) -> str:
        """Return the current TOTP code for a token (or reference) of kind 'totp'."""
        return _guard(lambda: gate.otp(token))

    @mcp.tool()
    def secret_http(method: str, url: str, headers: dict | None = None, body: str | None = None) -> dict:
        """Send an HTTP request; enc:v1 tokens and enc:ref references in url/headers/body are resolved for the target host only.
        The response is redacted before it is returned."""
        return _guard(lambda: gate.http(method, url, headers, body))

    @mcp.tool()
    def secret_exec(template: str, token: str, args: list[str] | None = None) -> dict:
        """Run a whitelisted command template with the token's value injected. Output is redacted."""
        return _guard(lambda: gate.exec(template, token, args))

    return mcp


def _guard(fn):
    try:
        return fn()
    except GateError as exc:
        # Surface policy errors as tool errors so the model sees *why*, never the value.
        raise RuntimeError(f"secret-gate: {exc}") from None


def main() -> None:
    build_server().run(transport="stdio")


if __name__ == "__main__":
    main()
