"""SIGHUP reload of `upstream-insecure.txt` in a running proxy (gate-next-v0 §3).

`secret-gate service reload` (or `kill -HUP <mitmdump pid>`) makes the proxy re-read the list of hosts whose
upstream certificate is accepted unverified, without dropping connections or restarting.

Rules:
* Only the file the admin maintains is read. Nothing is ever added because a request failed, and there is no
  way to switch verification off globally: every pattern names a host, `host:port` or `*.suffix`.
* The new set replaces the old one in one assignment (`UpstreamTlsAddon.replace_patterns`), so a handshake sees
  either the old or the new list, never a mix.
* A file that cannot be trusted keeps the previous set: unreadable, not UTF-8, larger than 64 KiB, writable by
  group/others, or with a line that is not a host pattern (reported with its line number; a wildcard with a
  port is refused because it could never match). A *missing* file means "no exceptions": the strict direction.
* The outcome goes to stderr (the service's `proxy.err.log`), not through mitmproxy's logger: `secret-gate
  proxy` runs mitmdump with `-q`, which drops everything below ERROR, and the admin who sent the signal must see
  the result. Host names are not secret; the added/removed patterns are printed because each addition switches
  verification off for a host and belongs in the log.

Keys (gate-service-v0 §2): when given the proxy's `SecretGateAddon`, the same SIGHUP also reloads every private
key of the gate home (current and legacy) and swaps the addon's resolver in one assignment. The gate service's rpc
server sends it after `keys.new/use/retire`, so tokens made for a new current key work without a restart. A home
whose keys cannot be loaded keeps the previous resolver (the failure is reported, never an empty key set).

Without this addon SIGHUP terminates mitmdump (default action); under launchd `KeepAlive` restarts it, which
also re-reads the file, but drops every open connection.
"""

from __future__ import annotations

import asyncio
import ipaddress
import signal
import stat
import sys
from collections.abc import Callable
from dataclasses import dataclass
from pathlib import Path

from typing import TYPE_CHECKING, Protocol

from .constants import HOST_PATTERN
from .errors import GateError, ValidationError
from .upstream_tls import UPSTREAM_INSECURE_FILE, UpstreamTlsAddon

if TYPE_CHECKING:
    from .resolver import Resolver


class ResolverHolder(Protocol):
    """What the reloader swaps keys in: the proxy's SecretGateAddon."""

    def replace_resolver(self, resolver: Resolver) -> None: ...

MAX_FILE_BYTES = 64 * 1024
MAX_LISTED_CHANGES = 20
_PREFIX = f"secret-gate: {UPSTREAM_INSECURE_FILE}"


@dataclass(frozen=True)
class ReloadResult:
    ok: bool
    patterns: frozenset[str]
    message: str


def _valid_host(host: str) -> bool:
    if HOST_PATTERN.fullmatch(host):
        return True
    try:
        ipaddress.ip_address(host)
    except ValueError:
        return False
    return True


def valid_pattern(pattern: str) -> bool:
    """`host`, `host:port`, `*.suffix` or an IP literal, lower-case (as `parse_insecure_hosts` produces)."""
    if _valid_host(pattern):
        return True
    host, sep, port = pattern.rpartition(":")
    if not sep or not (port.isascii() and port.isdecimal()) or not 0 < int(port) < 65536 or host.startswith("*."):
        return False
    return _valid_host(host)


def check_insecure_hosts(text: str) -> frozenset[str]:
    """Same result as `parse_insecure_hosts`, but every line must be a host pattern."""
    out: set[str] = set()
    for number, raw in enumerate(text.splitlines(), start=1):
        line = raw.split("#", 1)[0].strip().lower()
        if not line:
            continue
        if not valid_pattern(line):
            raise ValidationError(f"line {number}: {line!r} is not host, host:port or *.suffix")
        out.add(line)
    return frozenset(out)


def read_insecure_hosts(path: Path) -> frozenset[str]:
    """Strictly load the admin's list; raises ValidationError when the file must not be trusted."""
    try:
        info = path.stat()
    except FileNotFoundError:
        return frozenset()
    except OSError as exc:
        raise ValidationError(f"cannot stat {path}: {exc.strerror or exc}") from None
    if not stat.S_ISREG(info.st_mode):
        raise ValidationError(f"{path} is not a regular file")
    if stat.S_IMODE(info.st_mode) & 0o022:
        raise ValidationError(f"{path} is writable by group/others (mode {stat.S_IMODE(info.st_mode):o}); chmod 644")
    if info.st_size > MAX_FILE_BYTES:
        raise ValidationError(f"{path} is larger than {MAX_FILE_BYTES} bytes")
    try:
        text = path.read_bytes().decode("utf-8")
    except OSError as exc:
        raise ValidationError(f"cannot read {path}: {exc.strerror or exc}") from None
    except UnicodeDecodeError:
        raise ValidationError(f"{path} is not UTF-8 text") from None
    return check_insecure_hosts(text)


