"""The methods of the gate service's `gate.sock` (gate-service-v0 §3.2).

The daemon and an agent run as the same uid, so every method is written for a caller that may be an agent: no
method returns a private key, and only two return a value: `browser.resolve` (fill-only, host-checked) and
`exec.resolve` (exec-only), the two exits gate-simple-v0 §2 names. The methods are exactly METHODS. Each method checks its parameters exactly; the gate's own checks (policy, scope, references) are the
same code the local CLI and MCP servers use, with the same error text.
"""

from __future__ import annotations

import json
import threading
from collections import OrderedDict
from collections.abc import Callable, Iterable
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx

from . import __version__
from .browser_mask import MASK_CONFIG_FILE, MaskConfig
from .constants import USE_EXEC, USE_FILL
from .errors import GateError, ValidationError
from .gate_ops import op_describe, op_http, op_otp
from .policy import normalize_host, split_host_port
from .proxy_pid import proxy_running
from .publish import key_rows, publish_ca, publish_keys
from .redact import Redactor, withheld
from .refs import RefRegistry, check_scope
from .refs_cli import register_tokens
from .resolver import Resolution, Resolver
from .service_paths import MITMPROXY_DIR, ServiceConfig
from .tokens import find_secrets

MAX_TOKEN_CHARS = 131072
MAX_TEXT_CHARS = 900_000
MAX_LOG_LINES = 500
MAX_LOG_BYTES = 256 * 1024
LOG_NAMES = ("proxy", "rpc")
MAX_USED_VALUES = 256  # values this service used or handed out lately, redacted out of logs.tail
# Every method gate.sock answers (gate-simple-v0 §2); nothing else.
METHODS = ("status", "refs.register", "refs.release", "mcp.describe", "mcp.otp", "mcp.http", "exec.resolve",
           "browser.register", "browser.config", "browser.resolve", "logs.tail")


@dataclass(frozen=True)
class Reply:
    """A method's result plus what the audit line records about it (labels and host, never values)."""

    value: Any
    labels: tuple[str, ...] = ()
    host: str | None = None


def fields(params: dict[str, Any], required: set[str], optional: set[str] = frozenset()) -> dict[str, Any]:
    if set(params) - required - optional or required - set(params):
        extra = f"，可选 {sorted(optional)}" if optional else ""
        raise ValidationError(f"参数无效：需要 {sorted(required)}{extra}")
    return params


def text(params: dict[str, Any], name: str, limit: int = MAX_TOKEN_CHARS) -> str:
    value = params.get(name)
    if not isinstance(value, str) or not value or len(value) > limit:
        raise ValidationError(f"参数无效：{name} 应为非空字符串")
    return value


def scope_of(params: dict[str, Any]) -> str | None:
    scope = params.get("scope")
    return None if scope is None else check_scope(scope)


def page_host(value: Any) -> str:
    """`host:port` of the page the browser fills on, as the browser gate computes it."""
    if not isinstance(value, str) or len(value) > 300:
        raise ValidationError("参数无效：host 应为 host:port")
    try:
        host = normalize_host(value)
    except GateError:
        raise ValidationError("参数无效：host 应为 host:port") from None
    if "*" in host or split_host_port(host)[1] is None:
        raise ValidationError("参数无效：host 应为具体的 host:port")
    return host


