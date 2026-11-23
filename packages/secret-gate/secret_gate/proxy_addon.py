"""mitmproxy addon: substitute tokens on the way out, redact plaintext on the way back.

Pure with respect to mitmproxy globals so it can be unit-tested with `tflow`.

Execution scope (gate-next-v0 §1): the dispatcher gives each execution's shell tools a proxy URL
`http://scope:<scope>@127.0.0.1:8080`, so clients send `Proxy-Authorization: Basic` on CONNECT (and
on every plain-http request). The scope is remembered per client connection, lets `enc:ref:`
references of that execution resolve, and is never forwarded upstream. A request carrying a
reference without a scope is refused like any other policy violation.

Responses (gate-simple-v0 §3): every value a request used is remembered for its execution scope and destination
`host:port`, and every later response from that host in that scope is redacted with them (`redact.Redactor`: whole
forms, any case, 4-character fragments, base64), status line, headers, body, trailers and WebSocket messages from the
server. What cannot be redacted is withheld, never passed through: a body over MAX_BODY_BYTES (compressed or not), a
content-encoding mitmproxy cannot decode (unknown or stacked), a body whose bytes still hold a value after the text was
redacted (a charset that hid it), a redactor error; a WebSocket message that cannot be redacted is dropped.
"""

from __future__ import annotations

import base64
import binascii
from collections import OrderedDict

from mitmproxy import connection, http

from .constants import (
    MAX_BODY_BYTES,
    POLICY_DENIED_STATUS,
    SCOPE_PATTERN,
    SCOPE_PROXY_USER,
    USE_HTTP,
)
from .errors import GateError, PolicyViolation
from .redact import Redactor
from .resolver import Resolution, Resolver
from .tokens import find_secrets

_META_KEY = "secret_gate_resolutions"
_PROXY_AUTH = "Proxy-Authorization"
# Values used per (scope, host:port), so a later response of the same session (a profile page echoing the password
# sent at login) is redacted too. Bounded: the oldest sessions are forgotten first.
MAX_SESSIONS = 512
MAX_VALUES_PER_SESSION = 64
TOO_LARGE = f"its body is larger than {MAX_BODY_BYTES // (1024 * 1024)} MiB and cannot be redacted (内容过大，已扣下)"


class Withheld(Exception):
    """The response cannot be redacted; the reason is shown to the model (it holds no value)."""


def _deny(flow: http.HTTPFlow, reason: str) -> None:
    flow.response = http.Response.make(
        POLICY_DENIED_STATUS,
        f"secret-gate refused this request: {reason}\n".encode(),
        {"Content-Type": "text/plain", "X-Secret-Gate": "denied"},
    )


def scope_from_header(value: str | None) -> str | None:
    """`Basic base64("scope:<scope>")` -> scope; anything else -> None (never an error: it may not be ours)."""
    if not value:
        return None
    kind, _, encoded = value.strip().partition(" ")
    if kind.lower() != "basic":
        return None
    try:
        user, sep, secret = base64.b64decode(encoded.strip(), validate=True).decode("utf-8").partition(":")
    except (binascii.Error, UnicodeDecodeError, ValueError):
        return None
    if not sep or user != SCOPE_PROXY_USER or not SCOPE_PATTERN.fullmatch(secret):
        return None
    return secret


def find_secrets_in_request(flow: http.HTTPFlow) -> bool:
    body = SecretGateAddon._text_body(flow.request)
    return bool(find_secrets(flow.request.url) or any(find_secrets(v) for v in flow.request.headers.values())
                or (body is not None and find_secrets(body)))


def _check_host_header(flow: http.HTTPFlow) -> None:
    """A request carrying a value must name the host it really goes to: a different Host header is how a CDN
    is told to route elsewhere (domain fronting), so it is refused rather than trusted or ignored."""
    header = flow.request.host_header
    if header is None:
        return
    name = header.rsplit(":", 1)[0] if not header.startswith("[") else header.split("]")[0] + "]"
    if name.strip().lower().rstrip(".") != flow.request.host.strip().lower().rstrip("."):
        raise PolicyViolation(f"the Host header ({name!r}) differs from the destination {flow.request.host!r}; refused")


