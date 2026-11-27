"""The model traffic gateway (2026-11-25, AgentSwitch room #320-#332): a terminal's agent talks to its model through
this proxy, which puts a placeholder in place of every value the user listed on the way to the model, and the value
back on the way to the agent — so the model's provider never receives it, and the agent works with it as before.

Who is who: each terminal is a *scope*, named in the proxy credentials its launcher gives it
(`http://s:<scope>@127.0.0.1:<port>`). A scope says:
  - `hosts`: the model's addresses; only these are opened (TLS terminated with this proxy's CA). Every other
    connection is passed through as it is, never decrypted;
  - `upstream`: the proxy this terminal would have used without the gateway (a profile's forwarder, Clash), or none:
    every connection of the scope, opened or not, goes on through it, so the route out is the one it was;
  - `pairs`: `{value, ref, restore}` — `value` becomes `ref` in what is sent; `ref` becomes `value` again in what comes
    back when `restore` (a placeholder too plain to be told from ordinary text is replaced one way only);
  - `patterns`: `{pattern, ref?, salt?, restore}` — regular expressions (AgentSwitch room #596): each piece of text
    one matches is a value of its own, replaced by `ref` when the user gave one (one way only), else by the
    placeholder the service would give that text as a plain word (`hash_ref`, the profile's salt). Read with
    `re.ASCII`, so that digits and word characters are what JavaScript takes them to be (the service refuses what
    the two read otherwise). What was
    replaced is remembered per scope, so that the placeholder is put back when it comes back;
  - `log`: whether both sides are written down (before: what the agent sent and got; after: what the model's
    provider got and sent).

The table comes on stdin, one JSON object a line, the whole table each time (`{"scopes": {...}, "logDir": ...}`):
it is never written to disk here. Streams are rewritten as they come (SSE and WebSocket): a placeholder split over
two pieces is put together first (`Swapper`), holding back at most one placeholder's length.
"""

from __future__ import annotations

import base64
import hashlib
import hmac
import json
import os
import re
import sys
import threading
import time
from dataclasses import dataclass, field
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

PROXY_USER = "s"
MAX_LOG_ENTRY = 1 << 20          # one request or response in a log: the first MiB of it
MAX_LOG_FILE = 64 << 20          # one day's log of one scope, each side
LOG_FULL = "[log full for today: later entries are not written]"
MAX_LEARNED = 10_000             # what a scope's patterns matched, remembered to be put back
BASE32 = "abcdefghijklmnopqrstuvwxyz234567"


# ---- the table ----------------------------------------------------------------------------------------------------

@dataclass(frozen=True)
class Pair:
    value: str
    ref: str
    restore: bool = True


@dataclass(frozen=True)
class Pattern:
    regex: re.Pattern[str]
    ref: str | None = None
    salt: bytes | None = None
    restore: bool = True


def hash_ref(salt: bytes, value: str) -> str:
    """The salted placeholder of a value, as the service makes it (daemon vault/words.ts `hashRef`): `h_` and the
    first ten base32 letters of HMAC-SHA256(salt, value)."""
    mac = hmac.new(salt, value.encode("utf-8"), hashlib.sha256).digest()
    bits = int.from_bytes(mac[:7], "big")      # 56 bits: the first 50 are read
    return "h_" + "".join(BASE32[(bits >> (51 - 5 * i)) & 31] for i in range(10))


@dataclass
class Scope:
    hosts: tuple[str, ...] = ()
    upstream: str | None = None
    pairs: tuple[Pair, ...] = ()
    patterns: tuple[Pattern, ...] = ()
    log: bool = False

    def opens(self, host: str | None) -> bool:
        if not host:
            return False
        # An IPv6 address is written with brackets in a URL (the service's `hostOf`) and without them by the proxy.
        host = host.lower().rstrip(".").strip("[]")
        for h in self.hosts:
            h = h.lower().strip("[]")
            if h == host or (h.startswith("*.") and host.endswith(h[1:])):
                return True
        return False


