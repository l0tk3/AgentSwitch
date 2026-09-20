"""mitmproxy addon: substitute tokens on the way out, redact plaintext on the way back.

Pure with respect to mitmproxy globals so it can be unit-tested with `tflow`.
"""

from __future__ import annotations

from mitmproxy import http

from .constants import MAX_BODY_BYTES, POLICY_DENIED_STATUS, USE_HTTP
from .errors import GateError
from .redact import redact
from .resolver import Resolution, Resolver
from .tokens import find_tokens

_META_KEY = "secret_gate_resolutions"


def _deny(flow: http.HTTPFlow, reason: str) -> None:
    flow.response = http.Response.make(
        POLICY_DENIED_STATUS,
        f"secret-gate refused this request: {reason}\n".encode(),
        {"Content-Type": "text/plain", "X-Secret-Gate": "denied"},
    )


class SecretGateAddon:
    def __init__(self, resolver: Resolver) -> None:
        self._resolver = resolver

    # -- outbound -----------------------------------------------------------

    def request(self, flow: http.HTTPFlow) -> None:
        host = f"{flow.request.pretty_host}:{flow.request.port}"  # port-aware policy
        try:
            resolutions = self._rewrite_request(flow, host)
        except GateError as exc:
            _deny(flow, str(exc))
            return
        flow.metadata[_META_KEY] = resolutions

    def _rewrite_request(self, flow: http.HTTPFlow, host: str) -> tuple[Resolution, ...]:
        collected: list[Resolution] = []

        new_url, res = self._resolver.substitute(flow.request.url, use=USE_HTTP, host=host)
        if res:
            flow.request.url = new_url
            collected.extend(res)

        for name, value in list(flow.request.headers.items(multi=True)):
            if not find_tokens(value):
                continue
            new_value, res = self._resolver.substitute(value, use=USE_HTTP, host=host)
            flow.request.headers[name] = new_value
            collected.extend(res)

        body = self._text_body(flow.request)
        if body is not None and find_tokens(body):
            new_body, res = self._resolver.substitute(body, use=USE_HTTP, host=host)
            flow.request.text = new_body
            collected.extend(res)

        return tuple(collected)

    # -- inbound ------------------------------------------------------------

    def response(self, flow: http.HTTPFlow) -> None:
        resolutions = flow.metadata.get(_META_KEY, ())
        if not resolutions or flow.response is None:
            return
        for name, value in list(flow.response.headers.items(multi=True)):
            cleaned = redact(value, resolutions)
            if cleaned != value:
                flow.response.headers[name] = cleaned
        body = self._text_body(flow.response)
        if body is None:
            return
        cleaned_body = redact(body, resolutions)
        if cleaned_body != body:
            flow.response.text = cleaned_body

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
