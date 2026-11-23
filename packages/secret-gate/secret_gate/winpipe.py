"""The gate service's local interface on Windows: a named pipe instead of `gate.sock` (gate-simple-v0 §5, Windows column).

Same wire format (rpc_protocol: one JSON line each way) and the same methods; only the transport differs.

* **Address.** Everything above this module still names the interface by its POSIX path, `<public>/gate.sock`
  (`SystemLayout.socket`, `service_paths.client_socket`). `pipe_name` maps that path to a pipe: the installed
  service's `<ProgramData>\\AgentSwitch\\gate-public\\gate.sock` is `\\\\.\\pipe\\agentswitch-gate`; any other public
  directory (tests, `SECRET_GATE_PUBLIC`) gets `agentswitch-gate-<hash of the path>`, so two gates never share a pipe.
* **Who may connect (server).** Every pipe instance is created with a security descriptor whose owner is the server's
  own account and whose DACL allows only that account (full) and the allowed peers (`ownerSid` of gate-service.json and
  SYSTEM) to read and write data. Not FILE_APPEND_DATA: on a pipe that bit is FILE_CREATE_PIPE_INSTANCE, and a client
  holding it could add its own instance of the service's pipe. The first instance is created with
  FILE_FLAG_FIRST_PIPE_INSTANCE (a pipe squatted under that name makes the service fail instead of sharing it), and
  remote clients are rejected. Then, as on POSIX, the server checks the peer itself: after the first line it
  impersonates the client (ImpersonateNamedPipeClient, which Windows allows only once data was read), reads the user
  SID of that token and closes the connection without an answer when it is not allowed. The DACL is the gate, the SID
  check is the rule `rpc_server` applies on every system.
* **Whom the client talks to.** A pipe name is first come, first served. The client opens it at identification level
  only (SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION: the server cannot act as the client) and, before sending
  anything, reads the pipe's owner: it must be the gate service's account (`NT SERVICE\\AgentSwitchGate`) when the
  service is installed, the client's own account otherwise (a gate without service: tests). An agent that created the
  pipe first owns it and cannot make the service's SID its owner.

Timeouts work as on a socket: every read and write is overlapped and waited for with a limit.
"""

from __future__ import annotations

import hashlib
import threading
from collections.abc import Callable
from pathlib import Path
from typing import Any

from . import fsacl

PIPE_PREFIX = "\\\\.\\pipe\\"
SERVICE_PIPE = PIPE_PREFIX + "agentswitch-gate"
BUFFER_BYTES = 65536

# winbase.h / winnt.h, not all of them in pywin32's constant modules.
FILE_FLAG_FIRST_PIPE_INSTANCE = 0x0008_0000
FILE_FLAG_OVERLAPPED = 0x4000_0000
PIPE_REJECT_REMOTE_CLIENTS = 0x0000_0008
SECURITY_SQOS_PRESENT = 0x0010_0000
SECURITY_IDENTIFICATION = 0x0001_0000
READ_CONTROL = 0x0002_0000
SYNCHRONIZE = 0x0010_0000
FILE_READ_ATTRIBUTES = 0x0080
CLIENT_ACCESS = fsacl.FILE_READ_DATA | fsacl.FILE_WRITE_DATA | FILE_READ_ATTRIBUTES | READ_CONTROL | SYNCHRONIZE
ERROR_FILE_NOT_FOUND = 2
ERROR_BROKEN_PIPE = 109
ERROR_PIPE_BUSY = 231
ERROR_PIPE_NOT_CONNECTED = 233
ERROR_PIPE_CONNECTED = 535
ERROR_OPERATION_ABORTED = 995
ERROR_IO_PENDING = 997
WAIT_TIMEOUT = 0x102
_CLOSED = (ERROR_BROKEN_PIPE, ERROR_PIPE_NOT_CONNECTED)