@dataclass
class Table:
    scopes: dict[str, Scope] = field(default_factory=dict)
    log_dir: Path | None = None

    @classmethod
    def parse(cls, line: str) -> Table:
        o = json.loads(line)
        scopes: dict[str, Scope] = {}
        for name, s in (o.get("scopes") or {}).items():
            pairs = tuple(
                Pair(str(p["value"]), str(p["ref"]), bool(p.get("restore", True)))
                for p in s.get("pairs") or []
                if isinstance(p, dict) and p.get("value") and p.get("ref")
            )
            scopes[str(name)] = Scope(
                hosts=tuple(str(h) for h in s.get("hosts") or []),
                upstream=s.get("upstream") or None,
                pairs=pairs,
                patterns=tuple(p for p in (pattern_of(x) for x in s.get("patterns") or []) if p),
                log=bool(s.get("log")),
            )
        return cls(scopes, Path(o["logDir"]) if o.get("logDir") else None)


def pattern_of(o: Any) -> Pattern | None:
    """A pattern of the table; None: not one (it does not compile here, or has neither a placeholder nor a salt)."""
    if not isinstance(o, dict) or not isinstance(o.get("pattern"), str):
        return None
    try:
        regex = re.compile(o["pattern"], re.ASCII)
        salt = bytes.fromhex(o["salt"]) if isinstance(o.get("salt"), str) else None
    except (re.error, ValueError):
        print("model gate: a pattern was not taken", file=sys.stderr)
        return None
    ref = o.get("ref") if isinstance(o.get("ref"), str) and o.get("ref") else None
    if ref is None and salt is None:
        return None
    return Pattern(regex, ref, salt, bool(o.get("restore", True)) and ref is None)


# ---- swapping -----------------------------------------------------------------------------------------------------

def forms(value: str) -> list[str]:
    """A value as it may stand in a request: as it is, and JSON-escaped (with and without \\u escapes)."""
    out = [value, json.dumps(value, ensure_ascii=False)[1:-1], json.dumps(value)[1:-1]]
    return list(dict.fromkeys(f for f in out if f))


def hide(text: str, pairs: tuple[Pair, ...], patterns: tuple[Pattern, ...] = (), learned: dict[str, str] | None = None) -> str:
    """value -> ref, the longest value first (a value that is part of another is not split); then what each pattern
    matches, each piece to its own placeholder — remembered in `learned` (ref -> value) to be put back."""
    for p in sorted(pairs, key=lambda p: -len(p.value)):
        for f in forms(p.value):
            if f in text:
                text = text.replace(f, p.ref)
    if not patterns:
        return text
    placed = {p.ref for p in pairs} | set(learned or ())

    def swap(pat: Pattern, m: re.Match[str]) -> str:
        value = m.group(0)
        if value in placed:
            return value
        ref = pat.ref or hash_ref(pat.salt or b"", value)
        placed.add(ref)
        if pat.restore and learned is not None:
            learned.pop(ref, None)
            learned[ref] = value
            while len(learned) > MAX_LEARNED:
                learned.pop(next(iter(learned)))
        return ref

    def each(s: str) -> str:
        for pat in patterns:
            s = pat.regex.sub(lambda m, pat=pat: swap(pat, m), s)
        return s

    # A JSON body: in its strings as they read, so that no match takes in a quote or a brace of the JSON itself;
    # written again only when something was replaced.
    try:
        doc = json.loads(text)
    except ValueError:
        return each(text)
    changed = False

    def walk(v: Any) -> Any:
        nonlocal changed
        if isinstance(v, str):
            out = each(v)
            changed = changed or out != v
            return out
        if isinstance(v, list):
            return [walk(x) for x in v]
        if isinstance(v, dict):
            return {k: walk(x) for k, x in v.items()}
        return v

    doc = walk(doc)
    return json.dumps(doc, ensure_ascii=False, separators=(",", ":")) if changed else text


