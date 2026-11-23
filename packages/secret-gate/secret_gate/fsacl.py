"""Who may read the gate's private files, on every system (gate-simple-v0 §0 point 3, §5 "私钥、CA 私钥" row).

POSIX keeps what it always had: modes (directories 0700, key files 0600; anything looser is refused). Windows has no
such modes (chmod only flips the read-only flag, `st_mode` of every writable file is 0666), so there the same rule is
a DACL:

* `restrict_to_current_user(dir)`: a protected DACL (nothing inherited from the profile or ProgramData) with one
  inheritable full-control entry for this process's user. The gate home made by `keygen` gets it; the files in it
  (key.priv, refs, logs) inherit it, so nothing writes an explicit ACL on a key file.
* `private_problem(path)` / `write_problem(path)`: why a file must not be trusted, or None. An entry that gives read
  (or write) access, or the right to change the ACL, to anyone but this user, SYSTEM, Administrators, TrustedInstaller
  or the gate service's own account is a problem; no DACL at all (everyone) is one too. Administrators are trusted as
  root is on POSIX: a non-elevated process of an administrator has that group as deny-only (UAC), so allow entries for
  it do not apply to the agent.
* `set_acl(path, grants, owner)`: exactly the given entries (`system install` on Windows, platform/windows.py).

The decision (`acl_problem`) and the service SID (`service_sid`) are pure and tested everywhere; only the pywin32
glue below them needs Windows, and it is imported only there (pyproject: `pywin32; sys_platform == "win32"`).
"""

from __future__ import annotations

import hashlib
import os
import struct
import sys
from collections.abc import Iterable
from dataclasses import dataclass
from pathlib import Path

IS_WINDOWS = sys.platform == "win32"

SYSTEM_SID = "S-1-5-18"
ADMINISTRATORS_SID = "S-1-5-32-544"
USERS_SID = "S-1-5-32-545"
OWNER_RIGHTS_SID = "S-1-3-4"
TRUSTED_INSTALLER_SID = "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464"
GATE_SERVICE_NAME = "AgentSwitchGate"

# Access masks (winnt.h).
FILE_READ_DATA = 0x0001
FILE_WRITE_DATA = 0x0002
FILE_APPEND_DATA = 0x0004
FILE_WRITE_EA = 0x0010
FILE_WRITE_ATTRIBUTES = 0x0100
DELETE = 0x0001_0000
WRITE_DAC = 0x0004_0000
WRITE_OWNER = 0x0008_0000
GENERIC_ALL = 0x1000_0000
GENERIC_WRITE = 0x4000_0000
GENERIC_READ = 0x8000_0000
FILE_ALL_ACCESS = 0x001F_01FF
FILE_MODIFY = 0x0013_01BF          # read, write, execute, delete
FILE_READ_EXECUTE = 0x0012_00A9    # read and execute (list a directory)
RIGHTS = {"full": FILE_ALL_ACCESS, "modify": FILE_MODIFY, "read": FILE_READ_EXECUTE}

READS = FILE_READ_DATA | GENERIC_READ | GENERIC_ALL | WRITE_DAC | WRITE_OWNER
WRITES = (FILE_WRITE_DATA | FILE_APPEND_DATA | FILE_WRITE_EA | FILE_WRITE_ATTRIBUTES | DELETE | GENERIC_WRITE
          | GENERIC_ALL | WRITE_DAC | WRITE_OWNER)

ACCESS_ALLOWED = "allow"
ACCESS_DENIED = "deny"


def service_sid(name: str) -> str:
    """The SID of `NT SERVICE\\<name>`: S-1-5-80 and the SHA-1 of the upper-cased name in UTF-16LE as five
    little-endian 32-bit numbers. It is the service's virtual account, the same on every machine and known before the
    service exists (TrustedInstaller's is the textbook example)."""
    digest = hashlib.sha1(name.upper().encode("utf-16-le")).digest()
    return "S-1-5-80-" + "-".join(str(n) for n in struct.unpack("<5I", digest))


GATE_SERVICE_SID = service_sid(GATE_SERVICE_NAME)


@dataclass(frozen=True)
class Ace:
    kind: str            # ACCESS_ALLOWED | ACCESS_DENIED | anything else (ignored)
    sid: str
    mask: int
    inherit_only: bool = False