def pipe_name(address: Path, service_socket: Path | None = None) -> str:
    """The pipe for the interface at `address` (`<public>/gate.sock`); `service_socket` is the installed service's."""
    if service_socket is None:
        from .service_paths import SystemLayout

        service_socket = SystemLayout.native().socket
    if str(address).lower() == str(service_socket).lower():
        return SERVICE_PIPE
    digest = hashlib.sha256(str(address).lower().encode("utf-8")).hexdigest()[:16]
    return f"{SERVICE_PIPE}-{digest}"


def expected_server_sid(address: Path, *, service_installed: Callable[[Path], bool] | None = None,
                        own_sid: Callable[[], str] | None = None) -> str:
    """The account that must own the pipe: the gate service's once gate-service.json is next to the public directory
    (as service_paths.client_socket decides), else this process's own (a gate without service)."""
    from .service_paths import _exists, config_path_for

    installed = (service_installed or (lambda public: _exists(config_path_for(public))))(Path(address).parent)
    return fsacl.GATE_SERVICE_SID if installed else (own_sid or fsacl.current_user_sid)()


def _os_error(exc: Any) -> OSError:
    """pywintypes.error as an OSError, so callers handle a pipe like a socket."""
    error = OSError(getattr(exc, "winerror", None), getattr(exc, "strerror", None) or str(exc))
    error.winerror = getattr(exc, "winerror", None)  # type: ignore[attr-defined]
    return error


class PipeStream:
    """One end of a connected pipe, overlapped, with a timeout on every read and write (seconds; None: none)."""

    def __init__(self, handle: Any, timeout: float | None) -> None:
        import win32event

        self._handle = handle
        self._timeout = timeout
        self._event = win32event.CreateEvent(None, True, False, None)
        self._buffer = b""

    @property
    def handle(self) -> Any:
        return self._handle

    def settimeout(self, timeout: float | None) -> None:
        self._timeout = timeout

    def _wait(self, overlapped: Any) -> int:
        import pywintypes
        import win32event
        import win32file

        milliseconds = win32event.INFINITE if self._timeout is None else max(1, int(self._timeout * 1000))
        if win32event.WaitForSingleObject(self._event, milliseconds) == WAIT_TIMEOUT:
            win32file.CancelIo(self._handle)
            try:
                win32file.GetOverlappedResult(self._handle, overlapped, True)
            except pywintypes.error:
                pass
            raise TimeoutError("timed out")
        try:
            return win32file.GetOverlappedResult(self._handle, overlapped, True)
        except pywintypes.error as exc:
            if exc.winerror in _CLOSED:
                return 0
            raise _os_error(exc) from None

    def _overlapped(self) -> Any:
        import pywintypes
        import win32event

        win32event.ResetEvent(self._event)
        overlapped = pywintypes.OVERLAPPED()
        overlapped.hEvent = self._event
        return overlapped

    def recv(self, size: int) -> bytes:
        """Up to `size` bytes; b"" when the other end closed."""
        import pywintypes
        import win32file

        if self._buffer:
            data, self._buffer = self._buffer[:size], self._buffer[size:]
            return data
        overlapped = self._overlapped()
        buffer = win32file.AllocateReadBuffer(size)
        try:
            win32file.ReadFile(self._handle, buffer, overlapped)
        except pywintypes.error as exc:
            if exc.winerror in _CLOSED:
                return b""
            raise _os_error(exc) from None
        count = self._wait(overlapped)
        return bytes(buffer[:count])

    def sendall(self, data: bytes) -> None:
        import pywintypes
        import win32file

        view = memoryview(data)
        while view:
            overlapped = self._overlapped()
            chunk = bytes(view)  # kept referenced until the write completed (overlapped I/O reads it later)
            try:
                win32file.WriteFile(self._handle, chunk, overlapped)
            except pywintypes.error as exc:
                raise _os_error(exc) from None
            written = self._wait(overlapped)
            if written <= 0:
                raise BrokenPipeError("pipe closed")
            view = view[written:]

    def flush(self) -> None:
        """Wait until the other end read everything written (closing could otherwise drop an unread answer)."""
        import win32file

        try:
            win32file.FlushFileBuffers(self._handle)
        except Exception:  # noqa: BLE001 - the other end is gone: nothing left to deliver
            pass

    def readline(self, limit: int) -> bytes:
        """One line including its newline, at most `limit` bytes (like socket.makefile().readline(limit))."""
        data = self._buffer
        self._buffer = b""
        while b"\n" not in data and len(data) < limit:
            chunk = self.recv(BUFFER_BYTES)
            if not chunk:
                break
            data += chunk
        cut = data.find(b"\n")
        end = min(limit, cut + 1) if cut >= 0 else min(limit, len(data))
        self._buffer = data[end:] + self._buffer
        return data[:end]

    def close(self) -> None:
        import win32file

        try:
            win32file.CloseHandle(self._handle)
        except Exception:  # noqa: BLE001 - closing twice or a handle already gone
            pass
        try:
            self._event.Close()
        except Exception:  # noqa: BLE001
            pass


