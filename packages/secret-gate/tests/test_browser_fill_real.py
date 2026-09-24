"""Real Chromium through `secret-gate browser` + Playwright MCP against a local login page.

Opt-in (launches a browser, ~10 s): SG_BROWSER_E2E=1 pytest tests/test_browser_fill_real.py
Needs `npx -y @playwright/mcp@0.0.82` cached. No model, no proxy: this isolates the fill path.

The page validates the username as an e-mail in JavaScript before submitting, which is exactly
what defeats typing a 201-character token. With secret_fill the real value is in the DOM, so the
check passes and the server receives plaintext, while every result the client sees is redacted.
"""

from __future__ import annotations

import asyncio
import json
import os
import sys
import threading
from http.server import BaseHTTPRequestHandler, HTTPServer
from pathlib import Path
from typing import ClassVar
from urllib.parse import parse_qs

import pytest
from mcp import ClientSession, StdioServerParameters, types
from mcp.client.stdio import stdio_client

from secret_gate.constants import USE_HTTP
from secret_gate.policy import SecretPayload
from secret_gate.tokens import make_token

pytestmark = pytest.mark.skipif(not os.environ.get("SG_BROWSER_E2E"), reason="set SG_BROWSER_E2E=1 to launch Chromium")

PW_VERSION = os.environ.get("PW_MCP_VERSION", "0.0.82")
EMAIL = "alice.demo@example.com"
PASSWORD = "Hunter2-Fake's \\Pa55!"  # quote + backslash: exercises the JS-escaped echo

PAGE = """<!doctype html><title>Login</title>
<form id=f method=post action=/login>
 <label>Email <input id=u name=u maxlength=64></label>
 <label>Password <input id=p name=p type=password></label>
 <button id=go type=submit>Sign in</button>
 <p id=err></p>
</form>
<script>
document.getElementById('f').addEventListener('submit', e => {
  const v = document.getElementById('u').value;
  if (!/^[^@\\s]+@[^@\\s]+\\.[^@\\s]+$/.test(v)) { e.preventDefault(); document.getElementById('err').textContent = 'invalid email'; }
});
</script>"""


class Handler(BaseHTTPRequestHandler):
    received: ClassVar[list[dict]] = []

    def do_GET(self):
        self._send(200, PAGE)

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        Handler.received.append({k: v[0] for k, v in parse_qs(self.rfile.read(n).decode()).items()})
        self._send(200, f"<title>Welcome</title><h1>Welcome {Handler.received[-1].get('u')}</h1>")

    def _send(self, status, body):
        data = body.encode()
        self.send_response(status)
        self.send_header("Content-Type", "text/html; charset=utf-8")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, *a):  # quiet
        pass