def _listed(items: frozenset[str]) -> str:
    ordered = sorted(items)
    shown = ", ".join(ordered[:MAX_LISTED_CHANGES])
    more = len(ordered) - MAX_LISTED_CHANGES
    return shown + (f" (+{more} more)" if more > 0 else "")


def reload_patterns(path: Path, previous: frozenset[str]) -> ReloadResult:
    """Pure decision: the set to use from now on and the line to report."""
    try:
        new = read_insecure_hosts(path)
    except ValidationError as exc:
        return ReloadResult(False, previous, f"{_PREFIX} reload FAILED, keeping the previous "
                                             f"{len(previous)} pattern(s): {exc}")
    changes = [f"added: {_listed(new - previous)}" if new - previous else "",
               f"removed: {_listed(previous - new)}" if previous - new else ""]
    summary = "; ".join(c for c in changes if c) or "unchanged"
    return ReloadResult(True, new, f"{_PREFIX} reloaded: {len(new)} pattern(s) ({summary})")


def initial_patterns(home: Path) -> frozenset[str]:
    """Start-up uses the same strict rules as a reload; a file that cannot be trusted means no exceptions."""
    result = reload_patterns(Path(home) / UPSTREAM_INSECURE_FILE, frozenset())
    if not result.ok:
        _to_stderr(result.message.replace("reload FAILED", "not loaded at start-up"))
    return result.patterns


def _to_stderr(line: str) -> None:
    print(line, file=sys.stderr, flush=True)


class InsecureHostsReloader:
    """mitmproxy addon: on SIGHUP, re-read `<home>/upstream-insecure.txt` into an `UpstreamTlsAddon`."""

    def __init__(
        self,
        target: UpstreamTlsAddon,
        home: Path,
        *,
        emit: Callable[[str], None] = _to_stderr,
        get_loop: Callable[[], asyncio.AbstractEventLoop] = asyncio.get_running_loop,
        signum: int | None = getattr(signal, "SIGHUP", None),
        keys: ResolverHolder | None = None,
        load_resolver: Callable[[Path], Resolver] | None = None,
    ) -> None:
        self._target = target
        self._home = Path(home)
        self._path = home / UPSTREAM_INSECURE_FILE
        self._keys = keys
        self._load_resolver = load_resolver
        self._emit = emit
        self._get_loop = get_loop
        self._signum = signum
        self._loop: asyncio.AbstractEventLoop | None = None

    def reload(self) -> ReloadResult:
        result = reload_patterns(self._path, self._target.patterns)
        if result.ok:
            self._target.replace_patterns(result.patterns)
        self._emit(result.message)
        if self._keys is not None:
            self.reload_keys()
        return result

    def reload_keys(self) -> bool:
        """Swap in a resolver holding every key of the home now; keep the previous one when that fails."""
        if self._keys is None:
            return False
        load = self._load_resolver or _default_load_resolver
        try:
            resolver = load(self._home)
        except (GateError, OSError) as exc:
            self._emit(f"secret-gate: keys reload FAILED, keeping the previous keys: {exc}")
            return False
        self._keys.replace_resolver(resolver)
        self._emit(f"secret-gate: keys reloaded: {resolver.key_count} private key(s)")
        return True

    # mitmproxy hooks -------------------------------------------------------------------------

    def running(self) -> None:
        if self._signum is None:
            self._emit(f"{_PREFIX}: no SIGHUP on this platform; restart the proxy to reload")
            return
        loop = self._get_loop()
        try:
            loop.add_signal_handler(self._signum, self.reload)
        except (NotImplementedError, RuntimeError, ValueError) as exc:
            self._emit(f"{_PREFIX}: SIGHUP reload unavailable ({exc}); restart the proxy to reload")
            return
        self._loop = loop

    def done(self) -> None:
        if self._loop is not None and self._signum is not None:
            self._loop.remove_signal_handler(self._signum)
            self._loop = None


def _default_load_resolver(home: Path) -> Resolver:
    from .resolver import Resolver  # local import: the resolver pulls in the refs registry

    return Resolver.from_home(home)
