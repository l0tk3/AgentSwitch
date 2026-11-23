"""The narrow verb set the gate exposes. Every result passes through the redactor before returning.

What cannot be redacted is withheld (gate-simple-v0 §3.2), whole: a response body or command output over
MAX_BODY_BYTES (never cut at the limit, so no value is split by a cut the redactor did not see), a body in a
content-encoding httpx cannot decode, a body whose bytes still hold a value after its text was redacted, and anything
the redactor fails on."""

from __future__ import annotations

import os
import re
import subprocess
import sys
from collections.abc import Callable, Mapping
from dataclasses import dataclass, field
from typing import Any
from urllib.parse import urlsplit

import httpx

from . import fsacl
from .constants import (
    EXEC_TIMEOUT_SECONDS,
    HTTP_TIMEOUT_SECONDS,
    MAX_BODY_BYTES,
    USE_HTTP,
    USE_OTP,
)
from .errors import GateError, ValidationError
from .redact import Redactor, withheld
from .resolver import Resolution, Resolver
from .tokens import find_secrets, is_secret

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


# -- secret_exec (gate-simple-v0 §2.1) ------------------------------------------------------------
# The agent writes the command; values reach it only as environment variables. The command runs as the login user,
# in the `secret-gate mcp` process, never as the gate service: an arbitrary command run as the service account could
# read the service's private key.

EXEC_PATH = "/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin"
# Besides PATH (always EXEC_PATH), the only variables the child takes from the MCP process.
EXEC_INHERITED_ENV = ("HOME", "LANG", "LC_ALL", "TZ", "TMPDIR")
MAX_EXEC_ARGS = 256
MAX_EXEC_ARG_CHARS = 32768
MAX_EXEC_ENV = 32
_EXEC_ENV_NAME = re.compile(r"[A-Za-z_][A-Za-z0-9_]{0,63}")
# Variables that change how a program, its loader or its interpreter runs, or that the base environment sets.
EXEC_DENIED_NAMES = frozenset({
    "PATH", "HOME", "SHELL", "ENV", "BASH_ENV", "IFS", "CDPATH", "PS4", "PROMPT_COMMAND", "TMPDIR", "USER",
    "LOGNAME", "LANG", "TZ", "NODE_OPTIONS", "JAVA_TOOL_OPTIONS", "_JAVA_OPTIONS", "JDK_JAVA_OPTIONS", "SSH_ASKPASS",
    "EDITOR", "VISUAL", "PAGER", "GCONV_PATH", "HOSTALIASES", "RESOLV_HOST_CONF", "LOCALDOMAIN", "MALLOC_CHECK_",
    "OPENSSL_CONF", "SSL_CERT_FILE", "SSL_CERT_DIR", "CURL_CA_BUNDLE", "REQUESTS_CA_BUNDLE",
    "HTTP_PROXY", "HTTPS_PROXY", "ALL_PROXY", "NO_PROXY",
})
EXEC_DENIED_PREFIXES = ("LD_", "DYLD_", "PYTHON", "NODE_", "PERL", "RUBY", "BASH_FUNC_", "LC_", "GIT_",
                        "SECRET_GATE_", "NPM_CONFIG_", "XDG_")

# Windows (gate-simple-v0 §5): the child's base comes from the system, not from this process. PATH is fixed below the
# Windows directory (GetWindowsDirectoryW), PATHEXT and ComSpec are fixed, and only these variables are taken over;
# the agent may not set any of them, nor anything that makes cmd, PowerShell, the .NET runtime or the loader run
# something else (profilers, startup hooks, compatibility shims, symbol paths, module paths).
WINDOWS_EXEC_INHERITED_ENV = ("USERPROFILE", "HOMEDRIVE", "HOMEPATH", "APPDATA", "LOCALAPPDATA", "TEMP", "TMP",
                              "USERNAME", "LANG", "LC_ALL", "TZ")
WINDOWS_EXEC_PATHEXT = ".COM;.EXE;.BAT;.CMD"
WINDOWS_EXEC_DENIED_NAMES = frozenset({
    "PATHEXT", "COMSPEC", "SYSTEMROOT", "SYSTEMDRIVE", "WINDIR", "TEMP", "TMP", "USERPROFILE", "HOMEDRIVE",
    "HOMEPATH", "APPDATA", "LOCALAPPDATA", "PROGRAMDATA", "PROGRAMFILES", "PROGRAMW6432", "COMMONPROGRAMFILES",
    "COMMONPROGRAMW6432", "ALLUSERSPROFILE", "PUBLIC", "USERNAME", "USERDOMAIN", "PSMODULEPATH",
    "PSEXECUTIONPOLICYPREFERENCE", "__PSLOCKDOWNPOLICY", "PROMPT", "DIRCMD", "COPYCMD", "__COMPAT_LAYER",
    "_NT_SYMBOL_PATH", "_NT_ALT_SYMBOL_PATH", "MSYS", "CYGWIN", "OPENSSL_MODULES", "OPENSSL_ENGINES",
})
WINDOWS_EXEC_DENIED_PREFIXES = ("COR_", "CORECLR_", "COMPLUS_", "DOTNET_", "MSYS2_", "PSMODULE")


def windows_exec_path(windows: str) -> str:
    system32 = windows + "\\System32"
    return ";".join((system32, windows, system32 + "\\Wbem", system32 + "\\WindowsPowerShell\\v1.0",
                     system32 + "\\OpenSSH"))