@pytest.fixture
def site():
    srv = HTTPServer(("127.0.0.1", 0), Handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    Handler.received = []
    yield f"http://127.0.0.1:{srv.server_port}"
    srv.shutdown()


def _text(r: types.CallToolResult) -> str:
    return "\n".join(c.text for c in r.content if isinstance(c, types.TextContent))


def _magenta_pixels(result: types.CallToolResult) -> int:
    import base64

    from secret_gate.browser_mask import MASK_RGB, decode_png

    image = next(c for c in result.content if isinstance(c, types.ImageContent))
    width, height, bpp, pixels = decode_png(base64.b64decode(image.data))
    return sum(1 for i in range(0, len(pixels), bpp) if tuple(pixels[i:i + 3]) == MASK_RGB)


def _ref(snapshot: str, name: str) -> str:
    for line in snapshot.splitlines():
        if f'"{name}"' in line and "[ref=" in line:
            return line.split("[ref=")[1].split("]")[0]
    raise AssertionError(f"no ref for {name!r} in snapshot:\n{snapshot}")


def _params(gate_home: Path, profile: Path) -> StdioServerParameters:
    return StdioServerParameters(
        command=sys.executable,
        args=["-m", "secret_gate.cli", "browser", "--", "npx", "-y", "--prefer-offline",
              f"@playwright/mcp@{PW_VERSION}", "--headless", f"--user-data-dir={profile}"],
        env={**os.environ, "SECRET_GATE_HOME": str(gate_home)},
    )


def test_fill_passes_client_side_validation(gate_home, keypair, tmp_path, site):
    host = site.split("//")[1]

    def tok(value: str, label: str) -> str:
        return make_token(keypair.public, SecretPayload.create(value=value, hosts=(host,), uses={USE_HTTP}, label=label))

    user_tok, pass_tok = tok(EMAIL, "demo/user"), tok(PASSWORD, "demo/pass")

    async def scenario() -> dict:
        async with stdio_client(_params(gate_home, tmp_path / "profile")) as (read, write), ClientSession(read, write) as s:
            await asyncio.wait_for(s.initialize(), 60)
            await s.call_tool("browser_navigate", {"url": site + "/"})
            snap = _text(await s.call_tool("browser_snapshot", {}))
            u_ref, p_ref, go_ref = _ref(snap, "Email"), _ref(snap, "Password"), _ref(snap, "Sign in")
            # Control: a raw value fails the page's own validation (nothing reaches the server).
            await s.call_tool("browser_type", {"target": u_ref, "text": "not-a-token-not-an-email"})
            await s.call_tool("browser_click", {"target": go_ref, "element": "submit"})
            blocked = _text(await s.call_tool("browser_snapshot", {}))
            received_after_control = list(Handler.received)
            # Real thing.
            fill_u = await s.call_tool("secret_fill", {"target": u_ref, "token": user_tok, "element": "email"})
            fill_p = await s.call_tool("secret_fill", {"target": p_ref, "token": pass_tok, "element": "password"})
            filled = _text(await s.call_tool("browser_snapshot", {}))
            state = _text(await s.call_tool("secret_field_state", {"target": u_ref}))
            shot = await s.call_tool("browser_take_screenshot", {})
            await s.call_tool("browser_click", {"target": go_ref, "element": "submit"})
            await s.call_tool("browser_wait_for", {"text": "Welcome"})
            after = _text(await s.call_tool("browser_snapshot", {}))
            shot_after = await s.call_tool("browser_take_screenshot", {})
            data_nav = await s.call_tool("browser_navigate", {"url": "data:text/html,<textarea>"})
            return {"blocked": blocked, "control": received_after_control, "fill_u": fill_u, "fill_p": fill_p,
                    "filled": filled, "state": state, "shot": shot, "after": after, "shot_after": shot_after,
                    "data_nav": data_nav}

    r = asyncio.run(asyncio.wait_for(scenario(), 120))
    assert "invalid email" in r["blocked"] and r["control"] == []
    for res in (r["fill_u"], r["fill_p"]):
        assert not res.isError, _text(res)
        assert EMAIL not in _text(res) and "Hunter2" not in _text(res) and ".yml" not in _text(res)
    assert EMAIL not in r["filled"] and PASSWORD not in r["filled"]
    assert "[REDACTED:demo/user]" in r["filled"]
    assert json.loads(r["state"]) == {"target": _ref(r["filled"], "Email"), "current": "nonempty", "attempted": True, "filled": True}
    # Screenshots are masked with Playwright's own mask and checked pixel by pixel by the gate.
    assert not r["shot"].isError and "masked" in _text(r["shot"])
    assert _magenta_pixels(r["shot"]) > 0
    assert Handler.received == [{"u": EMAIL, "p": PASSWORD}]
    assert EMAIL not in r["after"] and "[REDACTED:demo/user]" in r["after"]  # server echoed it back
    assert not r["shot_after"].isError and _magenta_pixels(r["shot_after"]) > 0  # "Welcome <email>" masked
    assert r["data_nav"].isError and "http(s)" in _text(r["data_nav"])
    # Playwright MCP persists unredacted snapshots; they must land in the gate home (0700), be swept
    # after every call, and never appear under the cwd.
    assert not (Path.cwd() / ".playwright-mcp").exists()
    assert (gate_home / "browser-out").stat().st_mode & 0o077 == 0
    assert [p for p in (gate_home / "browser-out").iterdir() if p.is_file()] == []


CONTACT = {"email": "carol.demo@example.com", "phone": "13800138000"}
SOURCE_PAGE = f"""<!doctype html><title>Customer 42</title><h1>Customer 42</h1>
<p>Contact e-mail: <span id=m>{CONTACT['email']}</span></p><p>Mobile: <span id=t>{CONTACT['phone']}</span></p>
<canvas id=c width=120 height=30></canvas>"""
DEST_PAGE = """<!doctype html><title>New customer</title>
<form method=post action=/save><label>Email <input name=email type=email required></label>
<label>Phone <input name=phone type=tel required></label><button type=submit>Save</button></form>"""


class SiteHandler(BaseHTTPRequestHandler):
    pages: ClassVar[dict[str, str]] = {}
    received: ClassVar[list[dict]] = []

    def do_GET(self):
        self._send(200, self.pages.get(self.path, "<p>not found</p>"))

    def do_POST(self):
        n = int(self.headers.get("Content-Length", 0))
        SiteHandler.received.append({k: v[0] for k, v in parse_qs(self.rfile.read(n).decode()).items()})
        self._send(200, "<title>Saved</title><h1>Saved</h1>")

    _send = Handler._send
    log_message = Handler.log_message


def _serve(pages: dict[str, str]) -> tuple[HTTPServer, str]:
    handler = type("H", (SiteHandler,), {"pages": pages})
    srv = HTTPServer(("127.0.0.1", 0), handler)
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    return srv, f"127.0.0.1:{srv.server_port}"


def test_authorized_transfer_between_two_real_sites(gate_home, tmp_path):
    source_srv, source = _serve({"/": SOURCE_PAGE})
    dest_srv, dest = _serve({"/new": DEST_PAGE})
    SiteHandler.received = []
    grant = {"source": [source], "destination": [dest], "fields": ["email", "phone"], "purpose": "copy the customer's contact into the other system"}
    params = _params(gate_home, tmp_path / "profile")
    params = params.model_copy(update={"env": {**params.env, "SECRET_GATE_SCOPE": "real-e2e-scope-0123456789ab",
                                               "SECRET_GATE_TRANSFER": json.dumps(grant)}})
    shots = Path(os.environ.get("SG_E2E_SHOTS", tmp_path))

    async def scenario() -> dict:
        async with stdio_client(params) as (read, write), ClientSession(read, write) as s:
            await asyncio.wait_for(s.initialize(), 60)
            await s.call_tool("browser_navigate", {"url": f"http://{source}/"})
            snap = _text(await s.call_tool("browser_snapshot", {}))
            source_shot = await s.call_tool("browser_take_screenshot", {})
            refs = [w.strip('",') for w in snap.split() if w.startswith("enc:ref:") or w.startswith('"enc:ref:')]
            await s.call_tool("browser_navigate", {"url": f"http://{dest}/new"})
            form = _text(await s.call_tool("browser_snapshot", {}))
            fills = [await s.call_tool("secret_fill", {"target": _ref(form, name), "token": ref})
                     for name, ref in zip(("Email", "Phone"), dict.fromkeys(refs))]
            dest_snap = _text(await s.call_tool("browser_snapshot", {}))
            dest_shot = await s.call_tool("browser_take_screenshot", {})
            await s.call_tool("browser_click", {"target": _ref(form, "Save"), "element": "save"})
            await s.call_tool("browser_wait_for", {"text": "Saved"})
            return {"snap": snap, "refs": list(dict.fromkeys(refs)), "fills": fills, "dest_snap": dest_snap,
                    "source_shot": source_shot, "dest_shot": dest_shot}

    try:
        r = asyncio.run(asyncio.wait_for(scenario(), 150))
    finally:
        source_srv.shutdown()
        dest_srv.shutdown()
    import base64

    for name in ("source_shot", "dest_shot"):
        assert not r[name].isError, _text(r[name])
        image = next(c for c in r[name].content if isinstance(c, types.ImageContent))
        (shots / f"transfer-{name}.png").write_bytes(base64.b64decode(image.data))
        assert _magenta_pixels(r[name]) > 0
    assert all(v not in r["snap"] for v in CONTACT.values()) and len(r["refs"]) == 2
    assert "page/email-1" in r["snap"] and "page/phone-1" in r["snap"]
    for fill in r["fills"]:
        assert not fill.isError, _text(fill)
    assert all(v not in r["dest_snap"] for v in CONTACT.values())
    assert SiteHandler.received == [CONTACT]  # the destination got the real values, the model never did
    audit = (gate_home / "logs" / "browser-audit.jsonl").read_text()
    assert all(v not in audit for v in CONTACT.values())
