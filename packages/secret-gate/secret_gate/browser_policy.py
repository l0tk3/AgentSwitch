"""Rules for gating a browser MCP server (Playwright MCP) so plaintext never reaches the model.

Pure functions and immutable state; the async orchestration lives in browser_gate.py.

Threat model: after `secret_fill`, the real value sits in the page DOM. Anything that lets the
model read the DOM other than through our redaction is blocked: JS evaluation, model-authored
pages (`data:` URLs) that could receive a pasted copy, copy/cut chords, uploading Playwright's own
unredacted output files, saving results to files, unmasked screenshots of a page holding a value,
and substring oracles (find / wait_for / selectors) against filled values. Page values sealed
under a transfer grant (transfer.py) are protected exactly like filled values.

A filled field is also protected as an element, not only as a string (security review 2026-11-23, H1):
the model could otherwise edit it (Backspace, Delete, typing into it, dragging from it) and read the
remainder, which no longer equals the value. The gate remembers every ref it filled; text output
shows that field's value as redacted whatever it holds now (`hide_field_values`), and on a page
holding a fill the tools that could edit a field are refused (`check_filled_page`).
"""

from __future__ import annotations

import json
import re
from collections.abc import Callable, Mapping
from dataclasses import dataclass, replace
from typing import Any
from urllib.parse import urlsplit

from .browser_probe import ARIA_REF
from .constants import REDACTED_FORMAT, USE_FILL
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
TARGET_ARGS = ("target", "startTarget", "endTarget")
REGEX_ARGS = ("regex", "filter")  # browser_find, browser_network_requests
# A selector that escapes characters (CSS `\XX`, which Playwright decodes) or matches an attribute holding a value
# (`[value^=...]`, `[data-value*=...]`; React keeps `value` in sync with what was typed) can test a value bit by bit.
VALUE_SELECTOR = re.compile(r"\\|\[[^\]=]*value", re.IGNORECASE)
ORACLE_NGRAM = 4  # a probe sharing this many consecutive chars with a filled value is refused
COPY_KEYS = frozenset({"c", "x", "insert"})
CHORD_MODIFIERS = frozenset({"meta", "control", "controlormeta"})
KEY_TOOLS = frozenset({KEY_TOOL, "browser_keydown", "browser_keyup"})
# Playwright's modifier names, and the spellings a model may use for them.
_MODIFIERS = {"shift": "shift", "control": "control", "ctrl": "control", "meta": "meta", "cmd": "meta", "command": "meta",
              "os": "meta", "win": "meta", "super": "meta", "controlormeta": "controlormeta", "alt": "alt",
              "option": "alt", "opt": "alt", "altgraph": "alt"}
_KEY_ALIASES = {"del": "delete", "esc": "escape", "return": "enter", "spacebar": "space", " ": "space",
                "up": "arrowup", "down": "arrowdown", "left": "arrowleft", "right": "arrowright"}
# On a page holding a fill: keys that cannot change what a field holds. Enter submits (in a textarea it adds a line,
# which leaves the value whole).
NAVIGATION_KEYS = frozenset({"enter", "tab", "escape", "arrowup", "arrowdown", "arrowleft", "arrowright", "home", "end",
                             "pageup", "pagedown", *_MODIFIERS.values()})
# Tools that type at the focus or press the mouse where the model says: on a page holding a fill they could edit it.
FOCUS_INPUT_TOOLS = frozenset({"browser_press_sequentially", "browser_mouse_down", "browser_mouse_up",
                               "browser_mouse_drag_xy"})
# Tools that write into the element they name (a token fill goes through the gate's own fill instead).
ELEMENT_WRITE_TOOLS = frozenset({"browser_type", "browser_fill_form", "browser_select_option", "browser_drop"})
DRAG_TOOLS = frozenset({"browser_drag", "browser_drop"})
FILLED_PAGE_TOOLS = KEY_TOOLS | FOCUS_INPUT_TOOLS | ELEMENT_WRITE_TOOLS | DRAG_TOOLS
FILLED_PAGE_REFUSED = ("本页有 secret-gate 填过的字段，{what}不予执行，以免改动其中的值后读出一部分。"
                       "可以按 Enter、Tab、Shift+Tab、Escape、方向键、Home、End、PageUp、PageDown；"
                       "要重填这个字段，用 secret_fill")
