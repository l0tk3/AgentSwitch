"""mitmproxy addon: substitute tokens on the way out, redact plaintext on the way back.

Pure with respect to mitmproxy globals so it can be unit-tested with `tflow`.

Execution scope (gate-next-v0 §1): the dispatcher gives each execution's shell tools a proxy URL
`http://scope:<scope>@127.0.0.1:8080`, so clients send `Proxy-Authorization: Basic` on CONNECT (and
on every plain-http request). The scope is remembered per client connection, lets `enc:ref:`
references of that execution resolve, and is never forwarded upstream. A request carrying a
reference without a scope is refused like any other policy violation.
"""

from __future__ import annotations

import base64
import binascii

from mitmproxy import connection, http

from .constants import MAX_BODY_BYTES, POLICY_DENIED_STATUS, SCOPE_PATTERN, SCOPE_PROXY_USER, USE_HTTP
from .errors import GateError, PolicyViolation
from .redact import redact
from .resolver import Resolution, Resolver
from .tokens import find_secrets

_META_KEY = "secret_gate_resolutions"
_PROXY_AUTH = "Proxy-Authorization"


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
        flow.metadata[_META_KEY] = resolutions

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

    def response(self, flow: http.HTTPFlow) -> None:
        resolutions = flow.metadata.get(_META_KEY, ())
        if not resolutions or flow.response is None:
            return
        try:
            self._redact_response(flow.response, resolutions)
        except Exception:  # noqa: BLE001 - fail closed: never hand back a response that may still hold a value
            flow.response = http.Response.make(
                502, b"secret-gate could not redact this response; it was withheld\n",
                {"Content-Type": "text/plain", "X-Secret-Gate": "withheld"},
            )

    @staticmethod
    def _redact_response(response: http.Response, resolutions: tuple[Resolution, ...]) -> None:
        for name, value in list(response.headers.items(multi=True)):
            cleaned = redact(value, resolutions)
            if cleaned != value:
                response.headers[name] = cleaned
        body = SecretGateAddon._text_body(response)
        if body is None:
            return
        cleaned_body = redact(body, resolutions)
        if cleaned_body != body:
            response.text = cleaned_body

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
