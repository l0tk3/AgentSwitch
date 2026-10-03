"""`secret-gate fill-value`: a person's Fill Ciphertext in AgentSwitch's shared browser (docs/browser-v0.md §1).

Trusted caller only (the AgentSwitch daemon, for the screen of a person who picked a ciphertext). The request names the
ciphertext and the URL of the focused field's frame and of every frame above it, innermost first; the answer is the
value to type and the ciphertext's label. The gate answers only for use `fill` and only when every one of those pages'
`host:port` is allowed by the ciphertext, by the same rules as the agents' browser fill (`page_host`, the resolver's
policy check); a reference (`enc:ref:`) belongs to one task's run and is refused. JSON on stdin and stdout: the value
is on stdout and nowhere else, never in argv, the audit or an error.

Without the gate service this process opens the ciphertext with the login user's keys (as the local browser gate
does) and records the fill in `logs/browser-audit.jsonl`; with the service it calls `browser.resolve` on gate.sock for
each host, which checks `fill` exactly and records every call.
"""

from __future__ import annotations

import argparse
import json
import sys
from collections.abc import Callable
from pathlib import Path
from typing import Any

from .audit import Audit
from .browser_policy import page_host
from .constants import USE_FILL
from .errors import GateError, ValidationError
from .keystore import gate_home
from .resolver import Resolution, Resolver
from .rpc_client import RpcClient
from .tokens import is_ref, is_token

MAX_REQUEST_CHARS = 1 << 17
MAX_FRAMES = 16
MAX_URL_CHARS = 8192


def read_fill_request() -> tuple[str, list[str]]:
    raw = sys.stdin.read(MAX_REQUEST_CHARS + 1)
    if len(raw) > MAX_REQUEST_CHARS:
        raise ValidationError("fill request too large")
    try:
        data = json.loads(raw)
    except ValueError:
        raise ValidationError("fill request must be a JSON object") from None
    if not isinstance(data, dict) or set(data) != {"token", "urls"}:
        raise ValidationError("fill request needs exactly ['token', 'urls']")
    token, urls = data["token"], data["urls"]
    if isinstance(token, str) and is_ref(token):
        raise ValidationError("a reference (enc:ref:) belongs to one task; pick a ciphertext (enc:v1:)")
    if not isinstance(token, str) or not is_token(token):
        raise ValidationError("not a complete enc:v1: ciphertext")
    if (not isinstance(urls, list) or not 1 <= len(urls) <= MAX_FRAMES
            or not all(isinstance(u, str) and 0 < len(u) <= MAX_URL_CHARS for u in urls)):
        raise ValidationError(f"urls must be 1–{MAX_FRAMES} page URLs, the focused field's frame first")
    return token.strip(), urls


def hosts_of(urls: list[str]) -> list[str]:
    """host:port of every frame, innermost first, each once; a non-http(s) frame refuses the fill."""
    return list(dict.fromkeys(page_host(u) for u in urls))


def fill_value(resolve: Callable[[str, str], Resolution], token: str, urls: list[str]) -> tuple[Resolution, list[str]]:
    """The resolution for the field's own frame, once every frame up to the top has been allowed."""
    hosts = hosts_of(urls)
    resolutions = [resolve(token, host) for host in hosts]
    return resolutions[0], hosts


def _print(resolution: Resolution) -> int:
    print(json.dumps({"value": resolution.value, "label": resolution.label}))
    return 0


def _cmd_fill_value(_: argparse.Namespace) -> int:
    token, urls = read_fill_request()
    home = gate_home()
    audit = Audit.at_home(home, None)
    try:
        resolver = Resolver.from_home(home)
        resolution, hosts = fill_value(lambda t, h: resolver.resolve(t, use=USE_FILL, host=h), token, urls)
    except GateError as exc:
        audit.record("refused", tool="fill-value", reason=str(exc))
        raise
    audit.record("fill", host=hosts[-1], frames=hosts, labels=[resolution.label], by="person", ok=True)
    return _print(resolution)


def fill_value_remote(_: argparse.Namespace, *, client: RpcClient, public: Path) -> int:
    """The same through the gate service: `browser.resolve` for each frame's host (fill only, exact)."""
    token, urls = read_fill_request()

    def resolve(t: str, host: str) -> Resolution:
        result: Any = client.call("browser.resolve", {"token": t, "host": host})
        if not isinstance(result, dict) or not isinstance(result.get("value"), str) or not isinstance(result.get("label"), str):
            raise ValidationError("凭据网关服务返回了无效的响应")
        return Resolution(token=t, label=result["label"], value=result["value"])

    return _print(fill_value(resolve, token, urls)[0])


def add_fill_parser(sub: argparse._SubParsersAction) -> None:
    f = sub.add_parser("fill-value", help="AgentSwitch: the value of one ciphertext to type into a page a person focused "
                                          "(JSON {token, urls} on stdin; fill use, every frame's host checked)")
    f.set_defaults(fn=_cmd_fill_value)
