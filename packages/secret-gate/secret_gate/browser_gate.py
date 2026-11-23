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
from .browser_mask import (
    CANVAS_SELECTOR,
    MASK_COLOR,
    PASSWORD_SELECTOR,
    MaskConfig,
    parse_boxes,
    sensitive_refs,
    uncovered_boxes,
)
from .browser_policy import (
    DENIED_TOOLS,
    FIELD_STATE_DESCRIPTION,
    FIELD_STATE_SCHEMA,
    FIELD_STATE_TOOL,
    FILL_ATTEMPTED,
    FILL_DONE,
    FILLED_PAGE_TOOLS,
    FIND_TOOL,
    HREF_PROBE_FUNCTION,
    HREF_PROBE_TOOL,
    SCREENSHOT_TOOL,
    SECRET_FILL_DESCRIPTION,
    SECRET_FILL_SCHEMA,
    SECRET_FILL_TOOL,
    SNAPSHOT_TOOL,
    GateState,
    check_call_allowed,
    check_filled_page,
    extract_href,
    find_in_snapshot,
    has_tokens,
    hide_field_values,
    page_host,
    scrub_result_text,
    secret_fill_to_type,
    strip_file_output,
)
from .browser_probe import (
    ARIA_REF,
    RUN_CODE_TOOL,
    MaskPlan,
    check_target,
    field_state_code,
    fill_code,
    form_target_code,
    frame_chain_code,
    masked_screenshot_code,
    result_json,
)
from .constants import REDACTED_FORMAT, USE_FILL
from .errors import GateError, PolicyViolation, ValidationError
from .pii import find_pii
from .policy import SecretPayload
from .redact import redact, redact_base64, withheld
from .remote_resolver import GateResolver
from .tokens import find_secrets, make_token
from .transfer import TransferGrant, legend, seal_matches, show_sealed

WITHHELD = "done (details withheld by secret-gate; call browser_snapshot to see the page)"
SCREENSHOT_NOTE = (" Behind secret-gate: filled or sealed values, password fields and personal data shown on the page "
                   "are masked in the image; the screenshot is refused when the masking cannot be verified.")
