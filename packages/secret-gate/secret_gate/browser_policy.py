"""Rules for gating a browser MCP server (Playwright MCP) so plaintext never reaches the model.

Pure functions and immutable state; the async orchestration lives in browser_gate.py.

Threat model: after `secret_fill`, the real value sits in the page DOM. Anything that lets the
model read the DOM other than through our redaction is blocked: JS evaluation, model-authored
pages (`data:` URLs) that could receive a pasted copy, copy/cut chords, uploading Playwright's own
unredacted output files, saving results to files, unmasked screenshots of a page holding a value,
and substring oracles (find / wait_for / text selectors) against filled values. Page values sealed
under a transfer grant (transfer.py) are protected exactly like filled values.
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable
from dataclasses import dataclass, replace
from typing import Any
from urllib.parse import urlsplit

from .constants import USE_FILL
from .errors import PolicyViolation, ValidationError
from .resolver import Resolution, Resolver
from .tokens import find_secrets, is_secret

# Tools that could hand the model a transformed copy of a filled value. Never exposed.
DENIED_TOOLS = frozenset({"browser_evaluate", "browser_run_code_unsafe"})
# Tools whose text arguments may carry enc:v1 tokens to be substituted.
FILL_TOOLS = frozenset({"browser_type", "browser_fill_form"})
SCREENSHOT_TOOL = "browser_take_screenshot"
SNAPSHOT_TOOL = "browser_snapshot"
URL_TOOLS = frozenset({"browser_navigate", "browser_tabs"})
KEY_TOOL = "browser_press_key"
FILE_OUTPUT_ARG = "filename"  # writes an unredacted file: blocked
FILE_INPUT_ARG = "paths"  # would upload Playwright's unredacted output files: blocked
ORACLE_ARGS = ("text", "textGone", "regex", "target", "startTarget", "endTarget")
REGEX_ARGS = ("regex", "filter")  # browser_find, browser_network_requests
# Selector engines that match on text or leave CSS: with a protected value on the page they are search oracles.
TEXT_SELECTOR = re.compile(r"text|internal:|getby|>>|xpath|:has\(|:is\(|/", re.IGNORECASE)
_ARIA_REF = re.compile(r"^(?:f\d+)?e\d+$")
ORACLE_NGRAM = 4  # a probe sharing this many consecutive chars with a filled value is refused
COPY_KEYS = frozenset({"c", "x", "insert"})
CHORD_MODIFIERS = frozenset({"meta", "control", "ctrl", "controlormeta"})
SECRET_FILL_TOOL = "secret_fill"
FIELD_STATE_TOOL = "secret_field_state"
HREF_PROBE_TOOL = "browser_evaluate"
HREF_PROBE_FUNCTION = "() => location.href"
RESULT_HEADER = "### Result"
CODE_HEADER = "### Ran Playwright code"
_SECTION = re.compile(r"^### ", re.MULTILINE)
_OUTPUT_LINK = re.compile(r"^\s*- \[[^\]]*\]\((?:\.{0,2}/|/)[^)]*\)\s*$", re.MULTILINE)

SECRET_FILL_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "target": {"type": "string", "description": "Element ref from the page snapshot, or a unique selector"},
        "token": {"type": "string", "description": "enc:v1: token or enc:ref: reference whose real value should be typed"},
        "element": {"type": "string", "description": "Human-readable element description"},
        "submit": {"type": "boolean", "description": "Press Enter after filling"},
    },
    "required": ["target", "token"],
    "additionalProperties": False,
}
SECRET_FILL_DESCRIPTION = (
    "Type the real value behind an enc:v1: token or enc:ref: reference into a page element. The value is "
    "decrypted by the gate only if the token allows the current page's host; you never see it. Use this (or "
    "browser_type/browser_fill_form with the token as the text) for password, code and username fields. "
    "The result reports the field's current state (empty/nonempty/unknown) without its value."
)
FIELD_STATE_SCHEMA: dict[str, Any] = {
    "type": "object",
    "properties": {
        "target": {"type": "string", "description": "Element ref from the page snapshot, or a unique selector"},
        "element": {"type": "string", "description": "Human-readable element description"},
    },
    "required": ["target"],
    "additionalProperties": False,
}
FIELD_STATE_DESCRIPTION = (
    "Check a form field without reading its value: `current` is empty, nonempty or unknown (read from the "
    "page now); `attempted` / `filled` say whether secret-gate tried or completed a fill of this field on this "
    "page. A fill does not prove the site saved the value; submit and confirm on the page."
)
FILL_ATTEMPTED = "attempted"
FILL_DONE = "filled"


@dataclass(frozen=True)
class FillRecord:
    url: str
    target: str
    status: str  # FILL_ATTEMPTED until the browser call returned without error


@dataclass(frozen=True)
class GateState:
    """What the gate remembers across tool calls. Replaced, never mutated."""

    filled: tuple[Resolution, ...] = ()
    tainted_urls: frozenset[str] = frozenset()  # pages that held a filled value (history restores it)
    sealed: tuple[Resolution, ...] = ()  # page values sealed under a transfer grant; `token` is the reference
    fills: tuple[FillRecord, ...] = ()

    @property
    def protected(self) -> tuple[Resolution, ...]:
        """Every value that must not reach the model: filled by the gate or sealed from a page."""
        return self.filled + self.sealed

    def with_fill(self, url: str, resolutions: tuple[Resolution, ...]) -> GateState:
        known = {r.value for r in self.filled}
        fresh = tuple(r for r in resolutions if r.value not in known)
        return replace(self, filled=self.filled + fresh, tainted_urls=self.tainted_urls | {url})

    def with_sealed(self, url: str, resolutions: tuple[Resolution, ...]) -> GateState:
        known = {r.value for r in self.sealed}
        fresh = tuple(r for r in resolutions if r.value not in known)
        return replace(self, sealed=self.sealed + fresh, tainted_urls=self.tainted_urls | {url})

    def with_fill_status(self, url: str, targets: tuple[str, ...], status: str) -> GateState:
        kept = tuple(f for f in self.fills if not (f.url == url and f.target in targets))
        return replace(self, fills=kept + tuple(FillRecord(url, t, status) for t in targets))

    def fill_history(self, url: str, target: str) -> tuple[bool, bool]:
        """(attempted, filled) for this target on this page."""
        record = next((f for f in self.fills if f.url == url and f.target == target), None)
        return (record is not None, record is not None and record.status == FILL_DONE)

    def filled_targets(self, url: str) -> tuple[str, ...]:
        return tuple(f.target for f in self.fills if f.url == url)


def page_host(url: str) -> str:
    """'https://a.example.com/x' -> 'a.example.com:443' (port-aware, like the proxy)."""
    parts = urlsplit(url)
    if parts.scheme not in ("http", "https") or not parts.hostname:
        # Scheme only: the rest of a URL can carry values (a GET form puts them in the query).
        raise PolicyViolation(f"cannot fill on a non-http page ({parts.scheme or 'no scheme'}:)")
    try:
        port = parts.port
    except ValueError:
        raise PolicyViolation(f"cannot fill on a page with an invalid port ({parts.hostname})") from None
    return f"{parts.hostname}:{port or (443 if parts.scheme == 'https' else 80)}"


def extract_href(probe_text: str) -> str:
    """The JSON string in the `### Result` section of browser_evaluate('() => location.href')."""
    _, sep, rest = probe_text.partition(RESULT_HEADER)
    if not sep:
        raise PolicyViolation("could not determine the current page URL; fill refused")
    section = _SECTION.split(rest, maxsplit=1)[0]
    line = next((ln.strip() for ln in section.splitlines() if ln.strip()), "")
    try:
        href = json.loads(line)
    except json.JSONDecodeError:
        href = None
    if not isinstance(href, str) or not href:
        raise PolicyViolation("could not determine the current page URL; fill refused")
    return href


def strip_file_output(schema: dict[str, Any]) -> dict[str, Any]:
    """Advertise tool schemas without the file-output argument (its use is refused anyway)."""
    props = schema.get("properties")
    if not isinstance(props, dict) or FILE_OUTPUT_ARG not in props:
        return schema
    new_props = {k: v for k, v in props.items() if k != FILE_OUTPUT_ARG}
    required = [r for r in schema.get("required", []) if r != FILE_OUTPUT_ARG]
    return {**schema, "properties": new_props, "required": required}


def check_call_allowed(name: str, args: dict[str, Any], state: GateState) -> None:
    """Static refusals plus the ones that only apply once a value has been filled."""
    if name in DENIED_TOOLS:
        raise PolicyViolation(f"{name} is disabled behind secret-gate (it could expose filled values)")
    if args.get(FILE_OUTPUT_ARG):
        raise PolicyViolation(f"{name}: writing results to a file bypasses redaction; omit {FILE_OUTPUT_ARG}")
    if args.get(FILE_INPUT_ARG):
        raise PolicyViolation(f"{name}: uploading local files is disabled behind secret-gate")
    if name in URL_TOOLS:
        _check_url_scheme(args.get("url"))
    if state.protected:
        _check_copy_chord(name, args)
        _check_oracle(args, state.protected)


def _check_url_scheme(url: Any) -> None:
    if url is None or url == "":
        return
    scheme = urlsplit(str(url)).scheme.lower()
    if scheme not in ("http", "https") and str(url) != "about:blank":
        raise PolicyViolation(f"only http(s) pages may be opened behind secret-gate, not {url!r}")


def _check_copy_chord(name: str, args: dict[str, Any]) -> None:
    if name != KEY_TOOL:
        return
    parts = [p.strip().lower() for p in str(args.get("key", "")).split("+")]
    if len(parts) > 1 and parts[-1] in COPY_KEYS and set(parts[:-1]) & CHORD_MODIFIERS:
        raise PolicyViolation("copy/cut shortcuts are disabled while a filled value is on a page")


def _probes(args: dict[str, Any]) -> list[tuple[str, str]]:
    """(argument, text) pairs that search or select, including every field target of browser_fill_form."""
    found = [(key, args[key]) for key in ORACLE_ARGS if isinstance(args.get(key), str)]
    fields = args.get("fields")
    if isinstance(fields, list):
        found += [("target", f["target"]) for f in fields if isinstance(f, dict) and isinstance(f.get("target"), str)]
    return found


def _check_oracle(args: dict[str, Any], filled: tuple[Resolution, ...]) -> None:
    for key in REGEX_ARGS:
        if isinstance(args.get(key), str) and args[key]:
            raise PolicyViolation(f"{key} search is disabled while a filled value is on a page")
    for key, probe in _probes(args):
        if any(_shares_ngram(probe, r.value) for r in filled):
            raise PolicyViolation(f"{key!r} matches part of a filled value; refused")
        if key.lower().endswith("target") and not _ARIA_REF.match(probe) and TEXT_SELECTOR.search(probe):
            raise PolicyViolation(f"{key!r}: text or path selectors are disabled while a filled value is on a page; "
                                  "use the element ref from browser_snapshot")


def _shares_ngram(probe: str, value: str) -> bool:
    """Case-insensitive, like Playwright's text matching."""
    probe, value = probe.casefold(), value.casefold()
    return any(value[i : i + ORACLE_NGRAM] in probe for i in range(len(value) - ORACLE_NGRAM + 1))


