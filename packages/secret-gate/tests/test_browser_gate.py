"""BrowserGate against an in-memory fake Playwright: what the model sees and what the page gets."""

from __future__ import annotations

import asyncio
import json
import re
from pathlib import Path
from typing import Any

import pytest
from mcp import types

from secret_gate.browser_gate import BrowserGate, sweep_output_dir
from tests.fixtures import fake_secrets as fs
from tests.fixtures.png import make_png

PAGE = "https://login.portal-a.example.com/signin"
HOME = "https://login.portal-a.example.com/home"
MASK = (0xFF, 0x00, 0xFF)


def _js(text: str) -> str:
    return "'" + json.dumps(text)[1:-1].replace("'", "\\'") + "'"


def _spec(code: str) -> dict:
    start = code.index("const spec = ") + len("const spec = ")
    return json.JSONDecoder().raw_decode(code, start)[0]


def _located(code: str) -> str:
    return json.loads(re.search(r'locate\(("(?:[^"\\]|\\.)*")\)', code).group(1))


class FakePlaywright:
    """Echoes typed values in snapshots and JS-escaped in the code section, like the real one.

    `browser_run_code_unsafe` understands the gate's own snippets: field state, form target and the
    masked screenshot, which it renders as a PNG with the mask colour over every known box.
    """

    def __init__(self, url: str = PAGE) -> None:
        self.url = url
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.typed: dict[str, str] = {}
        self.echo = ""  # text the "server" renders after login
        self.fail_type = False
        self.probe_error = False
        self.boxes: dict[str, tuple[int, int, int, int]] = {"e1": (10, 10, 80, 20), "e7": (10, 40, 80, 20),
                                                             "e9": (10, 70, 120, 20), "input[type=password]": (100, 10, 60, 20)}
        self.mask_broken = False  # the page tears Playwright's overlay down
        self.form_action: str | None = None  # None: the form submits to the current page; "": no form
        self.frames: dict[str, list[str]] = {}  # target -> frame URLs, innermost first (default: the page)
        self.run_code_error = False

    async def list_tools(self):
        names = ["browser_navigate", "browser_snapshot", "browser_type", "browser_fill_form", "browser_evaluate",
                 "browser_run_code_unsafe", "browser_take_screenshot", "browser_click", "browser_tabs"]
        schema = {"type": "object", "properties": {"filename": {"type": "string"}, "x": {}}}
        return [types.Tool(name=n, description=n, inputSchema=schema,
                           annotations=types.ToolAnnotations(readOnlyHint=n == "browser_snapshot")) for n in names]

    async def call_tool(self, name: str, args: dict[str, Any]) -> types.CallToolResult:
        self.calls.append((name, args))
        if name == "browser_evaluate":
            if self.probe_error:
                return _err('### Error\nDialog open: "https://login.portal-a.example.com/signin"')
            return _text(f"### Result\n{json.dumps(self.url)}\n\n### Ran Playwright code\nawait page.evaluate(...);")
        if name == "browser_run_code_unsafe":
            if self.run_code_error:
                return _err("### Error\nboom")
            return _text(f"### Result\n{json.dumps(self._run_code(args['code']))}\n### Ran Playwright code\n...")
        if name == "browser_type":
            if self.fail_type:
                return _err(f"### Error\nelement not found\n### Ran Playwright code\nawait page.fill({_js(args['text'])});")
            self.typed[args["target"]] = args["text"]
            return _text(f"### Ran Playwright code\nawait page.fill({_js(args['text'])});\n- [Snapshot](../browser-out/page-1.yml)")
        if name == "browser_fill_form":
            for f in args["fields"]:
                self.typed[f["target"]] = f["value"]
            return _text("### Ran Playwright code\n" + "\n".join(f"fill({_js(f['value'])})" for f in args["fields"]))
        if name == "browser_navigate":
            if args["url"].startswith("https://blocked."):
                return _err("### Error\nnet::ERR_FAILED")
            self.url, self.typed = args["url"], {}
            return _text(f"- Page URL: {self.url}\n- [Snapshot](../browser-out/page-2.yml)")
        if name == "browser_snapshot":
            body = "\n".join(f'- textbox "{t}" [ref={t}]: {v}' for t, v in self.typed.items())
            return _text(f"- Page URL: {self.url}\n{body}\n{self.echo}")
        if name == "browser_take_screenshot":
            return types.CallToolResult(content=[types.ImageContent(type="image", data="AAAA", mimeType="image/png")])
        return _text(f"{name} ok")

    def _run_code(self, code: str) -> Any:
        if "inputValue" in code:
            target = _located(code)
            return "unknown" if target not in self.typed else ("nonempty" if self.typed[target] else "empty")
        if "form.action" in code:
            return {"actions": []} if self.form_action == "" else {"actions": [self.url, self.form_action or self.url]}
        if "ownerFrame" in code:
            return {"urls": self.frames.get(_located(code), [self.url])}
        spec = _spec(code)
        boxes = [self.boxes[k] for k in (*spec["refs"], *spec["selectors"]) if k in self.boxes]
        rects = [] if self.mask_broken else [(*b, MASK) for b in boxes]
        Path(spec["path"]).write_bytes(make_png(300, 200, rects))
        return {"boxes": [{"x": x, "y": y, "width": w, "height": h} for x, y, w, h in boxes]}


