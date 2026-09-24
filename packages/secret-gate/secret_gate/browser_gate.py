"""Async gate in front of a browser MCP server: substitutes tokens in typed text, redacts results.

`Downstream` is anything that speaks MCP tools (the real Playwright MCP over stdio, or a fake in
tests). All policy decisions are in browser_policy.py, masking in browser_mask.py, the Playwright
code the gate runs itself in browser_probe.py and sealing of page data in transfer.py; this module
only sequences them (gate-next-v0 §2, §5.1, §5.2).
"""

from __future__ import annotations

import asyncio
import base64
import json
import secrets
from collections.abc import Sequence
from pathlib import Path
from typing import Any, Protocol

from mcp import types

from .audit import Audit
from .browser_mask import CANVAS_SELECTOR, MASK_COLOR, PASSWORD_SELECTOR, MaskConfig, parse_boxes, sensitive_refs, uncovered_boxes
from .browser_policy import (
    DENIED_TOOLS,
    FIELD_STATE_DESCRIPTION,
    FIELD_STATE_SCHEMA,
    FIELD_STATE_TOOL,
    FILL_ATTEMPTED,
    FILL_DONE,
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
    fill_targets,
    has_tokens,
    page_host,
    rewrite_fill_args,
    scrub_result_text,
    secret_fill_to_type,
    strip_file_output,
)
from .browser_probe import (
    ARIA_REF,
    MAIN_FRAME_REF,
    RUN_CODE_TOOL,
    MaskPlan,
    check_target,
    field_state_code,
    form_target_code,
    frame_chain_code,
    masked_screenshot_code,
    result_json,
)
from .credential_repair import REPAIR_DESCRIPTION, REPAIR_PURPOSE, REPAIR_SCHEMA, REPAIR_TOOL, repair_scoped
from .constants import USE_FILL
from .errors import GateError, PolicyViolation, ValidationError
from .pii import find_pii
from .policy import SecretPayload
from .redact import redact
from .resolver import Resolver
from .tokens import make_token
from .transfer import TransferGrant, legend, seal_matches, show_sealed

WITHHELD = "done (details withheld by secret-gate; call browser_snapshot to see the page)"
SCREENSHOT_NOTE = (" Behind secret-gate: filled or sealed values, password fields and personal data shown on the page "
                   "are masked in the image; the screenshot is refused when the masking cannot be verified.")
FIELD_STATES = frozenset({"empty", "nonempty", "unknown"})


class Downstream(Protocol):
    async def list_tools(self) -> Sequence[types.Tool]: ...

    async def call_tool(self, name: str, args: dict[str, Any]) -> types.CallToolResult: ...


def sweep_output_dir(out_dir: Path | None) -> None:
    """Delete whatever the downstream persisted (unredacted snapshots, console/network logs, captures)."""
    if out_dir is None or not out_dir.is_dir():
        return
    for entry in out_dir.iterdir():
        if entry.is_file() or entry.is_symlink():
            entry.unlink(missing_ok=True)