def acl_problem(aces: Iterable[Ace] | None, trusted: Iterable[str], *, write: bool = False,
                owner: str | None = None) -> str | None:
    """Why a DACL lets someone untrusted read (`write`: change) the object, or None. `aces` None is a NULL DACL.

    An entry for OWNER RIGHTS (S-1-3-4) grants whoever owns the object, so it counts as an entry for `owner` (None:
    unknown, untrusted). Windows puts one in the ACL of a user's temporary directory, so everything created there
    carries it."""
    if aces is None:
        return "no access control list (everyone has access)"
    wanted = WRITES if write else READS
    allowed = frozenset(trusted)
    for ace in aces:
        if ace.kind != ACCESS_ALLOWED or ace.inherit_only or not ace.mask & wanted:
            continue
        if ace.sid == OWNER_RIGHTS_SID and owner in allowed:
            continue
        if ace.sid not in allowed:
            return f"{'writable' if write else 'readable'} by {ace.sid}"
    return None


def trusted_sids(user: str | None = None) -> frozenset[str]:
    return frozenset({user or current_user_sid(), SYSTEM_SID, ADMINISTRATORS_SID, TRUSTED_INSTALLER_SID,
                      GATE_SERVICE_SID})


# -- Windows (pywin32) ---------------------------------------------------------------------------

def current_user_sid() -> str:
    """The user SID of this process's token (Windows)."""
    import win32api
    import win32security

    token = win32security.OpenProcessToken(win32api.GetCurrentProcess(), win32security.TOKEN_QUERY)
    try:
        sid, _attributes = win32security.GetTokenInformation(token, win32security.TokenUser)
    finally:
        token.Close()
    return win32security.ConvertSidToStringSid(sid)


def _sid(text: str):  # noqa: ANN202 - a PySID
    import win32security

    return win32security.ConvertStringSidToSid(text)


def read_acl(path: Path) -> tuple[list[Ace] | None, str | None]:
    """(entries of the DACL, None for a NULL DACL; owner SID) of a file or directory, not following a link."""
    import win32security

    info = win32security.DACL_SECURITY_INFORMATION | win32security.OWNER_SECURITY_INFORMATION
    sd = win32security.GetNamedSecurityInfo(str(path), win32security.SE_FILE_OBJECT, info)
    owner = sd.GetSecurityDescriptorOwner()
    dacl = sd.GetSecurityDescriptorDacl()
    owner_text = win32security.ConvertSidToStringSid(owner) if owner is not None else None
    if dacl is None:
        return None, owner_text
    aces: list[Ace] = []
    for index in range(dacl.GetAceCount()):
        ace = dacl.GetAce(index)
        (ace_type, flags), mask = ace[0], ace[1]
        sid = ace[-1]
        kind = {win32security.ACCESS_ALLOWED_ACE_TYPE: ACCESS_ALLOWED,
                win32security.ACCESS_DENIED_ACE_TYPE: ACCESS_DENIED}.get(ace_type, "other")
        try:
            sid_text = win32security.ConvertSidToStringSid(sid)
        except Exception:  # noqa: BLE001 - an object ACE: not one of the two kinds above anyway
            sid_text = "?"
        aces.append(Ace(kind, sid_text, mask, bool(flags & win32security.INHERIT_ONLY_ACE)))
    return aces, owner_text


def owner_sid(path: Path) -> str | None:
    return read_acl(path)[1]


def set_acl(path: Path, grants: Iterable[tuple[str, str]], owner: str | None = None, *,
            reset_children: bool = False) -> None:
    """Replace the DACL of `path` with exactly `grants` ((SID, "full"|"modify"|"read") pairs), protected from
    inheritance; inheritable to children when `path` is a directory. `owner`: set it too (Administrators, from an
    elevated process). `reset_children`: every entry below drops its own entries and inherits from `path` only
    (links and junctions are not followed)."""
    import win32security

    directory = path.is_dir()
    flags = (win32security.OBJECT_INHERIT_ACE | win32security.CONTAINER_INHERIT_ACE) if directory else 0
    dacl = win32security.ACL()
    for sid, rights in grants:
        dacl.AddAccessAllowedAceEx(win32security.ACL_REVISION, flags, RIGHTS[rights], _sid(sid))
    info = win32security.DACL_SECURITY_INFORMATION | win32security.PROTECTED_DACL_SECURITY_INFORMATION
    owner_obj = None
    if owner is not None:
        info |= win32security.OWNER_SECURITY_INFORMATION
        owner_obj = _sid(owner)
    win32security.SetNamedSecurityInfo(str(path), win32security.SE_FILE_OBJECT, info, owner_obj, None, dacl, None)
    if reset_children and directory:
        for child in _descendants(path):
            _inherit_only(child)


def _descendants(top: Path) -> list[Path]:
    out: list[Path] = []
    for dirpath, dirnames, filenames in os.walk(top, followlinks=False):
        keep = []
        for name in dirnames:
            child = Path(dirpath) / name
            out.append(child)
            if not is_link(child):
                keep.append(name)
        dirnames[:] = keep
        out.extend(Path(dirpath) / name for name in filenames)
    return out