def _text(s: str) -> types.CallToolResult:
    return types.CallToolResult(content=[types.TextContent(type="text", text=s)])


def _err(s: str) -> types.CallToolResult:
    return types.CallToolResult(content=[types.TextContent(type="text", text=s)], isError=True)


def run(coro):
    return asyncio.run(coro)


def texts(blocks) -> str:
    return "\n".join(b.text for b in blocks if isinstance(b, types.TextContent))


def names(pw: FakePlaywright) -> list[str]:
    return [n for n, _ in pw.calls]


@pytest.fixture
def pw():
    return FakePlaywright()


@pytest.fixture
def gate(resolver, pw):
    return BrowserGate(resolver, pw)


def test_list_tools_hides_dangerous_ones_adds_secret_fill_keeps_annotations(gate):
    tools = run(gate.list_tools())
    by_name = {t.name: t for t in tools}
    assert "secret_fill" in by_name and "secret_field_state" in by_name
    assert "masked" in by_name["browser_take_screenshot"].description
    assert "browser_evaluate" not in by_name and "browser_run_code_unsafe" not in by_name
    assert "filename" not in by_name["browser_snapshot"].inputSchema["properties"]
    assert by_name["browser_snapshot"].annotations.readOnlyHint is True


def test_secret_fill_types_plaintext_and_result_is_clean(gate, pw, portal_pass):
    out = texts(run(gate.call_tool("secret_fill", {"target": "e7", "token": portal_pass, "submit": True})))
    typed = [a for n, a in pw.calls if n == "browser_type"]
    assert typed == [{"target": "e7", "text": fs.PORTAL.password, "element": "secret field", "submit": True}]
    assert fs.PORTAL.password not in out and "page-1.yml" not in out and "Ran Playwright code" not in out
    snap = texts(run(gate.call_tool("browser_snapshot", {})))
    assert fs.PORTAL.password not in snap and f"[REDACTED:{fs.PORTAL.label}]" in snap
    assert gate.state.tainted_urls == {PAGE}