class GateService:
    def __init__(
        self,
        home: Path,
        public: Path,
        config: Callable[[], ServiceConfig | None],
        *,
        proxy_running_fn: Callable[[], bool] | None = None,
        http_client: Callable[[], httpx.Client | None] = lambda: None,
    ) -> None:
        self._home = Path(home)
        self._public = Path(public)
        self._config = config
        self._proxy_running = proxy_running_fn or (lambda: proxy_running(self._home))
        self._http_client = http_client
        self._used: OrderedDict[str, Resolution] = OrderedDict()
        self._used_lock = threading.Lock()
        self._methods: dict[str, Callable[[dict[str, Any]], Reply]] = {
            "status": self._status,
            "refs.register": self._refs_register, "refs.release": self._refs_release,
            "mcp.describe": self._mcp_describe, "mcp.otp": self._mcp_otp, "mcp.http": self._mcp_http,
            "exec.resolve": self._exec_resolve,
            "browser.register": self._browser_register, "browser.config": self._browser_config,
            "browser.resolve": self._browser_resolve, "logs.tail": self._logs_tail,
        }
        assert tuple(self._methods) == METHODS

    @property
    def methods(self) -> tuple[str, ...]:
        return tuple(self._methods)

    def call(self, method: str, params: dict[str, Any]) -> Reply:
        handler = self._methods.get(method)
        if handler is None:
            raise ValidationError(f"未知方法：{method}")
        return handler(params)

    def publish(self) -> None:
        """keys.json and ca.pem, at start (a key rotation republishes them itself, system_exec.py)."""
        publish_keys(self._home, self._public)
        publish_ca(self._home / MITMPROXY_DIR, self._public)

    def _resolver(self, scope: str | None) -> Resolver:
        return Resolver.from_home(self._home, scope=scope)

    def _note_used(self, resolutions: Iterable[Resolution]) -> None:
        with self._used_lock:
            for r in resolutions:
                self._used.pop(r.value, None)
                self._used[r.value] = r
            while len(self._used) > MAX_USED_VALUES:
                self._used.popitem(last=False)

    # -- status and keys ------------------------------------------------------------------------

    def _status(self, params: dict[str, Any]) -> Reply:
        fields(params, set())
        config = self._config()
        publish_ca(self._home / MITMPROXY_DIR, self._public)  # the proxy may have created its CA since start-up
        return Reply({"version": __version__, "proxyPort": config.proxy_port if config else None,
                      "runtimeVersion": config.runtime_version if config else None,
                      "keys": [r.to_json() for r in key_rows(self._home)], "proxyRunning": self._proxy_running()})

    # -- dispatcher: references -------------------------------------------------------------------

    def _refs_register(self, params: dict[str, Any]) -> Reply:
        fields(params, {"scope", "tokens"})
        tokens = params["tokens"]
        if isinstance(tokens, list):  # [{token, label?}] as well as plain tokens; the label comes from the ciphertext
            tokens = [t.get("token") if isinstance(t, dict) and set(t) <= {"token", "label"} else t for t in tokens]
        result = register_tokens(self._resolver(check_scope(params["scope"])), tokens)
        return Reply(result, labels=tuple(item["label"] for item in result["refs"] if "label" in item))

    def _refs_release(self, params: dict[str, Any]) -> Reply:
        scope = check_scope(fields(params, {"scope"})["scope"])
        return Reply({"released": RefRegistry.from_home(self._home).release(scope)})

    # -- MCP tools (the `secret-gate mcp` forwarder) ---------------------------------------------

    def _label(self, resolver: Resolver, token: str) -> tuple[str, ...]:
        try:
            return (resolver.describe(token)["label"],)
        except GateError:
            return ()

    def _mcp_describe(self, params: dict[str, Any]) -> Reply:
        fields(params, {"token"}, {"scope"})
        info = op_describe(self._resolver(scope_of(params)), text(params, "token"))
        return Reply(info, labels=(info["label"],))

    def _mcp_otp(self, params: dict[str, Any]) -> Reply:
        fields(params, {"token"}, {"scope"})
        resolver, token = self._resolver(scope_of(params)), text(params, "token")
        return Reply(op_otp(resolver, token), labels=self._label(resolver, token))

    def _mcp_http(self, params: dict[str, Any]) -> Reply:
        fields(params, {"method", "url"}, {"scope", "headers", "body"})
        headers, body = params.get("headers"), params.get("body")
        if headers is not None and (not isinstance(headers, dict) or not all(isinstance(v, str) for v in headers.values())):
            raise ValidationError("参数无效：headers 应为字符串到字符串的对象")
        if body is not None and (not isinstance(body, str) or len(body) > MAX_TEXT_CHARS):
            raise ValidationError("参数无效：body 应为字符串")
        resolver, url = self._resolver(scope_of(params)), text(params, "url", MAX_TEXT_CHARS)
        secrets = find_secrets(" ".join([url, *(headers or {}).values(), body or ""]))
        try:
            result = op_http(resolver, method=text(params, "method", 16), url=url, headers=headers, body=body,
                             client=self._http_client())
        except httpx.HTTPError as exc:  # the message may quote the rewritten URL: name the failure only
            raise GateError(f"request failed ({type(exc).__name__})") from None
        self._note_used(result.used)
        labels = tuple(dict.fromkeys(label for s in secrets for label in self._label(resolver, s)))
        return Reply({"status": result.status, "headers": result.headers, "body": result.body},
                     labels=labels, host=urlsplit(url).hostname)

    def _exec_resolve(self, params: dict[str, Any]) -> Reply:
        """The value of an `exec` token for `secret_exec`, which runs the command as the login user (gate-simple-v0
        §2.1). Only a token sealed with use `exec` opens here; the audit line gets its label, never the value."""
        fields(params, {"token"}, {"scope"})
        resolution = self._resolver(scope_of(params)).resolve_exact(text(params, "token"), use=USE_EXEC)
        self._note_used((resolution,))
        return Reply({"value": resolution.value, "label": resolution.label}, labels=(resolution.label,))

    # -- browser component (runs as the login user) ----------------------------------------------

    def _browser_resolve(self, params: dict[str, Any]) -> Reply:
        fields(params, {"token", "host"}, {"scope"})
        host = page_host(params["host"])
        resolution = self._resolver(scope_of(params)).resolve_exact(text(params, "token"), use=USE_FILL, host=host)
        self._note_used((resolution,))
        return Reply({"value": resolution.value, "label": resolution.label}, labels=(resolution.label,), host=host)

    def _browser_register(self, params: dict[str, Any]) -> Reply:
        fields(params, {"scope", "token"})
        resolver = self._resolver(check_scope(params["scope"]))
        token = text(params, "token")
        return Reply({"ref": resolver.register(token)}, labels=self._label(resolver, token))

    def _browser_config(self, params: dict[str, Any]) -> Reply:
        fields(params, set())
        MaskConfig.load(self._home)  # an invalid file fails here, exactly as it fails a local browser gate
        path = self._home / MASK_CONFIG_FILE
        return Reply({"screenshotMask": json.loads(path.read_text()) if path.exists() else None})

    def _logs_tail(self, params: dict[str, Any]) -> Reply:
        fields(params, {"name"}, {"lines"})
        name, lines = params["name"], params.get("lines", 200)
        if name not in LOG_NAMES:
            raise ValidationError(f"参数无效：name 应为 {' 或 '.join(LOG_NAMES)}")
        if not isinstance(lines, int) or isinstance(lines, bool) or not 1 <= lines <= MAX_LOG_LINES:
            raise ValidationError(f"参数无效：lines 应为 1–{MAX_LOG_LINES}")
        with self._used_lock:
            used = tuple(self._used.values())
        return Reply({"text": redacted_log(tail(self._home / "logs" / f"{name}.log", lines), self._home, used)})