# Snapshot lines of elements that show what they hold (Playwright renders an <input>/<textarea>'s value as its text).
TEXT_ENTRY_ROLES = ("textbox", "searchbox", "combobox", "spinbutton")
_ENTRY_LINE = re.compile(r"""^(?P<indent> *)- ["']?(?:""" + "|".join(TEXT_ENTRY_ROLES) + r")\b")
_REF_MARK = re.compile(r"\[ref=((?:f\d+)?e\d+)\]")
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
        "target": {"type": "string", "description": "Element ref from the page snapshot (e12, f1e3); selectors are not accepted"},
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
    shown: str = ""  # what the field shows instead of its value ([REDACTED:label], or a sealed reference)


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

    def with_fill_status(self, url: str, targets: tuple[str, ...], status: str, shown: str = "") -> GateState:
        kept = tuple(f for f in self.fills if not (f.url == url and f.target in targets))
        return replace(self, fills=kept + tuple(FillRecord(url, t, status, shown) for t in targets))

    def fill_history(self, url: str, target: str) -> tuple[bool, bool]:
        """(attempted, filled) for this target on this page."""
        record = next((f for f in self.fills if f.url == url and f.target == target), None)
        return (record is not None, record is not None and record.status == FILL_DONE)

    def filled_targets(self, url: str) -> tuple[str, ...]:
        return tuple(f.target for f in self.fills if f.url == url)

    def filled_refs(self) -> dict[str, str]:
        """ref -> what is shown instead of the value of every field the gate filled (or tried to) in this session, on any page. Not tied to a URL:
        a page can change its URL without a new document, and the URL check would race a tab switch. Refs restart on
        a new document, so another page's field with the same ref is redacted too: over-redaction, never a leak."""
        return {f.target: f.shown or REDACTED_FORMAT.format(label="filled") for f in self.fills}

    def holds_fill(self, url: str) -> bool:
        """True when a page of this origin got a fill: a single-page app keeps the field across its own URL changes."""
        host = _host_or_none(url)
        return host is not None and any(_host_or_none(f.url) == host for f in self.fills)

    def filled_here(self, url: str, target: str) -> bool:
        """`target` was filled on this page (the URL without its fragment: a #change keeps the document)."""
        return any(f.target == target and f.url.partition("#")[0] == url.partition("#")[0] for f in self.fills)


def _host_or_none(url: str) -> str | None:
    try:
        return page_host(url)
    except PolicyViolation:
        return None


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
    for key, target in _targets(args):
        if not ARIA_REF.fullmatch(target) and VALUE_SELECTOR.search(target):
            raise PolicyViolation(f"{key!r}: selectors with escapes or matching a value attribute are disabled behind "
                                  "secret-gate; use the element ref from browser_snapshot")
    if state.protected:
        _check_copy_chord(name, args)
        _check_oracle(args, state.protected)


def check_filled_page(name: str, args: dict[str, Any], state: GateState, url: str) -> None:
    """Refusals once the gate filled a field (`url` is the current page): nothing that could edit a filled field, so
    its value cannot be cut down to a part that string redaction would not recognise (security review 2026-11-23, H1).

    Which element has the focus is not asked (it would be a second call the page could race): a key goes wherever the
    focus is, so on a page of an origin that got a fill every key that could edit text is refused, whichever field it
    would reach. Typing into, choosing in, dropping onto or dragging a field the gate filled is refused by its ref; a
    token fill (secret_fill) replaces the whole value and stays allowed."""
    if not state.fills or name not in FILLED_PAGE_TOOLS:
        return
    filled = state.filled_refs()
    if name in DRAG_TOOLS:  # a selection dragged out of a field is part of its value: by ref, on any page
        for _, target in _targets(args):
            if target in filled:
                raise PolicyViolation(FILLED_PAGE_REFUSED.format(what=f"拖放 secret-gate 填过的字段（{target}）"))
    if name in ELEMENT_WRITE_TOOLS:
        for _, target in _targets(args):
            if state.filled_here(url, target):
                raise PolicyViolation(FILLED_PAGE_REFUSED.format(what=f"往 secret-gate 填过的字段（{target}）里输入或选择"))
    if not state.holds_fill(url):
        return
    if name in FOCUS_INPUT_TOOLS:
        raise PolicyViolation(FILLED_PAGE_REFUSED.format(what=f"{name}（在焦点处输入或按住鼠标）"))
    if name in KEY_TOOLS and not _navigation_key(str(args.get("key", ""))):
        raise PolicyViolation(FILLED_PAGE_REFUSED.format(what=f"可能改动输入内容的按键 {str(args.get('key', ''))[:40]!r} "))


