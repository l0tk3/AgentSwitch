"""The narrow verb set the gate exposes. Every result passes through `redact` before returning."""

from __future__ import annotations

import subprocess
from dataclasses import dataclass
from urllib.parse import urlsplit

import httpx

from .constants import EXEC_TIMEOUT_SECONDS, HTTP_TIMEOUT_SECONDS, USE_EXEC, USE_HTTP, USE_OTP
from .errors import ValidationError
from .exec_templates import ExecTemplate, get_template
from .redact import redact
from .resolver import Resolution, Resolver

_ALLOWED_METHODS = frozenset({"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"})


@dataclass(frozen=True)
class HttpResult:
    status: int
    headers: dict[str, str]
    body: str


@dataclass(frozen=True)
class ExecResult:
    returncode: int
    stdout: str
    stderr: str


def op_otp(resolver: Resolver, token: str) -> str:
    """Return the current 6-digit code. Codes expire in 30s, so exposing them is acceptable."""
    return resolver.resolve(token, use=USE_OTP).value


def op_describe(resolver: Resolver, token: str) -> dict:
    return resolver.describe(token)


def op_http(
    resolver: Resolver,
    *,
    method: str,
    url: str,
    headers: dict[str, str] | None = None,
    body: str | None = None,
    client: httpx.Client | None = None,
) -> HttpResult:
    method_up = method.upper()
    if method_up not in _ALLOWED_METHODS:
        raise ValidationError(f"unsupported method {method!r}")
    parts = urlsplit(url)
    if not parts.hostname:
        raise ValidationError("url must include a host")
    port = parts.port or (443 if parts.scheme == "https" else 80)
    host = f"{parts.hostname}:{port}"  # port-aware policy

    collected: list[Resolution] = []
    new_url, res = resolver.substitute(url, use=USE_HTTP, host=host)
    collected.extend(res)
    new_headers: dict[str, str] = {}
    for k, v in (headers or {}).items():
        nv, res = resolver.substitute(str(v), use=USE_HTTP, host=host)
        new_headers[k] = nv
        collected.extend(res)
    new_body: str | None = None
    if body is not None:
        new_body, res = resolver.substitute(body, use=USE_HTTP, host=host)
        collected.extend(res)

    own_client = client is None
    http_client = client or httpx.Client(timeout=HTTP_TIMEOUT_SECONDS, follow_redirects=False)
    try:
        resp = http_client.request(method_up, new_url, headers=new_headers, content=new_body)
    finally:
        if own_client:
            http_client.close()

    return HttpResult(
        status=resp.status_code,
        headers={k: redact(v, collected) or "" for k, v in resp.headers.items()},
        body=redact(resp.text, collected) or "",
    )


def op_exec(
    resolver: Resolver,
    templates: dict[str, ExecTemplate],
    *,
    template: str,
    token: str,
    args: tuple[str, ...] | list[str] = (),
    runner=subprocess.run,
) -> ExecResult:
    tpl = get_template(templates, template)
    resolution = resolver.resolve(token, use=USE_EXEC)
    argv = tpl.render(resolution.value, tuple(args))
    proc = runner(
        argv,
        capture_output=True,
        text=True,
        timeout=EXEC_TIMEOUT_SECONDS,
        check=False,
    )
    return ExecResult(
        returncode=proc.returncode,
        stdout=redact(proc.stdout, (resolution,)) or "",
        stderr=redact(proc.stderr, (resolution,)) or "",
    )