class Swapper:
    """ref -> value in what comes back, piece by piece: a stream's text arrives cut anywhere, a placeholder too."""

    def __init__(self, pairs: tuple[Pair, ...], learned: dict[str, str] | None = None):
        self.back = {**(learned or {}), **{p.ref: p.value for p in pairs if p.restore}}
        self.carry: dict[Any, str] = {}
        self.tmpl: dict[Any, Any] = {}

    def whole(self, s: str) -> str:
        for ref in sorted(self.back, key=len, reverse=True):
            if ref in s:
                s = s.replace(ref, self.back[ref])
        return s

    def walk(self, v: Any) -> Any:
        if isinstance(v, str):
            return self.whole(v)
        if isinstance(v, list):
            return [self.walk(x) for x in v]
        if isinstance(v, dict):
            return {k: self.walk(x) for k, x in v.items()}
        return v

    def _hold(self, s: str) -> tuple[str, str]:
        best = 0
        for ref in self.back:
            for k in range(min(len(ref) - 1, len(s)), 0, -1):
                if s.endswith(ref[:k]):
                    best = max(best, k)
                    break
        return (s[: len(s) - best], s[len(s) - best :]) if best else (s, "")

    @staticmethod
    def deltas(o: Any) -> list[tuple[Any, dict, str]]:
        """The streamed text pieces of one event: (which stream, the object holding it, its field)."""
        out: list[tuple[Any, dict, str]] = []
        if not isinstance(o, dict):
            return out
        resp = o.get("response") if isinstance(o.get("response"), dict) else o
        if isinstance(resp.get("candidates"), list):                                 # Gemini / Cloud Code
            for ci, c in enumerate(resp["candidates"]):
                if not isinstance(c, dict):
                    continue
                content = c.get("content") if isinstance(c.get("content"), dict) else {}
                parts = content.get("parts") if isinstance(content.get("parts"), list) else []
                for pi, part in enumerate(parts):
                    if isinstance(part, dict) and isinstance(part.get("text"), str):
                        out.append((("g", c.get("index", ci), pi), part, "text"))
            return out
        t = o.get("type") if isinstance(o.get("type"), str) else ""
        if t == "content_block_delta" and isinstance(o.get("delta"), dict):           # Anthropic Messages
            for f in ("text", "partial_json", "thinking"):
                if isinstance(o["delta"].get(f), str):
                    out.append((("a", o.get("index"), f), o["delta"], f))
        elif t.endswith(".delta") and isinstance(o.get("delta"), str):               # OpenAI Responses
            out.append((("r", t, o.get("item_id"), o.get("output_index"), o.get("content_index")), o, "delta"))
        elif isinstance(o.get("choices"), list):                                     # Chat Completions
            for c in o["choices"]:
                if not isinstance(c, dict):
                    continue
                d = c.get("delta") if isinstance(c.get("delta"), dict) else {}
                for f in ("content", "reasoning_content", "reasoning"):
                    if isinstance(d.get(f), str):
                        out.append((("c", c.get("index"), f), d, f))
                for tc in d.get("tool_calls") if isinstance(d.get("tool_calls"), list) else []:
                    if not isinstance(tc, dict):
                        continue
                    fn = tc.get("function") if isinstance(tc.get("function"), dict) else {}
                    if isinstance(fn.get("arguments"), str):
                        out.append((("c", c.get("index"), "tool", tc.get("index")), fn, "arguments"))
        return out

    def event(self, o: Any) -> list[Any]:
        """One event in; the events to send on (what was held back comes out, as a delta of its own, before any
        event that is not a delta, and before a chunk that finishes)."""
        if not self.back:
            return [o]
        ds = self.deltas(o)
        finishing = isinstance(o, dict) and isinstance(o.get("choices"), list) and any(
            isinstance(c, dict) and c.get("finish_reason") for c in o["choices"])
        out: list[Any] = []
        if not ds or finishing:
            out += self.flush()
        if not ds:
            return out + [self.walk(o)]
        for key, box, f in ds:
            s = self.whole(self.carry.pop(key, "") + box[f])
            emit, held = self._hold(s)
            box[f] = emit
            if held:
                self.carry[key] = held
                self.tmpl[key] = json.loads(json.dumps(o))
        # Gemini / Cloud Code: a tool call's arguments and a tool result come whole beside the streamed text (its
        # `functionCall.args` is an object, not a delta string), so the rest of the event is put back too.
        if isinstance(o.get("response"), dict) or isinstance(o.get("candidates"), list):
            o = self.walk(o)
        return out + [o]

    def flush(self) -> list[Any]:
        out = []
        for key, held in list(self.carry.items()):
            t = self.tmpl[key]
            for k2, box, f in self.deltas(t):
                box[f] = held if k2 == key else ""
            out.append(t)
        self.carry.clear()
        return out


