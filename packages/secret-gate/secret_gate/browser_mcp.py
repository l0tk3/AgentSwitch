"""`secret-gate browser -- <mcp server command...>`: MCP stdio server that gates another one.

The downstream (normally Playwright MCP) is spawned as a child with the proxy variables removed
from its environment: npx would otherwise contact the npm registry through the gate and hang. The
browser it launches gets its proxy from the downstream's own arguments (--proxy-server).

Playwright MCP writes every page snapshot and console log, unredacted, to its output directory
(default `.playwright-mcp/` under its cwd, i.e. the agent's work dir). The gate therefore runs the
downstream with cwd and --output-dir inside the gate home, which the harness deny rules already
cover and which a separate gate user makes unreadable.

The downstream may also be AgentSwitch's agent bridge (`node bridgeClient.js …`, docs/browser-v0.md §6): Playwright MCP
then runs in the AgentSwitch daemon, on the shared browser, and writes its files in a private folder of the daemon's
that the daemon empties after every call; the bridge takes the --output-dir given here and writes nothing. The gate's
own masked screenshots are still written into the gate's directory (by Playwright, in the daemon) and read back here.

The dispatcher configures one execution through the environment of this process only:
SECRET_GATE_SCOPE (its enc:ref: scope) and SECRET_GATE_TRANSFER (an authorized field transfer,
transfer.py). Neither reaches the downstream: it gets no scope, no grant, no repair bridge.

With the gate service installed (gate-service-v0 §4) this process still runs as the login user (Playwright and
a visible Chrome), but holds no key: values come from `browser.resolve` (fill only), sealed page data is
registered with `browser.register`, the mask configuration comes from `browser.config`, the service records
the audit, and the downstream's output goes to a private temporary directory of this user, removed at exit.
"""

from __future__ import annotations

import os
import shutil
import sys
import tempfile
from collections.abc import Callable, Iterator, Sequence
from contextlib import AsyncExitStack, contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import Any, Self

import anyio
from mcp import ClientSession, StdioServerParameters, types
from mcp.client.stdio import stdio_client
from mcp.server.lowlevel import Server
from mcp.server.stdio import stdio_server

from .audit import Audit
from .browser_gate import BrowserGate
from .browser_mask import MaskConfig
from .constants import SCOPE_ENV_VAR
from .errors import ValidationError
from .keystore import gate_home, load_public_key
from .publish import current_public_key, read_rows
from .remote_resolver import GateResolver, RemoteResolver
from .resolver import Resolver
from .rpc_client import RpcClient
from .service_paths import client_socket, public_dir
from .transfer import TRANSFER_ENV_VAR, TransferGrant

PROXY_VARS = ("HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "ALL_PROXY", "all_proxy")
SERVER_NAME = "secret-gate-browser"
OUTPUT_DIR_FLAG = "--output-dir"
OUTPUT_SUBDIR = "browser-out"


GATE_ONLY_VARS = ("SECRET_GATE_REPAIR_URL", "SECRET_GATE_REPAIR_KEY", SCOPE_ENV_VAR, TRANSFER_ENV_VAR)


def downstream_env(env: dict[str, str] | None = None) -> dict[str, str]:
    base = dict(os.environ if env is None else env)
    return {k: v for k, v in base.items() if k not in (*PROXY_VARS, *GATE_ONLY_VARS)}


def execution_config(env: dict[str, str], home: Path, *, public_key: Callable[[], bytes] | None = None,
                     ) -> tuple[str | None, TransferGrant | None, bytes | None]:
    """(scope, transfer grant, public key) for this execution. A grant without a scope, or one this gate cannot
    parse, is not applied: exactly what the dispatcher does with an invalid grant (nothing sealed, nothing widened)."""
    scope = env.get(SCOPE_ENV_VAR) or None
    raw = env.get(TRANSFER_ENV_VAR)
    if not raw:
        return scope, None, None
    try:
        grant = TransferGrant.parse(raw)
    except ValidationError as exc:
        print(f"secret-gate: SECRET_GATE_TRANSFER ignored: {exc}", file=sys.stderr)
        return scope, None, None
    if scope is None:
        print("secret-gate: SECRET_GATE_TRANSFER ignored: it needs SECRET_GATE_SCOPE from the dispatcher", file=sys.stderr)
        return None, None, None
    return scope, grant, (public_key or (lambda: load_public_key(home)))()


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


@dataclass(frozen=True)
class BrowserSetup:
    resolver: GateResolver
    grant: TransferGrant | None
    public_key: bytes | None
    mask: MaskConfig
    audit: Audit
    out_dir: Path


def local_setup(env: dict[str, str], home: Path) -> BrowserSetup:
    scope, grant, public_key = execution_config(env, home)
    return BrowserSetup(Resolver.from_home(home, scope=scope), grant, public_key, MaskConfig.load(home),
                        Audit.at_home(home, scope), private_output_dir(home))


def service_setup(env: dict[str, str], client: RpcClient, out_dir: Path) -> BrowserSetup:
    """The browser component of a login user once the gate is a service: no key, no gate home."""
    public = public_dir(env)
    scope, grant, public_key = execution_config(env, public, public_key=lambda: current_public_key(read_rows(public)))
    config = client.call("browser.config")
    mask = MaskConfig.parse(config.get("screenshotMask") if isinstance(config, dict) else None)
    return BrowserSetup(RemoteResolver(client, scope, env), grant, public_key, mask, Audit(None), out_dir)


@contextmanager
def user_output_dir() -> Iterator[Path]:
    """A 0700 temporary directory of the login user for the downstream's output, removed at exit."""
    path = Path(tempfile.mkdtemp(prefix="secret-gate-browser-"))
    try:
        yield path
    finally:
        shutil.rmtree(path, ignore_errors=True)


async def _run(command: Sequence[str], setup: BrowserSetup) -> None:
    async with StdioDownstream(command, setup.out_dir) as downstream:
        gate = BrowserGate(setup.resolver, downstream, output_dir=setup.out_dir, transfer=setup.grant,
                           public_key=setup.public_key, mask=setup.mask, audit=setup.audit)
        server = build_server(gate)
        async with stdio_server() as (read, write):
            await server.run(read, write, server.create_initialization_options())


async def serve(command: Sequence[str]) -> None:
    env = dict(os.environ)
    sock = client_socket(env)
    if sock is None:
        await _run(command, local_setup(env, gate_home()))
        return
    with user_output_dir() as out_dir:
        await _run(command, service_setup(env, RpcClient(sock), out_dir))


def main(argv: Sequence[str]) -> None:
    anyio.run(serve, parse_command(argv))
