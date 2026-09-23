"""`secret-gate browser -- <mcp server command...>`: MCP stdio server that gates another one.

The downstream (normally Playwright MCP) is spawned as a child with the proxy variables removed
from its environment: npx would otherwise contact the npm registry through the gate and hang. The
browser it launches gets its proxy from the downstream's own arguments (--proxy-server).

Playwright MCP writes every page snapshot and console log, unredacted, to its output directory
(default `.playwright-mcp/` under its cwd, i.e. the agent's work dir). The gate therefore runs the
downstream with cwd and --output-dir inside the gate home, which the harness deny rules already
cover and which a separate gate user makes unreadable.
"""

from __future__ import annotations

import os
from collections.abc import Sequence
from contextlib import AsyncExitStack
from pathlib import Path
from typing import Any, Self

import anyio
from mcp import ClientSession, StdioServerParameters, types
from mcp.client.stdio import stdio_client
from mcp.server.lowlevel import Server
from mcp.server.stdio import stdio_server

from .browser_gate import BrowserGate
from .errors import ValidationError
from .keystore import gate_home
from .resolver import Resolver

PROXY_VARS = ("HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy")
SERVER_NAME = "secret-gate-browser"
OUTPUT_DIR_FLAG = "--output-dir"
OUTPUT_SUBDIR = "browser-out"


def downstream_env(env: dict[str, str] | None = None) -> dict[str, str]:
    base = dict(os.environ if env is None else env)
    return {k: v for k, v in base.items() if k not in (*PROXY_VARS, "SECRET_GATE_REPAIR_URL", "SECRET_GATE_REPAIR_KEY")}


def parse_command(argv: Sequence[str]) -> list[str]:
    command = list(argv)
    if command and command[0] == "--":
        command = command[1:]
    if not command:
        raise ValidationError("browser: give the downstream MCP command after --")
    return command


def private_output_dir(home: Path) -> Path:
    """0700 directory under the gate home for the downstream's cwd and snapshot/log output."""
    out = home / OUTPUT_SUBDIR
    out.mkdir(mode=0o700, parents=True, exist_ok=True)
    out.chmod(0o700)
    return out


def downstream_command(command: Sequence[str], out_dir: Path) -> list[str]:
    """Add --output-dir=<out_dir> unless the caller already chose one."""
    if any(a == OUTPUT_DIR_FLAG or a.startswith(OUTPUT_DIR_FLAG + "=") for a in command):
        return list(command)
    return [*command, f"{OUTPUT_DIR_FLAG}={out_dir}"]


class StdioDownstream:
    """Spawns the downstream MCP server and exposes list/call as the gate's `Downstream`."""

    def __init__(self, command: Sequence[str], out_dir: Path, env: dict[str, str] | None = None) -> None:
        argv = downstream_command(command, out_dir)
        self._params = StdioServerParameters(
            command=argv[0], args=argv[1:], env=downstream_env(env), cwd=out_dir
        )
        self._stack = AsyncExitStack()
        self._session: ClientSession | None = None

    async def __aenter__(self) -> Self:
        try:
            read, write = await self._stack.enter_async_context(stdio_client(self._params))
            self._session = await self._stack.enter_async_context(ClientSession(read, write))
            await self._session.initialize()
        except BaseException:
            await self._stack.aclose()  # do not leave the child running
            raise
        return self

    async def __aexit__(self, *exc: object) -> None:
        await self._stack.aclose()

    async def list_tools(self) -> Sequence[types.Tool]:
        assert self._session is not None
        return (await self._session.list_tools()).tools

    async def call_tool(self, name: str, args: dict[str, Any]) -> types.CallToolResult:
        assert self._session is not None
        return await self._session.call_tool(name, args)


def build_server(gate: BrowserGate) -> Server:
    server: Server = Server(SERVER_NAME)

    @server.list_tools()
    async def _list_tools() -> list[types.Tool]:
        return await gate.list_tools()

    @server.call_tool(validate_input=False)
    async def _call_tool(name: str, arguments: dict[str, Any] | None) -> list[types.ContentBlock]:
        return await gate.call_tool(name, arguments or {})

    return server


async def serve(command: Sequence[str]) -> None:
    home = gate_home()
    resolver = Resolver.from_home(home)
    out_dir = private_output_dir(home)
    async with StdioDownstream(command, out_dir) as downstream:
        server = build_server(BrowserGate(resolver, downstream, output_dir=out_dir))
        async with stdio_server() as (read, write):
            await server.run(read, write, server.create_initialization_options())


def main(argv: Sequence[str]) -> None:
    anyio.run(serve, parse_command(argv))
