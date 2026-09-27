"""The methods of the gate service's `gate.sock` (gate-service-v0 §3.2).

The daemon and an agent run as the same uid, so every method is written for a caller that may be an agent: no
method returns a private key, and only `browser.resolve` returns a value (fill-only, host-checked; the gap §1
documents). Each method checks its parameters exactly; the gate's own checks (policy, scope, references) are the
same code the local CLI and MCP servers use, with the same error text.
"""

from __future__ import annotations

import asyncio
import json
import subprocess
import threading
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path
from typing import Any
from urllib.parse import urlsplit

import httpx

from . import __version__
from .browser_mask import MASK_CONFIG_FILE, MaskConfig
from .constants import USE_FILL
from .credential_repair import CREDENTIAL_INFO, CREDENTIAL_REISSUE, REPAIR_PURPOSE, credential_call, repair_scoped
from .errors import GateError, ValidationError
from .exec_templates import load_templates
from .gate_ops import op_describe, op_exec, op_http, op_otp
from .keyring import create_keypair, retire_keypair, set_current
from .keystore import load_public_key
from .policy import normalize_host, split_host_port
from .proxy_pid import proxy_running, signal_proxy
from .publish import key_rows, publish_ca, publish_keys
from .refs import RefRegistry, check_scope
from .refs_cli import register_tokens
from .resolver import Resolver
from .service_paths import MITMPROXY_DIR, ServiceConfig
from .tokens import find_secrets

