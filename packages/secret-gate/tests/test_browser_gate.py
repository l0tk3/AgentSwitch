"""BrowserGate against an in-memory fake Playwright: what the model sees and what the page gets."""

from __future__ import annotations

import asyncio
import json
from typing import Any

import pytest
from mcp import types

from secret_gate.browser_gate import BrowserGate, sweep_output_dir
from tests.fixtures import fake_secrets as fs

PAGE = "https://login.portal-a.example.com/signin"
HOME = "https://login.portal-a.example.com/home"


def _js(text: str) -> str:
    return "'" + json.dumps(text)[1:-1].replace("'", "\\'") + "'"


class FakePlaywright:
    """Echoes typed values in snapshots and JS-escaped in the code section, like the real one."""

    def __init__(self, url: str = PAGE) -> None:
        self.url = url
        self.calls: list[tuple[str, dict[str, Any]]] = []
        self.typed: dict[str, str] = {}
        self.echo = ""  # text the "server" renders after login
        self.fail_type = False
        self.probe_error = False

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
            body = "\n".join(f'textbox "{t}": {v}' for t, v in self.typed.items())
            return _text(f"- Page URL: {self.url}\n{body}\n{self.echo}")
        if name == "browser_take_screenshot":
            return types.CallToolResult(content=[types.ImageContent(type="image", data="AAAA", mimeType="image/png")])
        return _text(f"{name} ok")


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
    assert "secret_fill" in by_name
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


def test_screenshot_rules(gate, pw, portal_pass):
    run(gate.call_tool("secret_fill", {"target": "e1", "token": portal_pass}))
    with pytest.raises(RuntimeError, match="held a filled value"):
        run(gate.call_tool("browser_take_screenshot", {}))
    # A failed navigation must not lift the block.
    with pytest.raises(RuntimeError):
        run(gate.call_tool("browser_navigate", {"url": "https://blocked.example/"}))
    with pytest.raises(RuntimeError, match="held a filled value"):
        run(gate.call_tool("browser_take_screenshot", {}))
    # Another page that does not show the value: allowed (probe + snapshot check first).
    run(gate.call_tool("browser_navigate", {"url": HOME}))
    blocks = run(gate.call_tool("browser_take_screenshot", {}))
    assert isinstance(blocks[0], types.ImageContent)
    # Page that echoes the value ("Welcome <user>"): refused even though the URL is new.
    pw.echo = f"heading: Welcome {fs.PORTAL.password}"
    with pytest.raises(RuntimeError, match="currently shows"):
        run(gate.call_tool("browser_take_screenshot", {}))
    # Back on the login page via tabs/history: still refused (form state is restored).
    pw.echo, pw.url = "", PAGE
    with pytest.raises(RuntimeError, match="held a filled value"):
        run(gate.call_tool("browser_take_screenshot", {}))
    assert not any(n == "browser_take_screenshot" and pw.url == PAGE for n, _ in pw.calls[-3:])


def test_screenshot_without_any_fill_is_plain(gate, pw):
    blocks = run(gate.call_tool("browser_take_screenshot", {}))
    assert isinstance(blocks[0], types.ImageContent)
    assert names(pw) == ["browser_take_screenshot"]


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