def secret_fill_to_type(args: dict[str, Any]) -> dict[str, Any]:
    """secret_fill(target, token, element?, submit?) -> browser_type arguments."""
    target = args.get("target")
    token = args.get("token")
    if not isinstance(target, str) or not target:
        raise ValidationError("secret_fill: target is required")
    if not is_secret(token):
        raise ValidationError("secret_fill: token must be exactly one enc:v1: token or enc:ref: reference")
    element = args.get("element")
    out: dict[str, Any] = {
        "target": target,
        "text": token.strip(),
        "element": element if isinstance(element, str) and element else "secret field",
    }
    if args.get("submit"):
        out["submit"] = True
    return out


def fillable_texts(name: str, args: dict[str, Any]) -> tuple[str, ...]:
    if name == "browser_type" and isinstance(args.get("text"), str):
        return (args["text"],)
    if name == "browser_fill_form" and isinstance(args.get("fields"), list):
        return tuple(f["value"] for f in args["fields"] if isinstance(f, dict) and isinstance(f.get("value"), str))
    return ()


def fill_targets(name: str, args: dict[str, Any]) -> tuple[str, ...]:
    if name == "browser_type" and isinstance(args.get("target"), str):
        return (args["target"],)
    if name == "browser_fill_form" and isinstance(args.get("fields"), list):
        return tuple(f["target"] for f in args["fields"] if isinstance(f, dict) and isinstance(f.get("target"), str))
    return ()