def test_value_with_quotes_and_backslash_never_echoes(resolver, keypair, pw):
    from secret_gate.constants import USE_HTTP
    from secret_gate.policy import SecretPayload
    from secret_gate.tokens import make_token

    value = "it's \\ \"tricky\" <a&b>/x"
    tok = make_token(keypair.public, SecretPayload.create(value=value, hosts=fs.PORTAL.hosts, uses={USE_HTTP}, label="t/q"))
    gate = BrowserGate(resolver, pw)
    out = texts(run(gate.call_tool("browser_type", {"target": "e1", "text": tok})))
    assert pw.typed["e1"] == value
    assert value not in out and "tricky" not in out
    pw.fail_type = True
    with pytest.raises(RuntimeError) as exc:
        run(gate.call_tool("browser_type", {"target": "e2", "text": tok}))
    assert "tricky" not in str(exc.value) and "it" not in str(exc.value).split("Error")[1][:3]


def test_fill_form_substitutes_every_field(gate, pw, portal_pass, portal_user):
    fields = [
        {"target": "u", "name": "user", "type": "textbox", "value": portal_user},
        {"target": "p", "name": "pass", "type": "textbox", "value": portal_pass},
        {"target": "r", "name": "remember", "type": "checkbox", "value": "true"},
    ]
    out = texts(run(gate.call_tool("browser_fill_form", {"fields": fields})))
    assert pw.typed == {"u": fs.PORTAL.username, "p": fs.PORTAL.password, "r": "true"}
    assert fs.PORTAL.username not in out and fs.PORTAL.password not in out
    snap = texts(run(gate.call_tool("browser_snapshot", {})))
    assert fs.PORTAL.username not in snap and fs.PORTAL.password not in snap


def test_wrong_host_is_refused_before_anything_is_typed(gate, pw, bank_pass):
    with pytest.raises(RuntimeError, match="secret-gate"):
        run(gate.call_tool("secret_fill", {"target": "e1", "token": bank_pass}))
    assert names(pw) == ["browser_evaluate"]  # only the URL probe
    assert pw.typed == {} and gate.state.tainted_urls == frozenset()


def test_non_http_page_and_failed_probe_are_refused(resolver, portal_pass):
    pw = FakePlaywright(url="about:blank")
    gate = BrowserGate(resolver, pw)
    with pytest.raises(RuntimeError, match="non-http"):
        run(gate.call_tool("browser_type", {"target": "e1", "text": portal_pass}))
    pw.url, pw.probe_error = PAGE, True
    with pytest.raises(RuntimeError, match="could not determine"):
        run(gate.call_tool("browser_type", {"target": "e1", "text": portal_pass}))
    assert pw.typed == {}


def test_plain_text_typing_does_not_probe_url(gate, pw):
    run(gate.call_tool("browser_type", {"target": "e1", "text": "hello"}))
    assert names(pw) == ["browser_type"]


def test_denied_tools_file_args_and_schemes(gate, pw):
    for name, args in (
        ("browser_evaluate", {"function": "() => 1"}),
        ("browser_run_code_unsafe", {"code": "x"}),
        ("browser_snapshot", {"filename": "/tmp/snap.txt"}),
        ("browser_file_upload", {"paths": ["page-1.yml"]}),
        ("browser_navigate", {"url": "data:text/html,<textarea>"}),
        ("browser_tabs", {"action": "new", "url": "javascript:1"}),
    ):
        with pytest.raises(RuntimeError, match="secret-gate"):
            run(gate.call_tool(name, args))
    assert pw.calls == []


@pytest.fixture
def out_dir(tmp_path):
    d = tmp_path / "browser-out"
    d.mkdir()
    return d


@pytest.fixture
def masked_gate(resolver, pw, out_dir):
    return BrowserGate(resolver, pw, output_dir=out_dir)


def _image(blocks) -> bytes:
    import base64

    image = next(b for b in blocks if isinstance(b, types.ImageContent))
    return base64.b64decode(image.data)