def parse_key(key: str) -> tuple[frozenset[str], str]:
    """(modifiers, key) split the way Playwright splits a key string ("Shift++" is Shift and "+"), every spelling folded
    to one name: "Meta+KeyC", "cmd+c" and "META+C" are all ({"meta"}, "c"); "Digit1" and "Numpad1" are "1"."""
    parts: list[str] = []
    building = ""
    for char in key:
        if char == "+" and building:
            parts.append(building)
            building = ""
        else:
            building += char
    parts.append(building)
    *mods, base = parts
    return frozenset(_key_name(m) for m in mods), _key_name(base)


def _key_name(key: str) -> str:
    name = key.casefold()
    if name.strip():
        name = name.strip()
    name = _KEY_ALIASES.get(name, name)
    if m := re.fullmatch(r"key([a-z])", name):
        return m.group(1)
    if m := re.fullmatch(r"(?:digit|numpad)([0-9])", name):
        return m.group(1)
    return _MODIFIERS.get(name, name)


def _navigation_key(key: str) -> bool:
    mods, base = parse_key(key)
    if base not in NAVIGATION_KEYS:
        return False
    return not mods or base == "enter" or (mods == {"shift"} and base == "tab")


def _check_url_scheme(url: Any) -> None:
    if url is None or url == "":
        return
    scheme = urlsplit(str(url)).scheme.lower()
    if scheme not in ("http", "https") and str(url) != "about:blank":
        raise PolicyViolation(f"only http(s) pages may be opened behind secret-gate, not {url!r}")


def _check_copy_chord(name: str, args: dict[str, Any]) -> None:
    """Copy and cut in every spelling Playwright accepts (Meta+KeyC, ControlOrMeta+c, Control+Insert), and Shift+Delete
    / Shift+Insert (cut and paste on Windows and Linux)."""
    if name not in KEY_TOOLS:
        return
    mods, base = parse_key(str(args.get("key", "")))
    if (mods & CHORD_MODIFIERS and base in COPY_KEYS) or base in {"copy", "cut"} or (
            "shift" in mods and base in {"delete", "insert"}):
        raise PolicyViolation("copy/cut shortcuts are disabled while a filled value is on a page")


def _targets(args: dict[str, Any]) -> list[tuple[str, str]]:
    """(argument, target) of every element the call names, including every field of browser_fill_form."""
    found = [(key, args[key]) for key in TARGET_ARGS if isinstance(args.get(key), str)]
    fields = args.get("fields")
    if isinstance(fields, list):
        found += [("target", f["target"]) for f in fields if isinstance(f, dict) and isinstance(f.get("target"), str)]
    return found


def _probes(args: dict[str, Any]) -> list[tuple[str, str]]:
    """(argument, text) pairs that search or select, including every field target of browser_fill_form."""
    found = [(key, args[key]) for key in ORACLE_ARGS if key not in TARGET_ARGS and isinstance(args.get(key), str)]
    return found + _targets(args)


def _check_oracle(args: dict[str, Any], filled: tuple[Resolution, ...]) -> None:
    for key in REGEX_ARGS:
        if isinstance(args.get(key), str) and args[key]:
            raise PolicyViolation(f"{key} search is disabled while a filled value is on a page")
    for key, probe in _probes(args):
        if any(shares_ngram(probe, r.value) for r in filled):
            raise PolicyViolation(f"{key!r} matches part of a filled value; refused")
        # Every selector can test the page (text engines, :has(), CSS escapes, attribute values, layout); a ref cannot.
        if key in TARGET_ARGS and not ARIA_REF.fullmatch(probe):
            raise PolicyViolation(f"{key!r}: selectors are disabled while a filled value is on a page; "
                                  "use the element ref from browser_snapshot")


def shares_ngram(probe: str, value: str) -> bool:
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