# -- client --------------------------------------------------------------------------------------

def pipe_owner_sid(handle: Any) -> str:
    import pywintypes
    import win32security

    info = win32security.OWNER_SECURITY_INFORMATION
    try:
        sd = win32security.GetSecurityInfo(handle, win32security.SE_KERNEL_OBJECT, info)
    except pywintypes.error:
        sd = win32security.GetSecurityInfo(handle, win32security.SE_FILE_OBJECT, info)
    return win32security.ConvertSidToStringSid(sd.GetSecurityDescriptorOwner())


def connect(address: Path, timeout: float, expected_owner: str | None = None) -> PipeStream:
    """Open the pipe for `address` and check who created it (module docstring); OSError like a socket's connect."""
    import pywintypes
    import win32file
    import win32pipe

    name = pipe_name(Path(address))
    owner = expected_owner or expected_server_sid(Path(address))
    flags = FILE_FLAG_OVERLAPPED | SECURITY_SQOS_PRESENT | SECURITY_IDENTIFICATION
    for _attempt in range(2):
        try:
            handle = win32file.CreateFile(name, CLIENT_ACCESS, 0, None, win32file.OPEN_EXISTING, flags, None)
            break
        except pywintypes.error as exc:
            if exc.winerror != ERROR_PIPE_BUSY:
                raise _os_error(exc) from None
            try:
                win32pipe.WaitNamedPipe(name, max(1, int(timeout * 1000)))
            except pywintypes.error as wait_error:
                raise _os_error(wait_error) from None
    else:
        raise TimeoutError("timed out")
    stream = PipeStream(handle, timeout)
    try:
        actual = pipe_owner_sid(handle)
    except Exception as exc:  # noqa: BLE001 - pywintypes.error
        stream.close()
        raise OSError(None, f"cannot read who created {name} ({exc})") from None
    if actual != owner:
        stream.close()
        raise OSError(None, f"{name} was not created by the gate service account ({actual})")
    return stream


# -- server --------------------------------------------------------------------------------------

def client_sid(stream: PipeStream) -> str:
    """The user SID of the connected client, from its token (Windows allows this only once data was read)."""
    import win32api
    import win32security

    win32security.ImpersonateNamedPipeClient(stream.handle)
    try:
        token = win32security.OpenThreadToken(win32api.GetCurrentThread(), win32security.TOKEN_QUERY, True)
        try:
            sid, _attributes = win32security.GetTokenInformation(token, win32security.TokenUser)
        finally:
            token.Close()
    finally:
        win32security.RevertToSelf()
    return win32security.ConvertSidToStringSid(sid)