def test_screenshot_after_fill_is_masked_and_verified(masked_gate, pw, portal_pass, out_dir):
    run(masked_gate.call_tool("secret_fill", {"target": "e1", "token": portal_pass}))
    blocks = run(masked_gate.call_tool("browser_take_screenshot", {"fullPage": True}))
    code = next(a["code"] for n, a in reversed(pw.calls) if n == "browser_run_code_unsafe")
    spec = json.loads(code.split("const spec = ", 1)[1].split("; const masks", 1)[0])
    assert spec["refs"] == ["e1"] and "input[type=password]" in spec["selectors"] and "canvas" in spec["selectors"]
    assert spec["fullPage"] is True and spec["path"].startswith(str(out_dir))
    assert fs.PORTAL.password not in code  # the page never learns what is protected
    assert _image(blocks).startswith(b"\x89PNG") and "masked 2 region" in texts(blocks)
    assert "browser_take_screenshot" not in names(pw)  # the plain capture is never used on such a page
    assert list(out_dir.iterdir()) == []  # the capture file is swept with everything else


def test_screenshot_refused_when_mask_is_not_in_the_image(masked_gate, pw, portal_pass):
    run(masked_gate.call_tool("secret_fill", {"target": "e1", "token": portal_pass}))
    pw.mask_broken = True
    with pytest.raises(RuntimeError, match="not covered"):
        run(masked_gate.call_tool("browser_take_screenshot", {}))


def test_screenshot_refused_when_sensitive_text_has_no_element(masked_gate, pw, portal_pass):
    run(masked_gate.call_tool("browser_navigate", {"url": HOME}))
    pw.echo = f"heading: Welcome {fs.PORTAL.password}"
    run(masked_gate.call_tool("secret_fill", {"target": "e7", "token": portal_pass}))
    with pytest.raises(RuntimeError, match="no element to mask"):
        run(masked_gate.call_tool("browser_take_screenshot", {}))
    pw.echo = f'- heading "Welcome" [ref=e9]: Welcome {fs.PORTAL.password}'
    run(masked_gate.call_tool("browser_take_screenshot", {}))
    spec_code = next(a["code"] for n, a in reversed(pw.calls) if n == "browser_run_code_unsafe")
    assert '"refs": ["e7", "e9"]' in spec_code


@pytest.mark.parametrize("failure", ["run_code_error", "no_file", "bad_result"])
def test_screenshot_fails_closed(masked_gate, pw, portal_pass, failure, monkeypatch):
    run(masked_gate.call_tool("secret_fill", {"target": "e1", "token": portal_pass}))
    if failure == "run_code_error":
        pw.run_code_error = True
    elif failure == "no_file":
        monkeypatch.setattr(pw, "_run_code", lambda code: {"boxes": []})
    else:
        monkeypatch.setattr(pw, "_run_code", lambda code: {"error": "element is not visible"})
    with pytest.raises(RuntimeError, match="screenshot refused|refused"):
        run(masked_gate.call_tool("browser_take_screenshot", {}))


def test_screenshot_needs_a_private_dir_once_something_is_protected(gate, pw, portal_pass):
    run(gate.call_tool("secret_fill", {"target": "e1", "token": portal_pass}))
    with pytest.raises(RuntimeError, match="no private directory"):
        run(gate.call_tool("browser_take_screenshot", {}))


def test_personal_data_on_page_is_masked_without_any_fill(masked_gate, pw):
    pw.echo = '- paragraph [ref=e9]: "Contact: alice.demo@example.com"'
    run(masked_gate.call_tool("browser_take_screenshot", {}))
    code = next(a["code"] for n, a in reversed(pw.calls) if n == "browser_run_code_unsafe")
    assert '"refs": ["e9"]' in code and "canvas" not in code and "alice.demo" not in code


def test_screenshot_without_anything_to_protect_is_plain(gate, pw):
    blocks = run(gate.call_tool("browser_take_screenshot", {}))
    assert isinstance(blocks[0], types.ImageContent)
    assert names(pw) == ["browser_snapshot", "browser_evaluate", "browser_take_screenshot"]


