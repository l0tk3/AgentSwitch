""""Cannot reconstruct" (gate-simple-v0 §0 goal 2, §3, §7): sites and commands echo a value in every way we could
think of, through every exit that returns text to the model; everything the model could see, put together, holds no
run of 4 characters of the value in any case, and the value in none of the encodings below.

The checks here are written independently of redact.py (their own list of encodings, their own base64 scan), so a
form the redactor forgets fails here rather than being forgotten twice.
"""

from __future__ import annotations

import asyncio
import base64
import gzip
import html
import json
import re
import subprocess
from urllib.parse import quote, quote_plus

import httpx
import pytest
import respx
from mitmproxy import http
from mitmproxy.test import taddons, tflow
from mitmproxy.websocket import WebSocketMessage
from wsproto.frame_protocol import Opcode

from secret_gate.browser_gate import BrowserGate
from secret_gate.constants import MAX_BODY_BYTES, USE_EXEC, USE_FILL, USE_HTTP
from secret_gate.gate_ops import op_exec, op_http
from secret_gate.policy import SecretPayload
from secret_gate.proxy_addon import SecretGateAddon
from secret_gate.resolver import Resolution
from secret_gate.tokens import make_token
from tests.fixtures import fake_secrets as fs
from tests.test_browser_gate import FakePlaywright

HOST = "login.portal-a.example.com"
# One plain ASCII password and one with everything an encoder touches: space, quotes, <&>, slash, non-ASCII, emoji.
VALUES = (fs.PORTAL.password, "pä ss'wörd<&>/\"x9 \U0001f511")
LABEL = "site/login"


