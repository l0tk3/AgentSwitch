"""MCP (stdio) wiring around an McpBackend. Not unit-tested; the backends it calls are (mcp_backend.py).

`SECRET_GATE_SCOPE` (set by the dispatcher for this execution only) lets `enc:ref:` references of
that execution resolve; without it only enc:v1: tokens work. With the gate service installed
(gate-service-v0 §4) the same tools forward every call to it; this process then holds no key.
"""

from __future__ import annotations

from mcp.server.fastmcp import FastMCP

from .errors import GateError
from .mcp_backend import McpBackend, default_backend

SECRET_EXEC_DESCRIPTION = (
    "Run a command of your own with secret values in environment variables. `argv` is the command and its "
    "arguments (no shell; use [\"sh\", \"-c\", \"...\"] for one) and must not contain any enc: value. `env` maps "
    "upper-case variable names to exactly one enc:v1: token or enc:ref: reference each, e.g. "
    "{\"PGPASSWORD\": \"enc:ref:...\"}; refer to them in the command as $PGPASSWORD. Only tokens made for use "
    "'exec' work. The command runs as the user with a minimal environment (PATH, HOME, LANG, LC_ALL, TZ, TMPDIR plus "
    "these variables), empty stdin, in the current directory, 60 s at most. stdout and stderr are redacted: a value "
    "never appears in them, even via env, printenv or set -x."
)


def build_server(backend: McpBackend | None = None) -> FastMCP:
    gate = backend or default_backend()
    mcp = FastMCP("secret-gate")

    @mcp.tool()
    def secret_describe(token: str) -> dict:
        """Show the label, kind, allowed hosts and uses of an enc:v1: token or enc:ref: reference. Never reveals the value."""
        return _guard(lambda: gate.describe(token))

    @mcp.tool()
    def secret_otp(token: str) -> str:
        """Return the current TOTP code for a token (or reference) of kind 'totp'."""
        return _guard(lambda: gate.otp(token))

    @mcp.tool()
    def secret_http(method: str, url: str, headers: dict | None = None, body: str | None = None) -> dict:
        """Send an HTTP request; enc:v1 tokens and enc:ref references in url/headers/body are resolved for the target host only.
        The response is redacted before it is returned."""
        return _guard(lambda: gate.http(method, url, headers, body))

    @mcp.tool(description=SECRET_EXEC_DESCRIPTION)
    def secret_exec(argv: list[str], env: dict[str, str]) -> dict:
        return _guard(lambda: gate.exec(argv, env))

    return mcp


def _guard(fn):
    try:
        return fn()
    except GateError as exc:
        # Surface policy errors as tool errors so the model sees *why*, never the value.
        raise RuntimeError(f"secret-gate: {exc}") from None
    except Exception as exc:  # noqa: BLE001 - any other error text may quote a value (an httpx error names the
        # rewritten URL, a decoding error quotes the bytes): only its kind goes back (gate-simple-v0 §3.2)
        raise RuntimeError(f"secret-gate: {type(exc).__name__}") from None


def main() -> None:
    build_server().run(transport="stdio")


if __name__ == "__main__":
    main()