def redacted_log(text: str, home: Path, used: tuple[Resolution, ...] = ()) -> str:
    """A log as the gate shows it (gate-simple-v0 §3): the gate never writes a value to its logs, but a library's
    error line could quote a rewritten request. Every value this service used lately and every value behind a live
    reference is redacted out; a log that cannot be redacted is withheld."""
    if not text:
        return text
    try:
        resolver = Resolver.from_home(home)
        live = resolver.values_for_redaction(resolver.refs.live_tokens()) if resolver.refs is not None else ()
    except GateError:
        live = ()  # no key in this home: nothing could have been substituted with it
    except Exception:  # noqa: BLE001 - fail closed: the values to redact are unknown
        return withheld("log", "the values to redact it with could not be read")
    try:
        return Redactor((*used, *live))(text) or ""
    except Exception:  # noqa: BLE001 - fail closed
        return withheld("log", "it could not be redacted")


def tail(path: Path, lines: int) -> str:
    try:
        with open(path, "rb") as fh:
            fh.seek(0, 2)
            size = fh.tell()
            fh.seek(max(0, size - MAX_LOG_BYTES))
            data = fh.read()
    except FileNotFoundError:
        return ""
    except OSError as exc:
        raise GateError(f"无法读取 {path.name}：{exc.strerror or exc}") from None
    return "\n".join(data.decode("utf-8", "replace").splitlines()[-lines:])
