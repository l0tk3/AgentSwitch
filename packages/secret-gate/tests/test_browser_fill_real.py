"""Real Chromium through `secret-gate browser` + Playwright MCP against a local login page.

Opt-in (launches a browser, ~10 s): SG_BROWSER_E2E=1 pytest tests/test_browser_fill_real.py
Needs `npx -y @playwright/mcp@0.0.82` cached. No model, no proxy: this isolates the fill path.

The page validates the username as an e-mail in JavaScript before submitting, which is exactly
what defeats typing a 201-character token. With secret_fill the real value is in the DOM, so the
check passes and the server receives plaintext, while every result the client sees is redacted.
"""

from __future__ import annotations

import asyncio
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
            shot = await s.call_tool("browser_take_screenshot", {})
            await s.call_tool("browser_click", {"target": go_ref, "element": "submit"})
            await s.call_tool("browser_wait_for", {"text": "Welcome"})
            after = _text(await s.call_tool("browser_snapshot", {}))
            shot_after = await s.call_tool("browser_take_screenshot", {})
            data_nav = await s.call_tool("browser_navigate", {"url": "data:text/html,<textarea>"})
            return {"blocked": blocked, "control": received_after_control, "fill_u": fill_u, "fill_p": fill_p,
                    "filled": filled, "shot": shot, "after": after, "shot_after": shot_after, "data_nav": data_nav}

    r = asyncio.run(asyncio.wait_for(scenario(), 120))
    assert "invalid email" in r["blocked"] and r["control"] == []
    for res in (r["fill_u"], r["fill_p"]):
        assert not res.isError, _text(res)
        assert EMAIL not in _text(res) and "Hunter2" not in _text(res) and ".yml" not in _text(res)
    assert EMAIL not in r["filled"] and PASSWORD not in r["filled"]
    assert "[REDACTED:demo/user]" in r["filled"]
    assert r["shot"].isError and "screenshot refused" in _text(r["shot"])
    assert Handler.received == [{"u": EMAIL, "p": PASSWORD}]
    assert EMAIL not in r["after"] and "[REDACTED:demo/user]" in r["after"]  # server echoed it back
    assert r["shot_after"].isError and "screenshot refused" in _text(r["shot_after"])  # "Welcome <email>" on screen
    assert r["data_nav"].isError and "http(s)" in _text(r["data_nav"])
    # Playwright MCP persists unredacted snapshots; they must land in the gate home (0700), be swept
    # after every call, and never appear under the cwd.
    assert not (Path.cwd() / ".playwright-mcp").exists()
    assert (gate_home / "browser-out").stat().st_mode & 0o077 == 0
    assert [p for p in (gate_home / "browser-out").iterdir() if p.is_file()] == []