FIELD_STATES = frozenset({"empty", "nonempty", "unknown"})
# The fill template's verdicts (browser_probe.fill_code); anything else is reported as a plain failure.
FILL_ERRORS = {
    "target is not exactly one element": "the fill was not done: the ref matches no element now; take a new snapshot",
    "target has no frame": "the fill was not done: the element is not in a page now; take a new snapshot",
    "the page changed": "the fill was not done: the page changed while the gate checked it; take a new snapshot and try again",
    "not a text field": "the fill was not done: a token can only be typed into a text input or textarea",
    "the field is not editable": "the fill was not done: the field is disabled or read-only",
}


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
        resolver: GateResolver,
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
        return tools

    async def call_tool(self, name: str, args: dict[str, Any]) -> list[types.ContentBlock]:
        async with self._lock:
            try:
                return await self._call(name, args)
            except GateError as exc:
                reason = self._shown(str(exc)) or "refused"
                self._audit.record("refused", tool=name, reason=reason)
                raise RuntimeError(f"secret-gate: {reason}") from None
            except Exception as exc:  # noqa: BLE001 - never let a downstream message carry a value back
                raise RuntimeError(self._shown(str(exc)) or "browser error") from None
            finally:
                sweep_output_dir(self._output_dir)

    async def _call(self, name: str, args: dict[str, Any]) -> list[types.ContentBlock]:
        if name == FIELD_STATE_TOOL:
            if set(args) - {"target", "element"}:
                raise PolicyViolation(f"{FIELD_STATE_TOOL} takes only target and element")
            target = check_target(args.get("target"))
            check_call_allowed(FIELD_STATE_TOOL, {"target": target}, self._state)  # it selects like any other tool
            state = await self._field_state(target, await self._current_url())
            return [types.TextContent(type="text", text=json.dumps(state))]
        report_state = name == SECRET_FILL_TOOL
        if report_state:
            name, args = "browser_type", secret_fill_to_type(args)
        check_call_allowed(name, args, self._state)
        if name == SCREENSHOT_TOOL:
            return await self._screenshot(args)
        if has_tokens(name, args):
            blocks, url, target = await self._fill(name, args)
            if report_state:
                state = await self._field_state(target, url)
                blocks.append(types.TextContent(type="text", text="### Field state\n" + json.dumps(state)))
            return blocks
        if self._state.fills and name in FILLED_PAGE_TOOLS:
            check_filled_page(name, args, self._state, await self._current_url())
        if name == FIND_TOOL and self._state.protected and isinstance(args.get("text"), str) and args["text"]:
            return await self._find(args["text"])
        return await self._finish(name, await self._down.call_tool(name, args))

    # -- fills ---------------------------------------------------------------

    async def _fill(self, name: str, args: dict[str, Any]) -> tuple[list[types.ContentBlock], str, str]:
        """Type the values behind tokens: each field by ref, its frame chain allowed, then written by the gate's fill
        template, which re-checks that chain in the same call (security review 2026-11-23, M2). Plain fields of the
        same browser_fill_form go to Playwright as usual. Returns the result, the page and the last field filled."""
        if args.get("slowly"):
            raise PolicyViolation("secret-gate types a token's value in one step; omit slowly")
        writes, plain = _token_writes(name, args)
        for target, _ in writes:
            if not isinstance(target, str) or not ARIA_REF.fullmatch(target):
                raise PolicyViolation("a token is typed only into an element ref from browser_snapshot (e12, f1e3); "
                                      "take a snapshot and use the field's ref")
        chains = [await self._frame_chain(target) for target, _ in writes]
        if len({tuple(page_host(u) for u in chain) for chain in chains}) != 1:
            raise PolicyViolation("these fields are in different frames; fill one frame per call")
        hosts = tuple(page_host(u) for u in chains[0])
        url = chains[0][-1]  # the top page
        planned = []
        for (target, text), chain in zip(writes, chains):
            value, resolutions = self._resolver.substitute(text, use=USE_FILL, host=hosts[0])
            for host in hosts[1:]:  # an allowed iframe inside a page the token does not allow is refused too
                for r in resolutions:
                    self._resolver.resolve(r.token, use=USE_FILL, host=host)
            planned.append((target, list(chain), value, resolutions))
        resolved = tuple(r for *_, rs in planned for r in rs)
        sealed_refs = {r.token for r in self._state.sealed}
        if any(r.token in sealed_refs for r in resolved):
            await self._check_form_targets(tuple(t for t, *_ in planned))
        if plain and self._state.fills:
            check_filled_page("browser_fill_form", {"fields": plain}, self._state, url)
        # Taint before the write: even a failed one may have left the value in the DOM.
        self._state = self._state.with_fill(url, resolved)
        for target, _, _, resolutions in planned:
            self._state = self._state.with_fill_status(url, (target,), FILL_ATTEMPTED, self._shown_for(resolutions))
        done: list[str] = []
        try:
            for i, (target, chain, value, resolutions) in enumerate(planned):
                submit = bool(args.get("submit")) and i == len(planned) - 1
                found = await self._probe(fill_code(target, chain, value, submit))
                if not isinstance(found, dict) or found.get("ok") is not True:
                    error = found.get("error") if isinstance(found, dict) else None
                    raise PolicyViolation(FILL_ERRORS.get(error, "the fill was not done; take a new snapshot and try again")
                                          if isinstance(error, str) else "the fill was not done; take a new snapshot and try again")
                self._state = self._state.with_fill_status(url, (target,), FILL_DONE, self._shown_for(resolutions))
                done.append(target)
        finally:
            self._audit.record("fill", host=page_host(url), labels=sorted({r.label for r in resolved}),
                               targets=[t for t, *_ in planned], ok=len(done) == len(planned))
        note = f"### Result\nsecret-gate typed the value into {', '.join(done)} (the value is withheld)."
        if args.get("submit"):
            note += " Enter was pressed; call browser_snapshot to see the page."
        blocks: list[types.ContentBlock] = [types.TextContent(type="text", text=note)]
        if plain:
            blocks += await self._finish(name, await self._down.call_tool(name, {**args, "fields": plain}))
        return blocks, url, planned[-1][0]

    async def _frame_chain(self, target: str) -> tuple[str, ...]:
        """URLs of the target's own frame and of every frame above it, innermost first, as Playwright tracks them.
        Asked for every ref, main-frame ones too (the fill template compares the same chain when it writes). A frame
        without an http(s) URL (about:srcdoc, data:) refuses the fill."""
        found = await self._probe(frame_chain_code(target))
        urls = found.get("urls") if isinstance(found, dict) else None
        if not isinstance(urls, list) or not urls or not all(isinstance(u, str) for u in urls):
            raise PolicyViolation("could not tell which frame this field is in; take a new snapshot and use its ref")
        for u in urls:
            page_host(u)
        return tuple(urls)

    async def _find(self, text: str) -> list[types.ContentBlock]:
        """browser_find answered from the gate's redacted snapshot (find_in_snapshot)."""
        blocks = await self._finish(SNAPSHOT_TOOL, await self._down.call_tool(SNAPSHOT_TOOL, {}))
        shown = "\n".join(b.text for b in blocks if isinstance(b, types.TextContent))
        return [types.TextContent(type="text", text=find_in_snapshot(shown, text))]

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
        history = tuple(t for t in self._state.filled_targets(url) if ARIA_REF.fullmatch(t))
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
        """Sealed values become their references; a field the gate filled shows [REDACTED:label] whatever it holds now;
        filled values in any encoding or case, and every 4-character fragment of one, become [REDACTED:label]
        (redact.Redactor); a text the redactor fails on is withheld whole."""
        if text is None:
            return None
        try:
            shown = hide_field_values(show_sealed(text, self._state.sealed), self._state.filled_refs(), self._state.filled)
            return redact_base64(redact(shown, self._state.filled), self._state.protected)
        except Exception:  # noqa: BLE001 - fail closed (gate-simple-v0 §3.2): nothing of a text that could not be redacted
            return withheld("result", "it could not be redacted")

    def _shown_for(self, resolutions: Sequence[Any]) -> str:
        """What a filled field shows instead of its value: a sealed value's reference (as the page text it came from
        shows it), otherwise [REDACTED:label]."""
        sealed = {r.token for r in self._state.sealed}
        shown = dict.fromkeys(r.token if r.token in sealed else REDACTED_FORMAT.format(label=r.label) for r in resolutions)
        return " ".join(shown) or REDACTED_FORMAT.format(label="filled")

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


def _token_writes(name: str, args: dict[str, Any]) -> tuple[list[tuple[Any, str]], list[Any]]:
    """(target, text) of every field whose text carries a token, and the other fields of a browser_fill_form."""
    if name == "browser_type":
        return [(args.get("target"), args["text"])], []
    writes, plain = [], []
    for field in args.get("fields") or []:
        value = field.get("value") if isinstance(field, dict) else None
        if isinstance(value, str) and find_secrets(value):
            if field.get("type", "textbox") != "textbox":
                raise PolicyViolation("a token can only be typed into a textbox field")
            writes.append((field.get("target"), value))
        else:
            plain.append(field)
    return writes, plain


def _host_or_none(url: str) -> str | None:
    try:
        return page_host(url)
    except PolicyViolation:
        return None


def _texts(result: types.CallToolResult) -> str:
    return "\n".join(c.text for c in result.content if isinstance(c, types.TextContent))
