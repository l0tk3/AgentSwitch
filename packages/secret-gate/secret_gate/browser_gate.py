"""Async gate in front of a browser MCP server: substitutes tokens in typed text, redacts results.

`Downstream` is anything that speaks MCP tools (the real Playwright MCP over stdio, or a fake in
tests). All policy decisions are in browser_policy.py; this module only sequences them.
"""

from __future__ import annotations

import asyncio
import json
from collections.abc import Sequence
from pathlib import Path
from typing import Any, Protocol

from mcp import types

from .browser_policy import (
    DENIED_TOOLS,
    HREF_PROBE_FUNCTION,
    HREF_PROBE_TOOL,
    SCREENSHOT_TOOL,
    SECRET_FILL_DESCRIPTION,
    SECRET_FILL_SCHEMA,
    SECRET_FILL_TOOL,
    SNAPSHOT_TOOL,
    GateState,
    check_call_allowed,
    extract_href,
    has_tokens,
    resolve_for_page,
    rewrite_fill_args,
    scrub_result_text,
    secret_fill_to_type,
    strip_file_output,
)
from .errors import GateError, PolicyViolation
from .credential_repair import REPAIR_DESCRIPTION, REPAIR_SCHEMA, REPAIR_TOOL, request_repair
from .redact import contains_any, redact
from .resolver import Resolver

WITHHELD = "done (details withheld by secret-gate; call browser_snapshot to see the page)"


class Downstream(Protocol):
    async def list_tools(self) -> Sequence[types.Tool]: ...

    async def call_tool(self, name: str, args: dict[str, Any]) -> types.CallToolResult: ...


def sweep_output_dir(out_dir: Path | None) -> None:
    """Delete whatever the downstream persisted (unredacted snapshots, console/network logs)."""
    if out_dir is None or not out_dir.is_dir():
        return
    for entry in out_dir.iterdir():
        if entry.is_file() or entry.is_symlink():
            entry.unlink(missing_ok=True)


class BrowserGate:
    def __init__(self, resolver: Resolver, downstream: Downstream, output_dir: Path | None = None) -> None:
        self._resolver = resolver
        self._down = downstream
        self._output_dir = output_dir
        self._state = GateState()
        self._lock = asyncio.Lock()  # URL probe + fill must not interleave with other calls

    @property
    def state(self) -> GateState:
        return self._state

    async def list_tools(self) -> list[types.Tool]:
        tools = [
            t.model_copy(update={"inputSchema": strip_file_output(t.inputSchema), "outputSchema": None})
            for t in await self._down.list_tools()
            if t.name not in DENIED_TOOLS
        ]
        tools.append(types.Tool(name=SECRET_FILL_TOOL, description=SECRET_FILL_DESCRIPTION, inputSchema=SECRET_FILL_SCHEMA))
        tools.append(types.Tool(name=REPAIR_TOOL, description=REPAIR_DESCRIPTION, inputSchema=REPAIR_SCHEMA))
        return tools

    async def call_tool(self, name: str, args: dict[str, Any]) -> list[types.ContentBlock]:
        async with self._lock:
            try:
                return await self._call(name, args)
            except GateError as exc:
                hint = ""
                if isinstance(exc, PolicyViolation) and "does not allow use 'http'" in str(exc):
                    hint = (" If the original task explicitly authorizes importing this TOTP seed into this same host, "
                            "request secret_repair(token, host, purpose='totp_seed_import'). The original token must "
                            "already grant seed import; otherwise ask for the field and destination in a new message. "
                            "Do not change hosts, keep retrying the fill, or substitute a code for the seed.")
                raise RuntimeError(f"secret-gate: {exc}{hint}") from None
            except Exception as exc:  # noqa: BLE001 - never let a downstream message carry a value back
                raise RuntimeError(redact(str(exc), self._state.filled) or "browser error") from None
            finally:
                sweep_output_dir(self._output_dir)

    async def _call(self, name: str, args: dict[str, Any]) -> list[types.ContentBlock]:
        if name == REPAIR_TOOL:
            if set(args) - {"token", "host", "purpose"}:
                raise PolicyViolation("credential repair request has unexpected fields")
            result = await request_repair(args.get("token"), args.get("host"), args.get("purpose", "totp_seed_import"))
            return [types.TextContent(type="text", text=json.dumps(result))]
        if name == SECRET_FILL_TOOL:
            name, args = "browser_type", secret_fill_to_type(args)
        check_call_allowed(name, args, self._state)
        if has_tokens(name, args):
            result = await self._fill(name, args)
        else:
            if name == SCREENSHOT_TOOL:
                await self._ensure_screenshot_safe()
            result = await self._down.call_tool(name, args)
        return self._finish(name, result)

    async def _fill(self, name: str, args: dict[str, Any]) -> types.CallToolResult:
        url = await self._current_url()
        new_args, resolutions = rewrite_fill_args(name, args, resolve_for_page(self._resolver, url))
        # Taint before the call: even a failed type() may have left the value in the DOM.
        self._state = self._state.with_fill(url, resolutions)
        return await self._down.call_tool(name, new_args)

    async def _ensure_screenshot_safe(self) -> None:
        """An image cannot be redacted: refuse on any page that held a value or shows one now."""
        if not self._state.filled:
            return
        if await self._current_url() in self._state.tainted_urls:
            raise PolicyViolation("screenshot refused: this page held a filled value; navigate elsewhere first")
        snapshot = await self._down.call_tool(SNAPSHOT_TOOL, {})
        if contains_any(_texts(snapshot), self._state.filled):
            raise PolicyViolation("screenshot refused: the page currently shows a filled value")

    async def _current_url(self) -> str:
        probe = await self._down.call_tool(HREF_PROBE_TOOL, {"function": HREF_PROBE_FUNCTION})
        if probe.isError:
            raise PolicyViolation("could not determine the current page URL; refused")
        return extract_href(_texts(probe))

    def _finish(self, name: str, result: types.CallToolResult) -> list[types.ContentBlock]:
        blocks = [self._redact_block(name, b) for b in result.content]
        if result.isError:
            message = "\n".join(b.text for b in blocks if isinstance(b, types.TextContent)) or "browser error"
            raise RuntimeError(message)
        return blocks

    def _redact_block(self, name: str, block: types.ContentBlock) -> types.ContentBlock:
        if isinstance(block, types.TextContent):
            scrubbed = scrub_result_text(name, block.text)
            if block.text.strip() and not scrubbed.strip():
                scrubbed = WITHHELD
            return types.TextContent(type="text", text=redact(scrubbed, self._state.filled) or "")
        if isinstance(block, types.ImageContent):
            return block  # only reachable through an allowed screenshot
        return types.TextContent(type="text", text="[content omitted by secret-gate]")


def _texts(result: types.CallToolResult) -> str:
    return "\n".join(c.text for c in result.content if isinstance(c, types.TextContent))