def _inherit_only(path: Path) -> None:
    import win32security

    info = win32security.DACL_SECURITY_INFORMATION | win32security.UNPROTECTED_DACL_SECURITY_INFORMATION
    win32security.SetNamedSecurityInfo(str(path), win32security.SE_FILE_OBJECT, info, None, None,
                                       win32security.ACL(), None)


def is_link(path: Path) -> bool:
    """A symlink, a junction or any other reparse point (Windows), never followed."""
    try:
        info = os.lstat(path)
    except OSError:
        return False
    reparse = getattr(info, "st_file_attributes", 0) & 0x400  # FILE_ATTRIBUTE_REPARSE_POINT
    return bool(reparse) or os.path.islink(path)


def restrict_to_current_user(path: Path) -> None:
    """Windows: only this user, inherited by everything created inside. POSIX: chmod 0700 / 0600."""
    if not IS_WINDOWS:
        os.chmod(path, 0o700 if Path(path).is_dir() else 0o600)
        return
    set_acl(Path(path), ((current_user_sid(), "full"),))


def private_problem(path: Path) -> str | None:
    """Windows: why `path` may be read by someone it should not be (None: only trusted accounts)."""
    aces, owner = read_acl(path)
    return acl_problem(aces, trusted_sids(), owner=owner)


def write_problem(path: Path) -> str | None:
    """Windows: why `path` may be changed by someone it should not be."""
    aces, owner = read_acl(path)
    return acl_problem(aces, trusted_sids(), write=True, owner=owner)


def windows_dir() -> str:
    """The Windows directory from the system (GetWindowsDirectoryW), not from %SystemRoot%."""
    if not IS_WINDOWS:
        return "C:\\Windows"
    import ctypes

    buffer = ctypes.create_unicode_buffer(260)
    length = ctypes.windll.kernel32.GetWindowsDirectoryW(buffer, len(buffer))  # type: ignore[attr-defined]
    return buffer.value if 0 < length < len(buffer) else "C:\\Windows"


def known_folder(name: str, fallback: str) -> str:
    """ProgramData or Program Files from the shell (SHGetKnownFolderPath), never from an environment variable that the
    user who starts an elevated command could have pointed at a directory they own."""
    if not IS_WINDOWS:
        return fallback
    import ctypes
    import uuid
    from ctypes import wintypes

    ids = {"ProgramData": "62AB5D82-FDC1-4DC3-A9DD-070D1D495D97", "ProgramFiles": "905E63B6-C1BF-494E-B29C-65B732D3D21A"}

    class GUID(ctypes.Structure):
        _fields_ = [("data", ctypes.c_ubyte * 16)]

    guid = GUID()
    ctypes.memmove(ctypes.byref(guid), uuid.UUID(ids[name]).bytes_le, 16)
    out = wintypes.LPWSTR()
    shell32 = ctypes.windll.shell32  # type: ignore[attr-defined]
    if shell32.SHGetKnownFolderPath(ctypes.byref(guid), 0, None, ctypes.byref(out)) != 0:
        return fallback
    try:
        return out.value or fallback
    finally:
        ctypes.windll.ole32.CoTaskMemFree(out)  # type: ignore[attr-defined]


def process_alive(pid: int) -> bool:
    """Windows: whether `pid` is a running process (os.kill(pid, 0) would *terminate* it there)."""
    import ctypes
    from ctypes import wintypes

    kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)  # type: ignore[attr-defined]
    kernel32.OpenProcess.restype = wintypes.HANDLE
    kernel32.OpenProcess.argtypes = (wintypes.DWORD, wintypes.BOOL, wintypes.DWORD)
    kernel32.GetExitCodeProcess.argtypes = (wintypes.HANDLE, ctypes.POINTER(wintypes.DWORD))
    kernel32.CloseHandle.argtypes = (wintypes.HANDLE,)
    handle = kernel32.OpenProcess(0x1000, False, pid)  # PROCESS_QUERY_LIMITED_INFORMATION
    if not handle:
        return False
    try:
        code = wintypes.DWORD()
        if not kernel32.GetExitCodeProcess(handle, ctypes.byref(code)):
            return False
        return code.value == 259  # STILL_ACTIVE
    finally:
        kernel32.CloseHandle(handle)


def is_admin() -> bool:
    """Windows: an elevated administrator (what root is to `secret-gate system install`)."""
    import ctypes

    try:
        return bool(ctypes.windll.shell32.IsUserAnAdmin())  # type: ignore[attr-defined]
    except (AttributeError, OSError):
        return False
