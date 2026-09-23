"""MCP (stdio) wiring around gate_ops. Not unit-tested; the ops it calls are."""

from __future__ import annotations

from mcp.server.fastmcp import FastMCP

from .credential_repair import REPAIR_PURPOSE, request_repair
from .errors import GateError
from .exec_templates import load_templates
from .gate_ops import op_describe, op_exec, op_http, op_otp
from .keystore import gate_home
from .resolver import Resolver


def build_server() -> FastMCP:
    home = gate_home()
    resolver = Resolver.from_home(home)
    templates = load_templates(home)
    mcp = FastMCP("secret-gate")

    @mcp.tool()
    def secret_describe(token: str) -> dict:
        """Show a token's label, kind, allowed hosts and uses. Never reveals the value."""
        return _guard(lambda: op_describe(resolver, token))

    @mcp.tool()
    async def secret_repair(token: str, host: str, purpose: str = REPAIR_PURPOSE) -> dict:
        """Ask the task dispatcher to authorize TOTP seed import at an already granted host.
        Returns secret/http ciphertext only. Does not generate a code, fill a field, or add hosts."""
        try:
            return await request_repair(token, host, purpose)
        except GateError as exc:
            raise RuntimeError(f"secret-gate: {exc}") from None

    @mcp.tool()
    def secret_otp(token: str) -> str:
        """Return the current TOTP code for a token of kind 'totp'."""
        return _guard(lambda: op_otp(resolver, token))

    @mcp.tool()
    def secret_http(method: str, url: str, headers: dict | None = None, body: str | None = None) -> dict:
        """Send an HTTP request; enc:v1 tokens in url/headers/body are resolved for the target host only.
        The response is redacted before it is returned."""
        result = _guard(lambda: op_http(resolver, method=method, url=url, headers=headers, body=body))
        return {"status": result.status, "headers": result.headers, "body": result.body}

    @mcp.tool()
    def secret_exec(template: str, token: str, args: list[str] | None = None) -> dict:
        """Run a whitelisted command template with the token's value injected. Output is redacted."""
        result = _guard(
            lambda: op_exec(resolver, templates, template=template, token=token, args=tuple(args or ()))
        )
        return {"returncode": result.returncode, "stdout": result.stdout, "stderr": result.stderr}

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