def echoes(v: str) -> list[str]:
    """The ways a site or a command gives a value back, each as one output."""
    raw = v.encode()
    out = [v, f"Welcome! your password is {v}.", v[:-1], v[1:], v[: len(v) // 2 + 2], v.upper(), v.lower(), v.swapcase(),
           v.title(), json.dumps({"password": v}), json.dumps({"password": v}, ensure_ascii=False),
           f"<input value=\"{html.escape(v)}\">", f"?pw={quote(v, safe='')}", f"pw={quote_plus(v)}",
           "'" + json.dumps(v)[1:-1].replace("'", "\\'") + "'", raw.hex(), raw.hex().upper(),
           "".join(f"%{b:02X}" for b in raw), "".join(f"&#{ord(c)};" for c in v)]
    for prefix in (b"", b"x", b"xy", b"alice:", b'{"pw":"'):
        for enc in (base64.b64encode, base64.urlsafe_b64encode):
            encoded = enc(prefix + raw).decode()
            out += [encoded, encoded.rstrip("="), f"Authorization: Basic {encoded}"]
    for k in range(1, len(v)):  # split in two at every point, the halves apart
        out.append(f"first={v[:k]} ... second={v[k:]}")
        out.append(f"first={v[:k].upper()} ... second={v[k:].lower()}")
    return out


def fold(text: str) -> str:
    return "".join(c.lower() if len(c.lower()) == 1 else c for c in text)


def leaks(seen: str, v: str) -> list[str]:
    """What of `v` the model could rebuild from `seen`: every 4-character run (any case), every listed encoding, any
    base64 run that decodes to bytes holding the value."""
    found = []
    seen_folded, v_folded = fold(seen), fold(v)
    found += [g for g in {v_folded[i:i + 4] for i in range(len(v_folded) - 3)} if g in seen_folded]
    raw = v.encode()
    forms = {quote(v, safe=""), quote_plus(v), html.escape(v), json.dumps(v)[1:-1], json.dumps(v, ensure_ascii=False)[1:-1],
             raw.hex(), "".join(f"%{b:02x}" for b in raw), "".join(f"&#{ord(c)};" for c in v)}
    found += [f for f in forms if fold(f) in seen_folded]
    for run in re.findall(r"[A-Za-z0-9+/_-]{4,}", seen):
        alphabet = run.replace("-", "+").replace("_", "/")
        for offset in range(4):
            part = alphabet[offset:]
            part = part[: len(part) - len(part) % 4] if len(part) % 4 == 1 else part
            if part and raw in base64.b64decode(part + "=" * (-len(part) % 4)):
                found.append(f"base64 {run}")
    return found


def assert_unrecoverable(outputs: list[str], v: str) -> None:
    seen = "\n".join(outputs)  # separate outputs: a fragment at the end of one does not join the next
    assert leaks(seen, v) == []


def test_the_checker_itself_finds_every_echo():
    for v in VALUES:
        for echo in echoes(v)[:-2 * (len(v) - 1)]:  # whole forms: each one alone must be caught
            assert leaks(echo, v), echo


def _token(keypair, v: str, uses=(USE_HTTP,)) -> str:
    return make_token(keypair.public, SecretPayload.create(value=v, hosts=[HOST], uses=set(uses), label=LABEL))


# -- the proxy ---------------------------------------------------------------------------------------------------------

def _flow(body: bytes) -> http.HTTPFlow:
    f = tflow.tflow()
    f.request.host, f.request.scheme, f.request.port, f.request.path, f.request.method = HOST, "https", 443, "/login", "POST"
    f.request.headers.clear()
    f.request.headers["Host"] = HOST
    f.request.content = body
    return f


def _seen(response: http.Response) -> list[str]:
    parts = [str(response.status_code), response.reason, response.get_content(strict=False).decode("utf-8", "replace")]
    parts += [f"{k}: {v}" for k, v in response.headers.items(multi=True)]
    if response.trailers is not None:
        parts += [f"{k}: {v}" for k, v in response.trailers.items(multi=True)]
    return parts


@pytest.mark.parametrize("v", VALUES)
def test_proxy_responses_headers_trailers_and_later_pages(resolver, keypair, v):
    addon = SecretGateAddon(resolver)
    token = _token(keypair, v)
    seen: list[str] = []
    with taddons.context(addon):
        for echo in echoes(v):
            f = _flow(f"pw={token}".encode())
            addon.request(f)
            assert f.response is None and v in f.request.text
            f.response = http.Response.make(200, echo.encode(), {"Content-Type": "text/html; charset=utf-8",
                                                                  "X-Echo": echo.encode("utf-8")})
            f.response.trailers = http.Headers(x_trailer=echo.encode("utf-8"))
            addon.response(f)
            seen += _seen(f.response)
        later = _flow(b"")  # the profile page of the same session: no value in its request
        addon.request(later)
        later.response = http.Response.make(200, f"profile: password={v}".encode(), {"Content-Type": "text/plain"})
        addon.response(later)
        seen += _seen(later.response)
    assert f"password=[REDACTED:{LABEL}]" in later.response.get_content().decode("utf-8", "replace")
    assert_unrecoverable(seen, v)


@pytest.mark.parametrize("v", VALUES)
def test_proxy_withholds_what_it_cannot_redact(resolver, keypair, v):
    addon = SecretGateAddon(resolver)
    token = _token(keypair, v)
    cases = {
        "too large": (("x" * MAX_BODY_BYTES + v).encode(), {}),
        "too large once decoded": (gzip.compress(("x" * MAX_BODY_BYTES + v).encode()), {"Content-Encoding": "gzip"}),
        "unknown encoding": (v.encode(), {"Content-Encoding": "x-custom"}),
        "stacked encodings": (gzip.compress(v.encode()), {"Content-Encoding": "gzip, br"}),
        "broken gzip": (b"\x1f\x8b" + v.encode(), {"Content-Encoding": "gzip"}),
        "a charset hiding it": (f"pw={v}".encode(), {"Content-Type": "text/plain; charset=utf-16"}),
    }
    seen = []
    with taddons.context(addon):
        for name, (body, headers) in cases.items():
            f = _flow(f"pw={token}".encode())
            addon.request(f)
            fields = [(k.encode(), v.encode()) for k, v in {"Content-Type": "text/plain", **headers}.items()]
            f.response = http.Response(b"HTTP/1.1", 200, b"OK", http.Headers(fields), body, None, 0, 0)  # as received
            addon.response(f)
            if name != "a charset hiding it":  # that one is withheld, or redacted when the text fell back to UTF-8
                assert f.response.headers.get("X-Secret-Gate") == "withheld", name
                assert len(f.response.raw_content) < 1000
            seen += _seen(f.response)
    assert "内容过大，已扣下" in "\n".join(seen)
    assert_unrecoverable(seen, v)


@pytest.mark.parametrize("v", VALUES)
def test_proxy_websocket_messages_from_the_server(resolver, keypair, v):
    addon = SecretGateAddon(resolver)
    token = _token(keypair, v)
    f = tflow.twebsocketflow(messages=False)
    f.request.host, f.request.port, f.request.scheme = HOST, 443, "https"
    f.request.headers["Host"] = HOST
    f.request.headers["Authorization"] = f"Bearer {token}"
    seen = []
    with taddons.context(addon):
        addon.request(f)
        assert f.request.headers["Authorization"] == f"Bearer {v}"
        for echo in [*echoes(v), "y" * MAX_BODY_BYTES + v]:
            for kind in (Opcode.TEXT, Opcode.BINARY):
                f.websocket.messages.append(WebSocketMessage(kind, False, echo.encode()))
                addon.websocket_message(f)
                message = f.websocket.messages[-1]
                if not message.dropped:
                    seen.append(message.content.decode("utf-8", "replace"))
        assert f.websocket.messages[-1].dropped  # the oversized one
        f.websocket.messages.append(WebSocketMessage(Opcode.TEXT, True, b"from the client"))
        addon.websocket_message(f)
        assert f.websocket.messages[-1].content == b"from the client"
    assert_unrecoverable(seen, v)


def test_a_redactor_failure_drops_the_websocket_message(resolver, keypair, monkeypatch):
    addon = SecretGateAddon(resolver)
    f = tflow.twebsocketflow(messages=False)
    f.request.host, f.request.port = HOST, 443
    f.request.headers["Host"] = HOST
    f.request.headers["Authorization"] = f"Bearer {_token(keypair, VALUES[0])}"
    with taddons.context(addon):
        addon.request(f)
        monkeypatch.setattr("secret_gate.proxy_addon.Redactor", lambda *a: (_ for _ in ()).throw(ValueError("x")))
        f.websocket.messages.append(WebSocketMessage(Opcode.TEXT, False, VALUES[0].encode()))
        addon.websocket_message(f)
    assert f.websocket.messages[-1].dropped


def test_a_streamed_response_of_a_session_is_read_whole(resolver, keypair):
    addon = SecretGateAddon(resolver)
    f = _flow(f"pw={_token(keypair, VALUES[0])}".encode())
    with taddons.context(addon):
        addon.request(f)
        f.response = http.Response.make(200, b"")
        f.response.stream = True
        addon.responseheaders(f)
        assert f.response.stream is False
        f.response.raw_content = None  # a body that went past the addon anyway is withheld
        addon.response(f)
    assert f.response.headers["X-Secret-Gate"] == "withheld"


# -- secret_http and secret_exec ----------------------------------------------------------------------------------------

@pytest.mark.parametrize("v", VALUES)
@respx.mock
def test_secret_http_results(resolver, keypair, v):
    token = _token(keypair, v)
    seen = []
    bodies = [(echo.encode(), {"X-Echo": echo.encode()}) for echo in echoes(v)]
    bodies += [(("x" * MAX_BODY_BYTES + v).encode(), {}), (v.encode(), {"Content-Encoding": "x-custom"}),
               (f"pw={v}".encode(), {"Content-Type": "text/plain; charset=utf-16"})]
    route = respx.post(f"https://{HOST}/login")
    for body, headers in bodies:
        route.mock(return_value=httpx.Response(200, content=body, headers=headers))
        result = op_http(resolver, method="POST", url=f"https://{HOST}/login", body=f"pw={token}")
        seen += [result.body, *(f"{k}: {x}" for k, x in result.headers.items())]
    assert "内容过大，已扣下" in "\n".join(seen) and "content-encoding could not be decoded" in "\n".join(seen)
    assert_unrecoverable(seen, v)


@respx.mock
def test_secret_http_withholds_when_the_redactor_fails(resolver, keypair, monkeypatch):
    respx.get(f"https://{HOST}/").mock(return_value=httpx.Response(200, text=VALUES[0], headers={"X": VALUES[0]}))
    monkeypatch.setattr("secret_gate.redact.Redactor.__call__", lambda *a: (_ for _ in ()).throw(ValueError("x")))
    result = op_http(resolver, method="GET", url=f"https://{HOST}/?p={_token(keypair, VALUES[0])}")
    assert result.headers == {} and "withheld" in result.body and VALUES[0] not in result.body


def _exec_resolve(resolver):
    return lambda token: resolver.resolve_exact(token, use=USE_EXEC)


@pytest.mark.parametrize("v", VALUES)
def test_secret_exec_output(resolver, keypair, v):
    token = _token(keypair, v, uses=(USE_EXEC,))
    seen = []
    for out in [*echoes(v), "z" * MAX_BODY_BYTES + v]:
        def runner(argv, out=out, **kw):
            return subprocess.CompletedProcess(argv, 0, stdout=out, stderr=f"debug: {out}")

        result = op_exec(_exec_resolve(resolver), argv=["prog"], env={"PW": token}, runner=runner)
        seen += [result.stdout, result.stderr]
    assert "内容过大，已扣下" in seen[-1]
    assert_unrecoverable(seen, v)


@pytest.mark.posix
def test_secret_exec_really_running_env_printenv_and_set_x(resolver, keypair):
    v = VALUES[0]
    token = _token(keypair, v, uses=(USE_EXEC,))
    script = ('set -x; printenv PW; echo "${PW%??????}"; echo "${PW#????????}"; '
              'printf %s "$PW" | od -An -tx1 | tr -d " \\n"; echo; env')
    result = op_exec(_exec_resolve(resolver), argv=["/bin/sh", "-c", script], env={"PW": token})
    assert result.returncode == 0
    assert_unrecoverable([result.stdout, result.stderr], v)


@pytest.mark.windows
def test_secret_exec_really_running_set_echo_and_powershell_on_windows(resolver, keypair):
    """The same as above with cmd's `set`/`echo` and PowerShell's slicing and hex (gate-simple-v0 §5)."""
    from tests import shell

    v = VALUES[0]
    token = _token(keypair, v, uses=(USE_EXEC,))
    seen = []
    for argv in (["cmd", "/d", "/c", "echo on & set PW & echo %PW%"],
                 shell.powershell("$env:PW.Substring(0, $env:PW.Length - 6); $env:PW.Substring(8); "
                                  "-join ([Text.Encoding]::UTF8.GetBytes($env:PW) | % { $_.ToString('x2') }); "
                                  "Get-ChildItem env: | Format-List")):
        result = op_exec(_exec_resolve(resolver), argv=argv, env={"PW": token})
        assert result.returncode == 0, result
        seen += [result.stdout, result.stderr]
    assert_unrecoverable(seen, v)


# -- the browser gate ---------------------------------------------------------------------------------------------------

@pytest.mark.parametrize("v", VALUES)
def test_browser_results(resolver, keypair, v):
    pw = FakePlaywright(f"https://{HOST}/signin")
    gate = BrowserGate(resolver, pw)
    token = _token(keypair, v, uses=(USE_HTTP, USE_FILL))
    seen = []

    def text_of(blocks) -> str:
        return "\n".join(getattr(b, "text", "") for b in blocks)

    seen.append(text_of(asyncio.run(gate.call_tool("secret_fill", {"target": "e7", "token": token}))))
    assert pw.typed["e7"] == v
    for echo in echoes(v):
        pw.echo = f"- paragraph: {echo}"
        seen.append(text_of(asyncio.run(gate.call_tool("browser_snapshot", {}))))
        seen.append(text_of(asyncio.run(gate.call_tool("browser_find", {"text": "paragraph"}))))
    pw.typed["e9"] = v[: len(v) // 2 + 1]  # a field the gate did not fill, holding part of the value
    seen.append(text_of(asyncio.run(gate.call_tool("browser_snapshot", {}))))
    assert_unrecoverable(seen, v)


# -- logs.tail and error text -------------------------------------------------------------------------------------------

def test_logs_tail_hides_values_the_service_used(tmp_path):
    from secret_gate.rpc_methods import redacted_log
    from tests.service_fixtures import running_service
    from tests.test_rpc import _token as rpc_token

    v = VALUES[0]
    with running_service() as svc:
        token = rpc_token(svc, value=v, uses=(USE_HTTP, USE_FILL), hosts=[HOST], label=LABEL)
        (svc.home / "logs").mkdir(exist_ok=True)
        lines = [f"HTTP protocol error in server response: {echo}" for echo in echoes(v)]
        (svc.home / "logs" / "proxy.log").write_text("\n".join(lines) + "\n")
        before = svc.client.call("logs.tail", {"name": "proxy", "lines": 500})["text"]
        assert v in before  # nothing tells the service about this value yet
        svc.client.call("browser.resolve", {"token": token, "host": f"{HOST}:443"})
        after = svc.client.call("logs.tail", {"name": "proxy", "lines": 500})["text"]
        assert_unrecoverable([after], v)
        # A value behind a live reference is known without having been used by this service process.
        other = "Ref3renced-Only-V4lue"
        ref_token = rpc_token(svc, value=other, hosts=[HOST], label="site/other")
        svc.client.call("refs.register", {"scope": "logs-scope-0123456789abcdef", "tokens": [ref_token]})
        (svc.home / "logs" / "proxy.log").write_text(f"error for {other} and {other.upper()[:9]}\n")
        assert_unrecoverable([redacted_log((svc.home / "logs" / "proxy.log").read_text(), svc.home)], other)


def test_tool_errors_name_only_the_kind_of_failure():
    from secret_gate.mcp_server import build_server

    class Backend:
        def http(self, *a):
            raise httpx.ConnectError(f"cannot connect to https://{HOST}/login?pw={VALUES[0]}")

        def exec(self, *a):
            raise UnicodeDecodeError("utf-8", VALUES[0].encode(), 0, 1, VALUES[0])

    server = build_server(Backend())
    seen = []
    for tool, args in (("secret_http", {"method": "GET", "url": "https://x"}), ("secret_exec", {"argv": ["t"], "env": {"T": "t"}})):
        with pytest.raises(Exception) as exc:
            asyncio.run(server.call_tool(tool, args))
        seen.append(str(exc.value))
    assert "ConnectError" in seen[0]
    assert_unrecoverable(seen, VALUES[0])


def test_redactor_over_whole_values_and_fragments_directly():
    from secret_gate.redact import Redactor

    r = Redactor([Resolution("t", LABEL, v) for v in VALUES])
    for v in VALUES:
        assert_unrecoverable([r(e) for e in echoes(v)], v)
    # Three characters of a value stay; that is what the fragment rule allows.
    assert r("Hun") == "Hun" and r("hunt") == f"[REDACTED:{LABEL}]"
    # A marker is not redacted again, even when the label shares 4 characters with the value.
    same = Redactor([Resolution("t", "Hunter-label", fs.PORTAL.password)])
    once = same(f"a {fs.PORTAL.password} b")
    assert once == "a [REDACTED:Hunter-label] b" and same(once) == once