class SSE:
    """An event stream's bytes in, rewritten bytes out (events split anywhere across chunks)."""

    def __init__(self, sw: Swapper):
        self.sw = sw
        self.buf = b""
        # Why an event went on as it came, if one did.
        self.failed: str | None = None

    def _safe(self, block: bytes) -> bytes:
        """An event rewritten; one that cannot be goes on as it came: a stream is never cut for it."""
        try:
            return self._block(block)
        except Exception as err:  # noqa: BLE001
            self.failed = f"{type(err).__name__}: {err}"
            return block + b"\n\n"

    def feed(self, chunk: bytes) -> bytes:
        if not chunk:
            rest, self.buf = self.buf, b""
            tail = self._safe(rest) if rest.strip() else b""
            try:
                held = b"".join(self._render("", e) for e in self.sw.flush())
            except Exception as err:  # noqa: BLE001
                self.failed, held = f"{type(err).__name__}: {err}", b""
            return tail + held
        self.buf = (self.buf + chunk).replace(b"\r\n", b"\n")   # a \r\n split over two chunks too
        out = b""
        while True:
            i = self.buf.find(b"\n\n")
            if i < 0:
                break
            block, self.buf = self.buf[:i], self.buf[i + 2 :]
            out += self._safe(block)
        return out

    @staticmethod
    def _render(ev: str, o: Any) -> bytes:
        return (f"event: {ev}\n" if ev else "").encode() + b"data: " + json.dumps(o, ensure_ascii=False).encode() + b"\n\n"

    def _block(self, block: bytes) -> bytes:
        text = block.decode("utf-8", "replace")
        lines = text.split("\n")
        ev = next((l[6:].strip() for l in lines if l.startswith("event:")), "")
        data = "\n".join(l[5:].lstrip() for l in lines if l.startswith("data:"))
        try:
            o = json.loads(data)
        except ValueError:
            return (self.sw.whole(text) + "\n\n").encode()   # [DONE], comments, pings
        res = b""
        for e in self.sw.event(o):
            e_ev = e.get("type", ev) if (ev and isinstance(e, dict) and isinstance(e.get("type"), str)) else ev
            res += self._render(e_ev, e)
        return res


# ---- logs ---------------------------------------------------------------------------------------------------------

class Logs:
    def __init__(self) -> None:
        self.lock = threading.Lock()

    def write(self, table: Table, scope_name: str, side: str, entry: dict) -> None:
        if table.log_dir is None:
            return
        day = time.strftime("%Y-%m-%d")
        d = table.log_dir / scope_name
        path = d / f"{day}.{side}.jsonl"
        body = entry.get("body")
        if isinstance(body, str) and len(body) > MAX_LOG_ENTRY:
            entry = {**entry, "body": body[:MAX_LOG_ENTRY], "truncated": len(body)}
        line = json.dumps({"t": time.time(), **entry}, ensure_ascii=False) + "\n"
        with self.lock:
            try:
                d.mkdir(parents=True, exist_ok=True, mode=0o700)
                size = path.stat().st_size if path.exists() else 0
                if size >= MAX_LOG_FILE:
                    return
                if size + len(line) > MAX_LOG_FILE:
                    line = json.dumps({"t": time.time(), "note": LOG_FULL}) + "\n"
                fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_APPEND, 0o600)
                with os.fdopen(fd, "a", encoding="utf-8") as f:
                    f.write(line)
            except OSError:
                pass   # a log that can not be written never stops the traffic


# ---- the addon ----------------------------------------------------------------------------------------------------

def address_host(address: Any) -> str | None:
    """The host of a connection's address (`(host, port)`), or None when it has none."""
    return str(address[0]) if isinstance(address, tuple) and address and address[0] else None


def scope_of_auth(value: str | None) -> str | None:
    if not value or not value.lower().startswith("basic "):
        return None
    try:
        user, _, password = base64.b64decode(value.split(" ", 1)[1]).decode().partition(":")
    except (ValueError, UnicodeDecodeError):
        return None
    return password if user == PROXY_USER and password else None