class BrowserGate:
    def __init__(
        self,
        resolver: Resolver,
        downstream: Downstream,
        output_dir: Path | None = None,
        *,
        transfer: TransferGrant | None = None,
        public_key: bytes | None = None,
        mask: MaskConfig = MaskConfig(),
        audit: Audit | None = None,
    ) -> None:
        if transfer is not None and (resolver.scope is None or public_key is None):
            raise ValidationError("a transfer grant needs an execution scope and the gate's public key")
        self._resolver = resolver
        self._down = downstream
        self._output_dir = output_dir
        self._transfer = transfer
        self._public_key = public_key
        self._mask = mask
        self._audit = audit or Audit(None)
        self._state = GateState()
        self._lock = asyncio.Lock()  # URL probe + fill must not interleave with other calls

    @property
    def state(self) -> GateState:
        return self._state

    async def list_tools(self) -> list[types.Tool]:
        tools = [
            t.model_copy(update={"inputSchema": strip_file_output(t.inputSchema), "outputSchema": None,
                                 **({"description": (t.description or "") + SCREENSHOT_NOTE} if t.name == SCREENSHOT_TOOL else {})})
            for t in await self._down.list_tools()
            if t.name not in DENIED_TOOLS
        ]
        tools.append(types.Tool(name=SECRET_FILL_TOOL, description=SECRET_FILL_DESCRIPTION, inputSchema=SECRET_FILL_SCHEMA))
        tools.append(types.Tool(name=FIELD_STATE_TOOL, description=FIELD_STATE_DESCRIPTION, inputSchema=FIELD_STATE_SCHEMA))
        tools.append(types.Tool(name=REPAIR_TOOL, description=REPAIR_DESCRIPTION, inputSchema=REPAIR_SCHEMA))
        return tools

    async def call_tool(self, name: str, args: dict[str, Any]) -> list[types.ContentBlock]:
        async with self._lock:
            try:
                return await self._call(name, args)
            except GateError as exc:
                reason = self._shown(str(exc)) or "refused"
                self._audit.record("refused", tool=name, reason=reason)
                hint = ""
                if isinstance(exc, PolicyViolation) and "does not allow use 'http'" in str(exc):
                    hint = (" If the original task explicitly authorizes importing this TOTP seed into this same host, "
                            "request secret_repair(token, host, purpose='totp_seed_import'). The original token must "
                            "already grant seed import; otherwise ask for the field and destination in a new message. "
                            "Do not change hosts, keep retrying the fill, or substitute a code for the seed.")
                raise RuntimeError(f"secret-gate: {reason}{hint}") from None
            except Exception as exc:  # noqa: BLE001 - never let a downstream message carry a value back
                raise RuntimeError(self._shown(str(exc)) or "browser error") from None
            finally:
                sweep_output_dir(self._output_dir)

    async def _call(self, name: str, args: dict[str, Any]) -> list[types.ContentBlock]:
        if name == REPAIR_TOOL:
            if set(args) - {"token", "host", "purpose"}:
                raise PolicyViolation("credential repair request has unexpected fields")
            result = await repair_scoped(self._resolver, args.get("token"), args.get("host"), args.get("purpose", REPAIR_PURPOSE))
            self._audit.record("repair", host=args.get("host"), label=result.get("label"))
            return [types.TextContent(type="text", text=json.dumps(result))]
        if name == FIELD_STATE_TOOL:
            if set(args) - {"target", "element"}:
                raise PolicyViolation(f"{FIELD_STATE_TOOL} takes only target and element")
            state = await self._field_state(check_target(args.get("target")), await self._current_url())
            return [types.TextContent(type="text", text=json.dumps(state))]
        report_state = name == SECRET_FILL_TOOL
        if report_state:
            name, args = "browser_type", secret_fill_to_type(args)
        check_call_allowed(name, args, self._state)
        if name == SCREENSHOT_TOOL:
            return await self._screenshot(args)
        if has_tokens(name, args):
            url = await self._current_url()
            result = await self._fill(name, args, url)
            blocks = await self._finish(name, result)
            if report_state:
                state = await self._field_state(args["target"], url)
                blocks.append(types.TextContent(type="text", text="### Field state\n" + json.dumps(state)))
            return blocks
        return await self._finish(name, await self._down.call_tool(name, args))

    # -- fills ---------------------------------------------------------------

    async def _fill(self, name: str, args: dict[str, Any], url: str) -> types.CallToolResult:
        targets = fill_targets(name, args)
        hosts = await self._frame_hosts(targets, url)
        new_args, resolutions = rewrite_fill_args(
            name, args, lambda text: self._resolver.substitute(text, use=USE_FILL, host=hosts[0]))
        for host in hosts[1:]:  # an allowed iframe inside a page the token does not allow is refused too
            for r in resolutions:
                self._resolver.resolve(r.token, use=USE_FILL, host=host)
        sealed_refs = {r.token for r in self._state.sealed}
        if any(r.token in sealed_refs for r in resolutions):
            await self._check_form_targets(targets)
        # Taint before the call: even a failed type() may have left the value in the DOM.
        self._state = self._state.with_fill(url, resolutions).with_fill_status(url, targets, FILL_ATTEMPTED)
        result = await self._down.call_tool(name, new_args)
        if not result.isError:
            self._state = self._state.with_fill_status(url, targets, FILL_DONE)
        self._audit.record("fill", host=page_host(url), labels=sorted({r.label for r in resolutions}),
                           targets=list(targets), ok=not result.isError)
        return result

    async def _frame_hosts(self, targets: tuple[str, ...], url: str) -> tuple[str, ...]:
        """host:port of the targets' own frame and of every frame above it, innermost first. Main-frame refs (e12)
        are on `url` by construction; frame refs (f1e2) and selectors, which may enter a frame, are asked of
        Playwright. A frame without an http(s) URL (about:srcdoc, data:) refuses the fill."""
        if not targets:
            raise PolicyViolation("a fill needs a target element")
        chains = set()
        for target in targets:
            if MAIN_FRAME_REF.match(target):
                chains.add((page_host(url),))
                continue
            found = await self._probe(frame_chain_code(target))
            urls = found.get("urls") if isinstance(found, dict) else None
            if not isinstance(urls, list) or not urls or not all(isinstance(u, str) for u in urls):
                raise PolicyViolation("could not tell which frame this field is in; use the element ref from browser_snapshot")
            chains.add(tuple(page_host(u) for u in urls))
        if len(chains) != 1:
            raise PolicyViolation("these fields are in different frames; fill one frame per call")
        return chains.pop()

    async def _check_form_targets(self, targets: tuple[str, ...]) -> None:
        """Sealed page data may be typed only into a form that submits to a granted destination."""
        assert self._transfer is not None  # sealed values exist only under a grant
        for target in targets:
            found = await self._probe(form_target_code(target))
            actions = found.get("actions") if isinstance(found, dict) else None
            if not isinstance(actions, list):
                raise PolicyViolation("could not determine where this field's form submits; refused")
            for action in actions:
                try:
                    destination = page_host(str(action))
                except PolicyViolation:
                    raise PolicyViolation("this form submits to a non-http target; sealed page data refused") from None
                if not self._transfer.allows_destination(destination):
                    raise PolicyViolation(f"this form submits to {destination}, which the transfer grant does not name; refused")

    async def _field_state(self, target: str, url: str) -> dict[str, Any]:
        try:
            current = await self._probe(field_state_code(target))
        except GateError:
            current = "unknown"
        attempted, filled = self._state.fill_history(url, target)
        return {"target": target, "current": current if current in FIELD_STATES else "unknown",
                "attempted": attempted, "filled": filled}

    # -- screenshots ----------------------------------------------------------

    async def _screenshot(self, args: dict[str, Any]) -> list[types.ContentBlock]:
        snapshot = _texts(await self._down.call_tool(SNAPSHOT_TOOL, {}))
        url = await self._current_url()
        host = _host_or_none(url)
        findings = sensitive_refs(snapshot, [r.value for r in self._state.protected], self._mask.kinds)
        regions = self._mask.selectors_for(host) if host else ()
        history = tuple(t for t in self._state.filled_targets(url) if ARIA_REF.match(t))
        if not (findings.refs or findings.unmapped or regions or history or self._state.protected):
            return await self._finish(SCREENSHOT_TOOL, await self._down.call_tool(SCREENSHOT_TOOL, args))
        if findings.unmapped:
            raise PolicyViolation("screenshot refused: sensitive text on this page has no element to mask; use browser_snapshot")
        if self._output_dir is None:
            raise PolicyViolation("screenshot refused: no private directory to verify the masked image")
        selectors = (PASSWORD_SELECTOR, *regions, *((CANVAS_SELECTOR,) if url in self._state.tainted_urls else ()))
        path = self._output_dir / f"secret-gate-mask-{secrets.token_hex(8)}.png"
        plan = MaskPlan(refs=tuple(dict.fromkeys(findings.refs + history)), selectors=selectors, path=str(path),
                        full_page=bool(args.get("fullPage")), target=args.get("target"), color=MASK_COLOR)
        data = await self._probe(masked_screenshot_code(plan))
        try:
            if not isinstance(data, dict) or "error" in data:
                raise ValueError("masked capture failed")
            boxes = parse_boxes(data.get("boxes"))
            png = path.read_bytes()
            uncovered = uncovered_boxes(png, boxes)
        except (OSError, ValueError, ValidationError):
            raise PolicyViolation("screenshot refused: the masked capture could not be verified") from None
        if uncovered:
            raise PolicyViolation(f"screenshot refused: {len(uncovered)} masked region(s) were not covered in the image")
        self._audit.record("screenshot", host=host, masked=len(boxes))
        note = f"secret-gate masked {len(boxes)} region(s) (filled or sealed values, password fields, personal data)."
        return [types.ImageContent(type="image", data=base64.b64encode(png).decode("ascii"), mimeType="image/png"),
                types.TextContent(type="text", text=note)]

    # -- results --------------------------------------------------------------

    async def _finish(self, name: str, result: types.CallToolResult) -> list[types.ContentBlock]:
        if self._transfer is not None:  # error text too: Playwright errors quote element HTML
            await self._seal("\n".join(b.text for b in result.content if isinstance(b, types.TextContent)))
        blocks = [self._redact_block(name, b) for b in result.content]
        if result.isError:
            message = "\n".join(b.text for b in blocks if isinstance(b, types.TextContent)) or "browser error"
            raise RuntimeError(message)
        shown = [r for r in self._state.sealed if any(isinstance(b, types.TextContent) and r.token in b.text for b in blocks)]
        if shown and self._transfer is not None:
            blocks.append(types.TextContent(type="text", text=legend(tuple(shown), self._transfer)))
        return blocks

    async def _seal(self, text: str) -> None:
        """Values of the granted kinds on a source page become references before the model sees them."""
        assert self._transfer is not None
        known = {r.value for r in self._state.sealed}
        if not any(m.value not in known for m in find_pii(text, self._transfer.fields)):
            return
        url = await self._current_url()
        host = _host_or_none(url)
        if host is None or not self._transfer.is_source(host):
            return
        fresh = seal_matches(text, self._transfer, self._state.sealed, self._mint)
        self._state = self._state.with_sealed(url, fresh)
        self._audit.record("seal", source=host, destination=list(self._transfer.destination),
                           labels=[r.label for r in fresh], refs=[r.token for r in fresh])

    def _mint(self, payload: SecretPayload) -> str:
        assert self._public_key is not None
        return self._resolver.register(make_token(self._public_key, payload))

    def _redact_block(self, name: str, block: types.ContentBlock) -> types.ContentBlock:
        if isinstance(block, types.TextContent):
            scrubbed = scrub_result_text(name, block.text)
            if block.text.strip() and not scrubbed.strip():
                scrubbed = WITHHELD
            return types.TextContent(type="text", text=self._shown(scrubbed) or "")
        if isinstance(block, types.ImageContent) and name == SCREENSHOT_TOOL:
            return block  # only reachable when nothing on the page needs masking
        return types.TextContent(type="text", text="[content omitted by secret-gate]")

    def _shown(self, text: str | None) -> str | None:
        """Sealed values become their references; filled values become [REDACTED:label]."""
        if text is None:
            return None
        return redact(show_sealed(text, self._state.sealed), self._state.filled)

    # -- probes ---------------------------------------------------------------

    async def _probe(self, code: str) -> Any:
        result = await self._down.call_tool(RUN_CODE_TOOL, {"code": code})
        if result.isError:
            raise PolicyViolation("the browser could not run the gate's check; refused")
        return result_json(_texts(result))

    async def _current_url(self) -> str:
        probe = await self._down.call_tool(HREF_PROBE_TOOL, {"function": HREF_PROBE_FUNCTION})
        if probe.isError:
            raise PolicyViolation("could not determine the current page URL; refused")
        return extract_href(_texts(probe))


def _host_or_none(url: str) -> str | None:
    try:
        return page_host(url)
    except PolicyViolation:
        return None


def _texts(result: types.CallToolResult) -> str:
    return "\n".join(c.text for c in result.content if isinstance(c, types.TextContent))