def has_tokens(name: str, args: dict[str, Any]) -> bool:
    """True when the typed text carries a token or reference; one anywhere else is refused outright."""
    if name not in FILL_TOOLS:
        return False
    others = {k: v for k, v in args.items() if k not in ("text", "fields")}
    if find_secrets(json.dumps(others, ensure_ascii=False)):
        raise PolicyViolation(f"{name}: an enc:v1: token or enc:ref: reference may only appear in the typed text")
    return any(find_secrets(t) for t in fillable_texts(name, args))


Substitute = Callable[[str], tuple[str, tuple[Resolution, ...]]]


def rewrite_fill_args(
    name: str, args: dict[str, Any], substitute: Substitute
) -> tuple[dict[str, Any], tuple[Resolution, ...]]:
    """Return a copy of `args` with tokens in the typed text replaced, plus what was resolved."""
    if name == "browser_type":
        text = args.get("text")
        if not isinstance(text, str):
            return args, ()
        new_text, res = substitute(text)
        return {**args, "text": new_text}, res
    if name == "browser_fill_form":
        fields = args.get("fields")
        if not isinstance(fields, list):
            return args, ()
        new_fields: list[Any] = []
        collected: list[Resolution] = []
        for field in fields:
            value = field.get("value") if isinstance(field, dict) else None
            if not isinstance(value, str):
                new_fields.append(field)
                continue
            new_value, res = substitute(value)
            new_fields.append({**field, "value": new_value})
            collected.extend(res)
        return {**args, "fields": new_fields}, tuple(collected)
    return args, ()


def resolve_for_page(resolver: Resolver, url: str) -> Substitute:
    host = page_host(url)
    return lambda text: resolver.substitute(text, use=USE_FILL, host=host)


def scrub_result_text(name: str, text: str) -> str:
    """Drop what necessarily carries the value or points at unredacted files.

    The `### Ran Playwright code` echo of a fill contains the typed value JS-escaped; the
    `- [Snapshot](../path.yml)` link lines name files in the gate's private output dir.
    """
    out = text
    if name in FILL_TOOLS:
        head, sep, rest = out.partition(CODE_HEADER)
        if sep:
            remainder = _SECTION.split(rest, maxsplit=1)
            out = head + ("### " + remainder[1] if len(remainder) > 1 else "")
    return _OUTPUT_LINK.sub("", out)