def test_admin_regions_are_always_masked(resolver, pw, out_dir):
    from secret_gate.browser_mask import MaskConfig

    mask = MaskConfig(regions=(("login.portal-a.example.com", (".customer-card",)),))
    gate = BrowserGate(resolver, pw, output_dir=out_dir, mask=mask)
    run(gate.call_tool("browser_take_screenshot", {}))
    code = next(a["code"] for n, a in reversed(pw.calls) if n == "browser_run_code_unsafe")
    assert ".customer-card" in code


# -- field state (gate-next-v0 §2) ------------------------------------------------------------------

def test_field_state_separates_current_value_from_history(gate, pw, portal_pass):
    state = json.loads(texts(run(gate.call_tool("secret_field_state", {"target": "e1"}))))
    assert state == {"target": "e1", "current": "unknown", "attempted": False, "filled": False}
    out = texts(run(gate.call_tool("secret_fill", {"target": "e1", "token": portal_pass})))
    assert '"current": "nonempty"' in out and '"filled": true' in out and fs.PORTAL.password not in out
    pw.typed["e1"] = ""  # the page cleared the field
    state = json.loads(texts(run(gate.call_tool("secret_field_state", {"target": "e1"}))))
    assert state == {"target": "e1", "current": "empty", "attempted": True, "filled": True}
    pw.fail_type = True
    with pytest.raises(RuntimeError):
        run(gate.call_tool("secret_fill", {"target": "e7", "token": portal_pass}))
    state = json.loads(texts(run(gate.call_tool("secret_field_state", {"target": "e7"}))))
    assert state["attempted"] is True and state["filled"] is False


def test_field_state_is_per_page_and_unknown_when_probe_fails(gate, pw, portal_pass):
    run(gate.call_tool("secret_fill", {"target": "e1", "token": portal_pass}))
    pw.url = HOME
    pw.run_code_error = True
    state = json.loads(texts(run(gate.call_tool("secret_field_state", {"target": "e1"}))))
    assert state == {"target": "e1", "current": "unknown", "attempted": False, "filled": False}
    with pytest.raises(RuntimeError, match="takes only"):
        run(gate.call_tool("secret_field_state", {"target": "e1", "value": "x"}))
    with pytest.raises(RuntimeError, match="target"):
        run(gate.call_tool("secret_field_state", {"target": ""}))


def test_copy_chord_and_oracle_only_after_fill(gate, pw, portal_pass):
    run(gate.call_tool("browser_press_key", {"key": "Meta+c"}))
    run(gate.call_tool("secret_fill", {"target": "e1", "token": portal_pass}))
    with pytest.raises(RuntimeError, match="copy/cut"):
        run(gate.call_tool("browser_press_key", {"key": "Meta+c"}))
    with pytest.raises(RuntimeError, match="matches part"):
        run(gate.call_tool("browser_find", {"text": fs.PORTAL.password[:4]}))
    run(gate.call_tool("browser_find", {"text": "Sign in"}))


def test_unexpected_downstream_exception_is_redacted(gate, pw, portal_pass):
    run(gate.call_tool("secret_fill", {"target": "e1", "token": portal_pass}))

    async def boom(name, args):
        raise ConnectionError(f"pipe broke while sending {fs.PORTAL.password}")

    pw.call_tool = boom  # type: ignore[assignment]
    with pytest.raises(RuntimeError) as exc:
        run(gate.call_tool("browser_click", {"target": "e1"}))
    assert fs.PORTAL.password not in str(exc.value)


def test_unknown_content_blocks_are_dropped(gate, pw):
    async def weird(name, args):
        return types.CallToolResult(content=[types.EmbeddedResource(type="resource", resource=types.TextResourceContents(uri="file:///x", text="raw"))])

    pw.call_tool = weird  # type: ignore[assignment]
    out = texts(run(gate.call_tool("browser_click", {"target": "e1"})))
    assert "omitted" in out and "raw" not in out