class ModelGate:
    def __init__(self, table: Table | None = None, read_stdin: bool = True) -> None:
        self.table = table or Table()
        self.logs = Logs()
        self.ws: dict[str, Swapper] = {}
        # What each scope's patterns matched (ref -> value): kept while the gateway runs, so a placeholder the model
        # repeats a turn later is still put back.
        self.learned: dict[str, dict[str, str]] = {}
        if read_stdin:
            threading.Thread(target=self._stdin, daemon=True).start()

    def _stdin(self) -> None:
        for line in sys.stdin:
            line = line.strip()
            if not line:
                continue
            try:
                self.table = Table.parse(line)
            except (ValueError, KeyError, TypeError) as exc:
                print(f"model gate: table not taken: {type(exc).__name__}", file=sys.stderr)
        os._exit(0)   # the service that started it is gone: so is the gateway

    # which scope a connection is
    def _scope(self, conn: Any) -> tuple[str | None, Scope | None]:
        name = getattr(conn, "agentswitch_scope", None)
        return name, (self.table.scopes.get(name) if name else None)

    def http_connect(self, flow: Any) -> None:
        name = scope_of_auth(flow.request.headers.get("proxy-authorization"))
        flow.client_conn.agentswitch_scope = name
        flow.request.headers.pop("proxy-authorization", None)

    def requestheaders(self, flow: Any) -> None:
        # Plain-http proxy requests carry the credentials on every request.
        if flow.request.method != "CONNECT" and getattr(flow.client_conn, "agentswitch_scope", None) is None:
            flow.client_conn.agentswitch_scope = scope_of_auth(flow.request.headers.get("proxy-authorization"))
        flow.request.headers.pop("proxy-authorization", None)

    def server_connect(self, data: Any) -> None:
        _, scope = self._scope(data.client)
        if scope and scope.upstream:
            u = urlsplit(scope.upstream)
            if u.hostname and u.port:
                data.server.via = ("http", (u.hostname, u.port))

    def http_connect_upstream(self, flow: Any) -> None:
        _, scope = self._scope(flow.client_conn)
        if scope and scope.upstream:
            u = urlsplit(scope.upstream)
            if u.username is not None:
                from urllib.parse import unquote
                tok = base64.b64encode(f"{unquote(u.username)}:{unquote(u.password or '')}".encode()).decode()
                flow.request.headers["proxy-authorization"] = f"Basic {tok}"

    def tls_clienthello(self, data: Any) -> None:
        _, scope = self._scope(data.context.client)
        # No server name is sent for an address written as an IP (`https://1.2.3.4/…`, a relay's): then the address
        # the connection goes to (its CONNECT) is what is looked up — a profile's own address is in its hosts as it
        # was written (AgentSwitch room #33-#35). Until 2026-11-27 such a connection was passed through unread.
        if not (scope and scope.opens(data.client_hello.sni or address_host(data.context.server.address))):
            data.ignore_connection = True   # not the model's: passed through, never decrypted

    def tls_failed_server(self, data: Any) -> None:
        # A connection opened for its words whose server is not believed (an address as an IP whose certificate does
        # not name it, say): it ends here, refused, and is never passed on unread instead. Said once a connection.
        _, scope = self._scope(data.context.client)
        if scope:
            where = data.context.server.sni or address_host(data.context.server.address) or "?"
            print(f"model gate: TLS with {where} failed, the connection is refused: {data.conn.error}", file=sys.stderr, flush=True)

    def request(self, flow: Any) -> None:
        name, scope = self._scope(flow.client_conn)
        if not scope or not scope.opens(flow.request.pretty_host):
            return
        flow.request.headers["accept-encoding"] = "identity"
        text = flow.request.get_text(strict=False) or ""
        url = f"{flow.request.method} {flow.request.pretty_url}"
        if scope.log:
            self.logs.write(self.table, name, "before", {"dir": "out", "url": url, "body": text})
        hidden = hide(text, scope.pairs, scope.patterns, self.learned.setdefault(name or "", {})) if scope.pairs or scope.patterns else text
        if hidden != text:
            flow.request.set_text(hidden)
        if scope.log:
            self.logs.write(self.table, name, "after", {"dir": "out", "url": url, "body": hidden})

    def responseheaders(self, flow: Any) -> None:
        name, scope = self._scope(flow.client_conn)
        if not scope or not scope.opens(flow.request.pretty_host):
            return
        if "text/event-stream" not in flow.response.headers.get("content-type", ""):
            return
        sse = SSE(Swapper(scope.pairs, self.learned.get(name or "")))
        url = f"{flow.request.method} {flow.request.pretty_url}"

        said = False

        def rewrite(chunk: bytes) -> bytes:
            # An event this could not read goes on as it came (what comes back holds placeholders at worst, never
            # a word the model was kept from), and the reason is said once: an agent whose stream is cut says only
            # "check any proxy or gateway" (user #448).
            nonlocal said
            out = sse.feed(chunk)
            if sse.failed and not said:
                said = True
                print(f"model gate: an event of {flow.request.pretty_host} was passed on unread: {sse.failed}", file=sys.stderr, flush=True)
            if scope.log:
                if chunk:
                    self.logs.write(self.table, name, "after", {"dir": "in", "url": url, "body": chunk.decode("utf-8", "replace")})
                if out:
                    self.logs.write(self.table, name, "before", {"dir": "in", "url": url, "body": out.decode("utf-8", "replace")})
            return out

        # What is put back is not the length that was announced: a stream sent with `content-length` (a relay's; the
        # vendors' own are chunked) was cut short by the difference, and the agent read a broken last event
        # (2026-11-27, seen with Antigravity on a relay). The length is not said; an HTTP/1 answer is chunked instead.
        if "content-length" in flow.response.headers:
            del flow.response.headers["content-length"]
            if flow.response.http_version.upper().startswith("HTTP/1"):
                flow.response.headers["transfer-encoding"] = "chunked"
        flow.response.stream = rewrite

    def response(self, flow: Any) -> None:
        name, scope = self._scope(flow.client_conn)
        if not scope or not scope.opens(flow.request.pretty_host) or flow.response.stream:
            return
        text = flow.response.get_text(strict=False) or ""
        url = f"{flow.request.method} {flow.request.pretty_url}"
        if scope.log:
            self.logs.write(self.table, name, "after", {"dir": "in", "url": url, "status": flow.response.status_code, "body": text})
        sw = Swapper(scope.pairs, self.learned.get(name or ""))
        if sw.back and any(r in text for r in sw.back):
            try:
                back = json.dumps(sw.walk(json.loads(text)), ensure_ascii=False)
            except ValueError:
                back = sw.whole(text)
            flow.response.set_text(back)
            text = back
        if scope.log:
            self.logs.write(self.table, name, "before", {"dir": "in", "url": url, "status": flow.response.status_code, "body": text})

    def websocket_message(self, flow: Any) -> None:
        name, scope = self._scope(flow.client_conn)
        if not scope or not scope.opens(flow.request.pretty_host):
            return
        m = flow.websocket.messages[-1]
        if not m.is_text:
            return
        url = f"WS {flow.request.pretty_url}"
        if m.from_client:
            if scope.log:
                self.logs.write(self.table, name, "before", {"dir": "out", "url": url, "body": m.text})
            if scope.pairs or scope.patterns:
                m.text = hide(m.text, scope.pairs, scope.patterns, self.learned.setdefault(name or "", {}))
            if scope.log:
                self.logs.write(self.table, name, "after", {"dir": "out", "url": url, "body": m.text})
            return
        if scope.log:
            self.logs.write(self.table, name, "after", {"dir": "in", "url": url, "body": m.text})
        sw = self.ws.setdefault(flow.id, Swapper(scope.pairs, self.learned.get(name or "")))
        sw.back.update(self.learned.get(name or "") or {})   # what this socket sent since it opened
        if sw.back:
            try:
                o = json.loads(m.text)
            except ValueError:
                m.text = sw.whole(m.text)
            else:
                outs = sw.event(o)
                from mitmproxy import ctx
                for e in outs[:-1]:   # what was held back, before this message
                    ctx.master.commands.call("inject.websocket", flow, True, json.dumps(e, ensure_ascii=False).encode(), True)
                m.text = json.dumps(outs[-1], ensure_ascii=False)
        if scope.log:
            self.logs.write(self.table, name, "before", {"dir": "in", "url": url, "body": m.text})

    def websocket_end(self, flow: Any) -> None:
        self.ws.pop(flow.id, None)