def hide_field_values(text: str, filled_refs: Mapping[str, str], filled: tuple[Resolution, ...]) -> str:
    """Hide the value of every text-entry element in snapshot text (browser_snapshot, browser_find, the page state that
    follows an action) that is a field the gate filled, by its ref, whatever the field holds now, or that holds
    ORACLE_NGRAM or more characters of a filled value. The line keeps its role, name and ref; its value, inline or as
    child lines, becomes what `filled_refs` says, or [REDACTED:label]. String redaction only knows whole values: a field edited down to a part of
    one would otherwise be shown as it is (security review 2026-11-23, H1)."""
    if not filled_refs and not filled:
        return text
    lines = text.split("\n")
    out: list[str] = []
    i = 0
    while i < len(lines):
        line = lines[i]
        entry = _ENTRY_LINE.match(line)
        end = i + 1
        if entry:
            depth = len(entry.group("indent"))
            while end < len(lines) and lines[end].strip() and len(lines[end]) - len(lines[end].lstrip(" ")) > depth:
                end += 1
            label = _hidden_as(line, "\n".join(lines[i:end]), filled_refs, filled)
            if label is not None:
                marks = list(_REF_MARK.finditer(line))
                head = line[: marks[-1].end()] if marks else entry.group(0)
                out.append(f"{head}: {label}")
                i = end
                continue
        out.extend(lines[i:end])
        i = end
    return "\n".join(out)


FIND_TOOL = "browser_find"
_FIND_CONTEXT = 3
_YAML_BLOCK = re.compile(r"^```yaml\n(.*?)^```", re.MULTILINE | re.DOTALL)


def find_in_snapshot(snapshot: str, text: str) -> str:
    """browser_find's answer (case-insensitive substring, three lines of context, each match under its ancestors),
    computed by the gate on its redacted snapshot. Playwright's own find searches the raw snapshot, where a field's
    value is shown: whether a probe matched would tell part of the value even with the lines redacted
    (security review 2026-11-23, L2)."""
    block = _YAML_BLOCK.search(snapshot)
    lines = (block.group(1) if block else snapshot).rstrip("\n").split("\n")
    indents = [len(line) - len(line.lstrip(" ")) for line in lines]
    needle = text.lower()
    matched = [i for i, line in enumerate(lines) if needle in line.lower()]
    query = f'"{text}"'
    if not matched:
        return f"### Result\nNo matches found for {query}."
    windows: list[list[int]] = []
    for i in matched:
        start, end = max(0, i - _FIND_CONTEXT), min(len(lines) - 1, i + _FIND_CONTEXT)
        if windows and start <= windows[-1][1] + 1:
            windows[-1][1] = max(windows[-1][1], end)
        else:
            windows.append([start, end])
    on_path = set(matched)
    for i in matched:
        on_path.update(_ancestors(lines, indents, i))
    snippets = []
    for start, end in windows:
        indices = _ancestors(lines, indents, start) + list(range(start, end + 1))
        out = []
        for n, index in enumerate(indices):
            if n > 0 and index > indices[n - 1] + 1 and index not in on_path and indices[n - 1] not in on_path:
                out.append(" " * indents[index] + "...")
            out.append(lines[index])
        snippets.append("\n".join(out))
    word = "match" if len(matched) == 1 else "matches"
    return f"### Result\nFound {len(matched)} {word} for {query}:\n\n" + "\n\n----\n\n".join(snippets)


def _ancestors(lines: list[str], indents: list[int], index: int) -> list[int]:
    found = []
    indent = indents[index]
    for i in range(index - 1, -1, -1):
        if indent <= 0:
            break
        if lines[i].strip() and indents[i] < indent:
            found.append(i)
            indent = indents[i]
    return found[::-1]


def _hidden_as(line: str, block: str, filled_refs: Mapping[str, str], filled: tuple[Resolution, ...]) -> str | None:
    for ref in _REF_MARK.findall(line):
        if ref in filled_refs:
            return filled_refs[ref]
    plain = block.replace('\\"', '"').replace("\\\\", "\\")  # Playwright quotes a value YAML-style when it must
    for r in filled:
        if len(r.value) >= ORACLE_NGRAM and (shares_ngram(block, r.value) or shares_ngram(plain, r.value)):
            return REDACTED_FORMAT.format(label=r.label)
    return None