def test_output_dir_is_swept_after_every_call(resolver, pw, tmp_path):
    out = tmp_path / "browser-out"
    out.mkdir()
    (out / "page-1.yml").write_text("secret")
    (out / "sub").mkdir()
    gate = BrowserGate(resolver, pw, output_dir=out)
    run(gate.call_tool("browser_click", {"target": "e1"}))
    assert not (out / "page-1.yml").exists() and (out / "sub").is_dir()
    (out / "console-1.log").write_text("x")
    with pytest.raises(RuntimeError):
        run(gate.call_tool("browser_evaluate", {"function": "1"}))
    assert list(out.iterdir()) == [out / "sub"]
    sweep_output_dir(None)
    sweep_output_dir(tmp_path / "missing")


def test_secret_fill_accepts_a_reference_of_this_execution(keypair, pw, tmp_path, portal_pass):
    from secret_gate.refs import RefRegistry
    from secret_gate.resolver import Resolver

    registry = RefRegistry(tmp_path / "refs.sqlite3")
    mine = Resolver(keypair.private, refs=registry, scope="browser-scope-0123456789abc")
    ref = mine.register(portal_pass)
    out = texts(run(BrowserGate(mine, pw).call_tool("secret_fill", {"target": "e1", "token": ref})))
    assert pw.typed["e1"] == fs.PORTAL.password and fs.PORTAL.password not in out
    other = Resolver(keypair.private, refs=registry, scope="other-scope-0123456789abcde")
    with pytest.raises(RuntimeError, match="different task"):
        run(BrowserGate(other, pw).call_tool("secret_fill", {"target": "e7", "token": ref}))
    assert "e7" not in pw.typed


# -- fills inside frames (security review 2026-09-24) -----------------------------------------------

def test_fill_into_a_foreign_iframe_is_refused(gate, pw, portal_pass):
    pw.frames["f1e3"] = [f"https://{fs.EVIL_HOST}/widget", PAGE]
    with pytest.raises(RuntimeError, match="not allowed on host"):
        run(gate.call_tool("secret_fill", {"target": "f1e3", "token": portal_pass}))
    assert "f1e3" not in pw.typed


def test_fill_into_an_allowed_iframe_inside_an_allowed_page(gate, pw, portal_pass):
    pw.frames["f1e3"] = ["https://portal-a.example.com/embedded-login", PAGE]
    run(gate.call_tool("secret_fill", {"target": "f1e3", "token": portal_pass}))
    assert pw.typed["f1e3"] == fs.PORTAL.password


def test_allowed_iframe_inside_a_foreign_page_is_refused(gate, pw, portal_pass):
    pw.url = f"https://{fs.EVIL_HOST}/phish"
    pw.frames["f1e3"] = ["https://portal-a.example.com/embedded-login", pw.url]
    with pytest.raises(RuntimeError, match="not allowed on host"):
        run(gate.call_tool("secret_fill", {"target": "f1e3", "token": portal_pass}))
    assert pw.typed == {}


@pytest.mark.parametrize("frames, needle", [
    ({"f1e3": ["about:srcdoc", PAGE]}, "non-http"),
    ({"f1e3": [PAGE], "f2e1": ["https://login.portal-a.example.com:8443/x", PAGE]}, "different frames"),
])
def test_frame_fills_fail_closed(gate, pw, portal_pass, portal_user, frames, needle):
    pw.frames.update(frames)
    fields = [{"target": t, "name": t, "type": "textbox", "value": portal_pass} for t in frames]
    with pytest.raises(RuntimeError, match=needle):
        run(gate.call_tool("browser_fill_form", {"fields": fields}))
    assert pw.typed == {}


def test_selector_targets_are_located_by_playwright_first(gate, pw, portal_pass, monkeypatch):
    monkeypatch.setattr(pw, "_run_code", lambda code: {"error": "target is not exactly one element"})
    with pytest.raises(RuntimeError, match="which frame"):
        run(gate.call_tool("secret_fill", {"target": "#password", "token": portal_pass}))
    assert pw.typed == {}
