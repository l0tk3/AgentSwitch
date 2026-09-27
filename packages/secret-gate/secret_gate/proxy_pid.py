"""`<gate home>/proxy.pid`: how the gate service's rpc server finds its proxy to send SIGHUP (gate-service-v0 §2).

Both run as the service account, so the rpc server may signal the proxy, but only the root `launchctl` could
address it by label. The proxy therefore records its own pid once it is listening (mitmproxy's `running` hook, in
the mitmdump process itself) and removes it on a clean shutdown. A reader trusts the file only when it is a
regular file of this uid, not writable by others, holding one pid of a live process that this uid may signal.
"""

from __future__ import annotations

import os
import signal
import stat
import sys
from collections.abc import Callable
from pathlib import Path

PID_FILE = "proxy.pid"
MAX_PID_BYTES = 32


def pid_path(home: Path) -> Path:
    return Path(home) / PID_FILE


def write_pid(home: Path, pid: int | None = None) -> None:
    path = pid_path(home)
    tmp = path.with_name(f".{PID_FILE}.{os.getpid()}")
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_TRUNC | os.O_NOFOLLOW, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(f"{os.getpid() if pid is None else pid}\n")
    os.replace(tmp, path)


def remove_pid(home: Path, pid: int | None = None) -> None:
    """Remove the file only if it still names this process (a newer proxy may have replaced it)."""
    if read_pid(home) == (os.getpid() if pid is None else pid):
        pid_path(home).unlink(missing_ok=True)


def read_pid(home: Path, uid: int | None = None) -> int | None:
    path = pid_path(home)
    try:
        info = path.lstat()
        if not stat.S_ISREG(info.st_mode) or info.st_uid != (os.getuid() if uid is None else uid):
            return None
        if stat.S_IMODE(info.st_mode) & 0o022:
            return None
        text = path.read_bytes()[:MAX_PID_BYTES].decode("ascii").strip()
    except (OSError, UnicodeDecodeError):
        return None
    return int(text) if text.isdigit() and 1 < int(text) < 2**31 else None


def alive(pid: int, kill: Callable[[int, int], None] = os.kill) -> bool:
    try:
        kill(pid, 0)
    except OSError:  # ESRCH: gone; EPERM: another user's process now holds that pid
        return False
    return True


def proxy_running(home: Path, kill: Callable[[int, int], None] = os.kill) -> bool:
    pid = read_pid(home)
    return pid is not None and alive(pid, kill)


def signal_proxy(home: Path, kill: Callable[[int, int], None] = os.kill,
                 signum: int = getattr(signal, "SIGHUP", 1)) -> bool:
    """SIGHUP the proxy (reload keys and upstream exceptions). False when there is no live proxy to signal."""
    pid = read_pid(home)
    if pid is None or not alive(pid, kill):
        return False
    try:
        kill(pid, signum)
    except OSError:
        return False
    return True


class PidFileAddon:
    """mitmproxy addon: write `proxy.pid` once the proxy is listening, remove it on shutdown."""

    def __init__(self, home: Path) -> None:
        self._home = Path(home)

    def running(self) -> None:
        try:
            write_pid(self._home)
        except OSError as exc:
            print(f"secret-gate: {PID_FILE} not written ({exc.strerror or exc}); keys reload after "
                  "a key change needs a restart", file=sys.stderr, flush=True)

    def done(self) -> None:
        try:
            remove_pid(self._home)
        except OSError:
            pass