def check_exec_argv(argv: object) -> tuple[str, ...]:
    """The agent's own command line: 1–MAX_EXEC_ARGS non-empty strings, none holding a token or reference (a value
    in argv would be visible to every process on the machine, `ps`; values go in `env`)."""
    if not isinstance(argv, (list, tuple)) or not argv or len(argv) > MAX_EXEC_ARGS:
        raise ValidationError(f"argv 应为 1–{MAX_EXEC_ARGS} 个字符串的列表")
    for arg in argv:
        if not isinstance(arg, str) or not arg or len(arg) > MAX_EXEC_ARG_CHARS or "\0" in arg:
            raise ValidationError("argv 的每一项应为非空字符串")
        lowered = arg.lower()
        if "enc:" in lowered or "enc%3a" in lowered or find_secrets(arg):
            raise ValidationError("argv 中不能有密文或引用（enc:…）：命令行对本机所有进程可见；"
                                  "请把它放进 env，在命令里用 $变量名 引用")
    return tuple(argv)


def _denied(name: str, platform: str) -> bool:
    if name in EXEC_DENIED_NAMES or name.startswith(EXEC_DENIED_PREFIXES):
        return True
    return platform == "win32" and (name in WINDOWS_EXEC_DENIED_NAMES or name.startswith(WINDOWS_EXEC_DENIED_PREFIXES))


def check_exec_env(env: object, *, platform: str = sys.platform) -> dict[str, str]:
    """`{NAME: token or reference}`: 1–MAX_EXEC_ENV upper-case names that are not loader, interpreter or base
    variables (on Windows also its own, WINDOWS_EXEC_DENIED_*); each value exactly one enc:v1: token or enc:ref:
    reference."""
    if not isinstance(env, dict) or not env or len(env) > MAX_EXEC_ENV:
        raise ValidationError(f"env 应为 1–{MAX_EXEC_ENV} 个 {{变量名: 密文或引用}}")
    for name, value in env.items():
        if not isinstance(name, str) or not _EXEC_ENV_NAME.fullmatch(name) or name != name.upper():
            raise ValidationError(f"环境变量名 {name!r} 无效：只能用大写字母、数字和下划线，且不以数字开头")
        if _denied(name, platform):
            raise ValidationError(f"环境变量 {name} 不允许：它会改变程序、加载器或解释器的行为")
        if not isinstance(value, str) or value != value.strip() or not is_secret(value):
            raise ValidationError(f"环境变量 {name} 的值应恰好是一个密文（enc:v1:…）或引用（enc:ref:…）")
    return dict(env)


def exec_child_env(base: Mapping[str, str] | None = None, *, platform: str = sys.platform,
                   windows: str | None = None) -> dict[str, str]:
    """The child's base environment: PATH = EXEC_PATH, and HOME, LANG, LC_ALL, TZ, TMPDIR of this process if set.

    Windows: SystemRoot, windir, SystemDrive, ComSpec, PATHEXT and PATH from the Windows directory (`windows`, default
    GetWindowsDirectoryW), plus WINDOWS_EXEC_INHERITED_ENV of this process if set (TEMP, the profile directories)."""
    source = os.environ if base is None else base
    if platform != "win32":
        env = {name: source[name] for name in EXEC_INHERITED_ENV if source.get(name)}
        env["PATH"] = EXEC_PATH
        return env
    root = windows or fsacl.windows_dir()
    env = {name: source[name] for name in WINDOWS_EXEC_INHERITED_ENV if source.get(name)}
    env.update({"SystemRoot": root, "windir": root, "SystemDrive": root[:2], "ComSpec": root + "\\System32\\cmd.exe",
                "PATHEXT": WINDOWS_EXEC_PATHEXT, "PATH": windows_exec_path(root)})
    return env


def op_exec(
    resolve: Callable[[str], Resolution],
    *,
    argv: object,
    env: object,
    runner: Callable[..., Any] = subprocess.run,
    base_env: Mapping[str, str] | None = None,
    cwd: str | None = None,
) -> ExecResult:
    """Run the agent's command with each `env` token resolved (`resolve` opens only `exec` tokens) into its variable.
    stdin is empty, the environment minimal (exec_child_env), cwd this process's; stdout and stderr go through the
    redactor, and a stream over MAX_BODY_BYTES is withheld whole."""
    command = check_exec_argv(argv)
    wanted = check_exec_env(env)
    resolutions = {name: resolve(token) for name, token in wanted.items()}
    child = exec_child_env(base_env)
    child.update({name: r.value for name, r in resolutions.items()})
    try:
        proc = runner(
            list(command),
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=EXEC_TIMEOUT_SECONDS,
            check=False,
            env=child,
            stdin=subprocess.DEVNULL,
            cwd=cwd or os.getcwd(),
        )
    except subprocess.TimeoutExpired:
        raise GateError(f"command timed out after {EXEC_TIMEOUT_SECONDS} s; its output is not returned") from None
    except (OSError, subprocess.SubprocessError) as exc:
        raise GateError(f"command failed to run ({type(exc).__name__})") from None
    used = tuple(resolutions.values())
    redactor = Redactor(used)
    return ExecResult(
        returncode=proc.returncode,
        stdout=_redacted_output(proc.stdout, redactor),
        stderr=_redacted_output(proc.stderr, redactor),
        used=used,
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
