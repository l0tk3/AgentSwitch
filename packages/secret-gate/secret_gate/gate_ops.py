"""The narrow verb set the gate exposes. Every result passes through the redactor before returning.

What cannot be redacted is withheld (gate-simple-v0 §3.2), whole: a response body or command output over
MAX_BODY_BYTES (never cut at the limit, so no value is split by a cut the redactor did not see), a body in a
content-encoding httpx cannot decode, a body whose bytes still hold a value after its text was redacted, and anything
the redactor fails on."""

from __future__ import annotations

import subprocess
from dataclasses import dataclass, field
from urllib.parse import urlsplit

import httpx

from .constants import (
    EXEC_TIMEOUT_SECONDS,
    HTTP_TIMEOUT_SECONDS,
    MAX_BODY_BYTES,
    USE_EXEC,
    USE_HTTP,
    USE_OTP,
)
from .errors import ValidationError
from .exec_templates import ExecTemplate, get_template
from .redact import Redactor, withheld
from .resolver import Resolution, Resolver

_ALLOWED_METHODS = frozenset({"GET", "POST", "PUT", "PATCH", "DELETE", "HEAD", "OPTIONS"})
try:
    from httpx._decoders import SUPPORTED_DECODERS as _DECODERS

    _DECODABLE = frozenset(_DECODERS)
except ImportError:  # pragma: no cover - httpx moved it: accept only what every httpx decodes
    _DECODABLE = frozenset({"identity", "gzip", "deflate"})
TOO_LARGE = f"larger than {MAX_BODY_BYTES // (1024 * 1024)} MiB, too large to redact (内容过大，已扣下)"


@dataclass(frozen=True)
class HttpResult:
    status: int
    headers: dict[str, str]
    body: str
    used: tuple[Resolution, ...] = field(default=(), repr=False, compare=False)  # for logs.tail, never returned


@dataclass(frozen=True)
class ExecResult:
    returncode: int
    stdout: str
    stderr: str
    used: tuple[Resolution, ...] = field(default=(), repr=False, compare=False)


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
    for name, value in (headers or {}).items():
        # A Host header naming another site would let a CDN route the value there (domain fronting).
        if name.lower() == "host" and str(value).rsplit(":", 1)[0].strip().lower().rstrip(".") != parts.hostname.lower():
            raise ValidationError("the Host header must name the URL's own host")

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
    redactor = Redactor(collected)
    try:
        with http_client.stream(method_up, new_url, headers=new_headers, content=new_body) as resp:
            try:
                headers = {redactor(k) or "": redactor(v) or "" for k, v in resp.headers.items()}
                body = _read_body(resp, redactor)
            except Exception:  # noqa: BLE001 - fail closed: nothing of a response that could not be redacted
                headers, body = {}, withheld("response", "it could not be redacted")
    finally:
        if own_client:
            http_client.close()
    return HttpResult(status=resp.status_code, headers=headers, body=body, used=tuple(collected))


def _read_body(resp: httpx.Response, redactor: Redactor) -> str:
    """The whole body, redacted; or why it was withheld. Never a truncated part."""
    if redactor:
        codings = [c.strip().lower() for c in resp.headers.get("content-encoding", "").split(",") if c.strip()]
        if any(c not in _DECODABLE for c in codings):
            return withheld("body", "its content-encoding could not be decoded, so it could not be redacted")
    data = bytearray()
    for chunk in resp.iter_bytes():
        data += chunk
        if redactor and len(data) > MAX_BODY_BYTES:
            return withheld("body", TOO_LARGE)
    raw = bytes(data)
    charset = resp.charset_encoding or "utf-8"
    try:
        text = raw.decode(charset, errors="replace")
    except LookupError:
        charset, text = "utf-8", raw.decode("utf-8", errors="replace")
    cleaned = redactor(text) or ""
    # The text was read in the declared charset; the same text as UTF-8 bytes must not hold a value either.
    if (redactor and charset.lower().replace("_", "-") not in ("utf-8", "utf8")
            and redactor.finds(cleaned.encode(charset, errors="replace").decode("utf-8", errors="replace"))):
        return withheld("body", "it could not be redacted in the charset it declares")
    return cleaned


def op_exec(
    resolver: Resolver,
    templates: dict[str, ExecTemplate],
    *,
    template: str,
    token: str,
    args: tuple[str, ...] | list[str] = (),
    runner=subprocess.run,
) -> ExecResult:
    """Run a whitelisted template. The value reaches the child only through the template's `env` and/or `stdin`
    (never argv, which every user of the machine can read); the child's environment is minimal (exec_templates
    `child_env`); stdout and stderr are redacted before they return."""
    tpl = get_template(templates, template)
    resolution = resolver.resolve(token, use=USE_EXEC)
    rendered = tpl.render(resolution.value, tuple(args))
    stdin = {"input": rendered.stdin} if rendered.stdin is not None else {"stdin": subprocess.DEVNULL}
    proc = runner(
        list(rendered.argv),
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=EXEC_TIMEOUT_SECONDS,
        check=False,
        env=rendered.env,
        **stdin,
    )
    redactor = Redactor((resolution,))
    return ExecResult(
        returncode=proc.returncode,
        stdout=_redacted_output(proc.stdout, redactor),
        stderr=_redacted_output(proc.stderr, redactor),
        used=(resolution,),
    )


def _redacted_output(text: str | None, redactor: Redactor) -> str:
    """A command's whole output stream redacted, or withheld when it is too large or the redactor fails."""
    if not text:
        return ""
    if len(text) > MAX_BODY_BYTES:
        return withheld("output", TOO_LARGE)
    try:
        return redactor(text) or ""
    except Exception:  # noqa: BLE001 - fail closed
        return withheld("output", "it could not be redacted")