def security_attributes(own_sid: str, peers: frozenset[str]) -> Any:
    """Owner: the server's account. DACL: the server's account full; each peer read/write data (no new instance)."""
    import win32security

    sd = win32security.SECURITY_DESCRIPTOR()
    own = win32security.ConvertStringSidToSid(own_sid)
    sd.SetSecurityDescriptorOwner(own, False)
    dacl = win32security.ACL()
    dacl.AddAccessAllowedAce(win32security.ACL_REVISION, fsacl.FILE_ALL_ACCESS, own)
    for peer in sorted(peers - {own_sid}):
        dacl.AddAccessAllowedAce(win32security.ACL_REVISION, CLIENT_ACCESS, win32security.ConvertStringSidToSid(peer))
    sd.SetSecurityDescriptorDacl(1, dacl, 0)
    attributes = win32security.SECURITY_ATTRIBUTES()
    attributes.SECURITY_DESCRIPTOR = sd
    attributes.bInheritHandle = False
    return attributes


class PipeListener:
    """Accepts connections on one pipe name, each on its own instance; `accept` returns None once `close` was called.

    The first instance is created here (it claims the name, like bind), and the next one as soon as a client takes the
    current one, so the name never lapses while the server runs."""

    def __init__(self, name: str, own_sid: str, peers: Callable[[], frozenset[str]]) -> None:
        self.name = name
        self._own = own_sid
        self._peers = peers
        self._first = True
        self._closed = threading.Event()
        self._pending: Any = self._instance()

    def _instance(self) -> Any:
        import pywintypes
        import win32pipe

        open_mode = win32pipe.PIPE_ACCESS_DUPLEX | FILE_FLAG_OVERLAPPED
        if self._first:
            open_mode |= FILE_FLAG_FIRST_PIPE_INSTANCE
        pipe_mode = (win32pipe.PIPE_TYPE_BYTE | win32pipe.PIPE_READMODE_BYTE | win32pipe.PIPE_WAIT
                     | PIPE_REJECT_REMOTE_CLIENTS)
        try:
            handle = win32pipe.CreateNamedPipe(self.name, open_mode, pipe_mode, win32pipe.PIPE_UNLIMITED_INSTANCES,
                                               BUFFER_BYTES, BUFFER_BYTES, 0,
                                               security_attributes(self._own, self._peers()))
        except pywintypes.error as exc:
            if self._first:
                raise OSError(None, f"{self.name} already exists ({exc.strerror}); another process holds it") from None
            raise _os_error(exc) from None
        self._first = False
        return handle

    def accept(self, poll_interval: float = 0.5) -> PipeStream | None:
        import pywintypes
        import win32event
        import win32file
        import win32pipe

        while not self._closed.is_set():
            handle, self._pending = self._pending or self._instance(), None
            stream = PipeStream(handle, None)
            overlapped = stream._overlapped()
            try:
                result = win32pipe.ConnectNamedPipe(handle, overlapped)
            except pywintypes.error as exc:
                stream.close()
                if exc.winerror in _CLOSED:   # a client came and went before we looked: next instance
                    continue
                raise _os_error(exc) from None
            connected = result == ERROR_PIPE_CONNECTED
            while not connected and not self._closed.is_set():
                if win32event.WaitForSingleObject(stream._event, max(1, int(poll_interval * 1000))) == WAIT_TIMEOUT:
                    continue
                try:
                    win32file.GetOverlappedResult(handle, overlapped, True)
                except pywintypes.error as exc:
                    if exc.winerror in (ERROR_OPERATION_ABORTED, *_CLOSED):
                        break
                    stream.close()
                    raise _os_error(exc) from None
                connected = True
            if connected:
                self._pending = self._instance()
                return stream
            win32file.CancelIo(handle)
            stream.close()
        return None

    def close(self) -> None:
        self._closed.set()
        pending, self._pending = self._pending, None
        if pending is not None:
            import win32file

            try:
                win32file.CloseHandle(pending)
            except Exception:  # noqa: BLE001
                pass