MAX_TOKEN_CHARS = 131072
MAX_TEXT_CHARS = 900_000
MAX_LOG_LINES = 500
MAX_LOG_BYTES = 256 * 1024
LOG_NAMES = ("proxy", "rpc")


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
        signal_proxy_fn: Callable[[], bool] | None = None,
        proxy_running_fn: Callable[[], bool] | None = None,
        http_client: Callable[[], httpx.Client | None] = lambda: None,
        exec_runner: Callable[..., Any] = subprocess.run,
        repair_transport: httpx.AsyncBaseTransport | None = None,
    ) -> None:
        self._home = Path(home)
        self._public = Path(public)
        self._config = config
        self._signal_proxy = signal_proxy_fn or (lambda: signal_proxy(self._home))
        self._proxy_running = proxy_running_fn or (lambda: proxy_running(self._home))
        self._http_client = http_client
        self._exec_runner = exec_runner
        self._repair_transport = repair_transport
        self._keys_lock = threading.Lock()
        self._methods: dict[str, Callable[[dict[str, Any]], Reply]] = {
            "status": self._status, "keys.list": self._keys_list, "keys.new": self._keys_new,
            "keys.use": self._keys_use, "keys.retire": self._keys_retire,
            "refs.register": self._refs_register, "refs.release": self._refs_release,
            "credential.info": self._credential_info, "credential.reissue": self._credential_reissue,
            "mcp.describe": self._mcp_describe, "mcp.otp": self._mcp_otp, "mcp.http": self._mcp_http,
            "mcp.exec": self._mcp_exec, "mcp.repair": self._mcp_repair,
            "browser.resolve": self._browser_resolve, "browser.register": self._browser_register,
            "browser.config": self._browser_config, "logs.tail": self._logs_tail,
        }

    @property
    def methods(self) -> tuple[str, ...]:
        return tuple(self._methods)

    def call(self, method: str, params: dict[str, Any]) -> Reply:
        handler = self._methods.get(method)
        if handler is None:
            raise ValidationError(f"未知方法：{method}")
        return handler(params)

    def publish(self) -> None:
        """keys.json and ca.pem, at start and after every key change (§3.3)."""
        publish_keys(self._home, self._public)
        publish_ca(self._home / MITMPROXY_DIR, self._public)

    def _resolver(self, scope: str | None) -> Resolver:
        return Resolver.from_home(self._home, scope=scope)

    # -- status and keys ------------------------------------------------------------------------

    def _status(self, params: dict[str, Any]) -> Reply:
        fields(params, set())
        config = self._config()
        publish_ca(self._home / MITMPROXY_DIR, self._public)  # the proxy may have created its CA since start-up
        return Reply({"version": __version__, "proxyPort": config.proxy_port if config else None,
                      "runtimeVersion": config.runtime_version if config else None,
                      "keys": [r.to_json() for r in key_rows(self._home)], "proxyRunning": self._proxy_running()})

    def _keys_list(self, params: dict[str, Any]) -> Reply:
        fields(params, set())
        return Reply([r.to_json() for r in key_rows(self._home)])

    def _changed_keys(self, name: str) -> Reply:
        rows = publish_keys(self._home, self._public)
        self._signal_proxy()  # a proxy that is down loads every key when it starts
        return Reply(next(r.to_json() for r in rows if r.name == name), labels=(name,))

    def _keys_new(self, params: dict[str, Any]) -> Reply:
        fields(params, {"name"}, {"use"})
        use = params.get("use", False)
        if not isinstance(use, bool):
            raise ValidationError("参数无效：use 应为 true 或 false")
        with self._keys_lock:
            info = create_keypair(self._home, text(params, "name", 64))
            if use:
                set_current(self._home, info.name)
            return self._changed_keys(info.name)

    def _keys_use(self, params: dict[str, Any]) -> Reply:
        name = text(fields(params, {"name"}), "name", 64)
        with self._keys_lock:
            set_current(self._home, name)
            return self._changed_keys(name)

    def _keys_retire(self, params: dict[str, Any]) -> Reply:
        name = text(fields(params, {"name"}), "name", 64)
        with self._keys_lock:
            retire_keypair(self._home, name)
            publish_keys(self._home, self._public)
            self._signal_proxy()
        return Reply({"retired": name}, labels=(name,))

    # -- dispatcher: references and credential repair --------------------------------------------

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

    def _credential(self, command: str, params: dict[str, Any]) -> Reply:
        result = credential_call(self._resolver(None), lambda: load_public_key(self._home), command, params)
        return Reply(result, labels=(result["label"],))

    def _credential_info(self, params: dict[str, Any]) -> Reply:
        return self._credential(CREDENTIAL_INFO, params)

    def _credential_reissue(self, params: dict[str, Any]) -> Reply:
        return self._credential(CREDENTIAL_REISSUE, params)

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
        labels = tuple(dict.fromkeys(label for s in secrets for label in self._label(resolver, s)))
        return Reply({"status": result.status, "headers": result.headers, "body": result.body},
                     labels=labels, host=urlsplit(url).hostname)

    def _mcp_exec(self, params: dict[str, Any]) -> Reply:
        fields(params, {"template", "token"}, {"scope", "args"})
        args = params.get("args") or []
        if not isinstance(args, list) or not all(isinstance(a, str) for a in args):
            raise ValidationError("参数无效：args 应为字符串列表")
        resolver, token = self._resolver(scope_of(params)), text(params, "token")
        try:
            result = op_exec(resolver, load_templates(self._home), template=text(params, "template", 64), token=token,
                             args=tuple(args), runner=self._exec_runner)
        except (OSError, subprocess.SubprocessError) as exc:
            raise GateError(f"command failed to run ({type(exc).__name__})") from None
        return Reply({"returncode": result.returncode, "stdout": result.stdout, "stderr": result.stderr},
                     labels=self._label(resolver, token))

    def _mcp_repair(self, params: dict[str, Any]) -> Reply:
        fields(params, {"token", "host"}, {"scope", "purpose", "repairUrl", "repairKey"})
        bridge = {"SECRET_GATE_REPAIR_URL": params.get("repairUrl") or "",
                  "SECRET_GATE_REPAIR_KEY": params.get("repairKey") or ""}
        if not all(isinstance(v, str) for v in bridge.values()):
            raise ValidationError("参数无效：repairUrl、repairKey 应为字符串")
        resolver = self._resolver(scope_of(params))
        result = asyncio.run(repair_scoped(resolver, params["token"], params["host"], params.get("purpose", REPAIR_PURPOSE),
                                           env=bridge, transport=self._repair_transport))
        return Reply(result, labels=(result.get("label", ""),), host=str(params["host"]))

    # -- browser component (runs as the login user) ----------------------------------------------

    def _browser_resolve(self, params: dict[str, Any]) -> Reply:
        fields(params, {"token", "host"}, {"scope"})
        host = page_host(params["host"])
        resolution = self._resolver(scope_of(params)).resolve_exact(text(params, "token"), use=USE_FILL, host=host)
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
        return Reply({"text": tail(self._home / "logs" / f"{name}.log", lines)})


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