class SecretGateAddon:
    def __init__(self, resolver: Resolver) -> None:
        self._resolver = resolver
        self._scopes: dict[str, str] = {}  # client connection id -> scope announced on CONNECT
        self._sessions: OrderedDict[tuple[str, str], dict[str, Resolution]] = OrderedDict()

    @property
    def resolver(self) -> Resolver:
        return self._resolver

    def replace_resolver(self, resolver: Resolver) -> None:
        """SIGHUP key reload (reload.py): one assignment; a request reads the resolver once."""
        self._resolver = resolver

    # -- connection scope ----------------------------------------------------

    def http_connect(self, flow: http.HTTPFlow) -> None:
        scope = scope_from_header(flow.request.headers.get(_PROXY_AUTH))
        if scope is not None:
            self._scopes[flow.client_conn.id] = scope

    def client_disconnected(self, client: connection.Client) -> None:
        self._scopes.pop(client.id, None)

    # -- outbound -----------------------------------------------------------

    def request(self, flow: http.HTTPFlow) -> None:
        announced = scope_from_header(flow.request.headers.get(_PROXY_AUTH))
        flow.request.headers.pop(_PROXY_AUTH, None)  # addressed to this proxy, never to the site
        scope = announced or self._scopes.get(flow.client_conn.id)
        # The policy host is where the proxy really connects (CONNECT target / absolute URL), never the Host
        # header, which the client chooses freely (Host: allowed.example + connect to evil = plaintext to evil).
        host = f"{flow.request.host}:{flow.request.port}"
        try:
            rewrite = self._rewrite_request(flow, host, self._resolver.scoped(scope))
        except GateError as exc:
            _deny(flow, str(exc))
            return
        except Exception:  # noqa: BLE001 - fail closed: an unexpected error must never forward a half-rewritten request
            _deny(flow, "internal error while checking this request; nothing was sent")
            return
        url, headers, body, resolutions = rewrite
        if url is not None:
            flow.request.url = url
        for name, value in headers:
            flow.request.headers[name] = value
        if body is not None:
            flow.request.text = body
        flow.metadata[_META_KEY] = self._remember(scope or "", host, resolutions)

    def _remember(self, scope: str, host: str, resolutions: tuple[Resolution, ...]) -> tuple[Resolution, ...]:
        """This request's values plus every value used earlier in the same scope on the same host."""
        key = (scope, host.lower())
        session = self._sessions.get(key)
        if session is None and not resolutions:
            return ()
        if session is None:
            session = self._sessions[key] = {}
            while len(self._sessions) > MAX_SESSIONS:
                self._sessions.popitem(last=False)
        self._sessions.move_to_end(key)
        for r in resolutions:
            session.pop(r.value, None)
            session[r.value] = r
        while len(session) > MAX_VALUES_PER_SESSION:
            session.pop(next(iter(session)))
        return tuple(dict.fromkeys((*resolutions, *session.values())))

    @staticmethod
    def _rewrite_request(
        flow: http.HTTPFlow, host: str, resolver: Resolver
    ) -> tuple[str | None, list[tuple[str, str]], str | None, tuple[Resolution, ...]]:
        """Everything computed before anything is written back, so a failure leaves the flow untouched."""
        collected: list[Resolution] = []
        if find_secrets_in_request(flow):
            _check_host_header(flow)

        new_url, res = resolver.substitute(flow.request.url, use=USE_HTTP, host=host)
        collected.extend(res)

        headers: list[tuple[str, str]] = []
        for name, value in list(flow.request.headers.items(multi=True)):
            if not find_secrets(value):
                continue
            new_value, res = resolver.substitute(value, use=USE_HTTP, host=host)
            headers.append((name, new_value))
            collected.extend(res)

        body = SecretGateAddon._text_body(flow.request)
        new_body = None
        if body is not None and find_secrets(body):
            new_body, res = resolver.substitute(body, use=USE_HTTP, host=host)
            collected.extend(res)

        return (new_url if new_url != flow.request.url else None), headers, new_body, tuple(collected)

    # -- inbound ------------------------------------------------------------

    def responseheaders(self, flow: http.HTTPFlow) -> None:
        """A response that may hold a value is read whole, never streamed past the redactor."""
        if flow.metadata.get(_META_KEY) and flow.response is not None and flow.response.stream:
            flow.response.stream = False

    def response(self, flow: http.HTTPFlow) -> None:
        resolutions = flow.metadata.get(_META_KEY, ())
        if not resolutions or flow.response is None:
            return
        try:
            self._redact_response(flow.response, Redactor(resolutions))
        except Withheld as exc:
            flow.response = _withheld_response(flow.response.status_code, str(exc))
        except Exception:  # noqa: BLE001 - fail closed: never hand back a response that may still hold a value
            flow.response = _withheld_response(502, "it could not be redacted")

    def websocket_message(self, flow: http.HTTPFlow) -> None:
        """A message from the server of a connection whose handshake used a value is redacted, or dropped."""
        resolutions = flow.metadata.get(_META_KEY, ())
        if not resolutions or flow.websocket is None or not flow.websocket.messages:
            return
        message = flow.websocket.messages[-1]
        if message.from_client:
            return
        try:
            if len(message.content) > MAX_BODY_BYTES:
                raise Withheld(TOO_LARGE)
            redactor = Redactor(resolutions)
            view = message.content.decode("utf-8", "surrogateescape")
            cleaned = redactor(view)
            if cleaned != view:
                message.content = cleaned.encode("utf-8", "surrogateescape")
        except Exception:  # noqa: BLE001 - fail closed: the message is not forwarded
            message.drop()

    @staticmethod
    def _redact_response(response: http.Response, redactor: Redactor) -> None:
        response.reason = redactor(response.reason) or ""
        _redact_headers(response.headers, redactor)
        if response.trailers is not None:
            _redact_headers(response.trailers, redactor)
        raw = response.raw_content
        if raw is None:
            raise Withheld("its body was streamed and could not be redacted")
        if len(raw) > MAX_BODY_BYTES:
            raise Withheld(TOO_LARGE)
        try:
            content = response.get_content(strict=True)
        except ValueError:
            raise Withheld("its content-encoding could not be decoded, so it could not be redacted") from None
        if not content:
            return
        if len(content) > MAX_BODY_BYTES:
            raise Withheld(TOO_LARGE)
        # Two readings of the body, both redacted: its bytes as UTF-8 (what most clients show, whatever the headers
        # say) and its text in the charset it declares or mitmproxy infers. Each must come out clean.
        view = content.decode("utf-8", "surrogateescape")
        cleaned = redactor(view)
        if cleaned != view:
            response.content = cleaned.encode("utf-8", "surrogateescape")
        try:
            text = response.get_text(strict=True)
        except ValueError:
            text = None
        if text is not None:
            cleaned = redactor(text)
            if cleaned != text:
                response.text = cleaned
            if redactor.finds(response.get_text(strict=True)):
                raise Withheld("its body could not be redacted in the charset it declares")
        if redactor.finds(response.get_content(strict=True).decode("utf-8", "surrogateescape")):
            raise Withheld("its body could not be redacted in the charset it declares")

    # -- helpers ------------------------------------------------------------

    @staticmethod
    def _text_body(message: http.Message) -> str | None:
        raw = message.raw_content
        if raw is None or len(raw) == 0 or len(raw) > MAX_BODY_BYTES:
            return None
        try:
            return message.get_text(strict=False)
        except ValueError:
            return None


def _redact_headers(headers: http.Headers, redactor: Redactor) -> None:
    """Every value redacted; a header whose name holds a value is dropped."""
    fields = []
    for name, value in headers.fields:
        name_text = name.decode("utf-8", "surrogateescape")
        if redactor.finds(name_text):
            continue
        value_text = value.decode("utf-8", "surrogateescape")
        cleaned = redactor(value_text)
        fields.append((name, value if cleaned == value_text else cleaned.encode("utf-8", "surrogateescape")))
    headers.fields = tuple(fields)


def _withheld_response(status: int, reason: str) -> http.Response:
    return http.Response.make(
        status, f"secret-gate withheld this response: {reason}\n".encode(),
        {"Content-Type": "text/plain; charset=utf-8", "X-Secret-Gate": "withheld"},
    )
