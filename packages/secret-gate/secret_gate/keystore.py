"""Key material on disk: the gate's one keypair (keyring.py). Private key is 0600; anything looser is refused.

On Windows the same rule is an ACL (fsacl.py): the gate home is made readable by this user only (a protected DACL that
everything inside inherits), and a private key that anyone else may read is refused.
"""

from __future__ import annotations

import os
import stat
from pathlib import Path

from . import fsacl
from .constants import DEFAULT_HOME, HOME_ENV_VAR, PRIVATE_KEY_FILE, PUBLIC_KEY_FILE
from .crypto import KEY_BYTES, KeyPair, b64url_decode, b64url_encode
from .errors import KeyStoreError, TokenError


def gate_home() -> Path:
    override = os.environ.get(HOME_ENV_VAR)
    return Path(override).expanduser() if override else DEFAULT_HOME


def make_private_dirs(path: Path) -> None:
    """Create `path` and every missing parent with mode 0700 (umask cannot loosen it); tighten `path` itself.

    Windows: each directory created here gets a DACL for this user only; an existing `path` is restricted the same
    way only when someone untrusted may read it (the gate service's home, made by `system install`, keeps its ACL)."""
    missing: list[Path] = []
    probe = path
    while not probe.exists():
        missing.append(probe)
        probe = probe.parent
    for directory in reversed(missing):
        directory.mkdir(mode=0o700, exist_ok=True)
        if fsacl.IS_WINDOWS:
            fsacl.restrict_to_current_user(directory)
        else:
            directory.chmod(0o700)
    if not fsacl.IS_WINDOWS:
        path.chmod(0o700)
    elif not missing and fsacl.private_problem(path):
        fsacl.restrict_to_current_user(path)


def save_keypair(home: Path, pair: KeyPair, *, overwrite: bool = False) -> tuple[Path, Path]:
    """Write key.priv (0600) and key.pub, each through a temp file and a rename, so a reader never sees half a key."""
    make_private_dirs(home)
    priv_path, pub_path = home / PRIVATE_KEY_FILE, home / PUBLIC_KEY_FILE
    if priv_path.exists() and not overwrite:
        raise KeyStoreError(f"refusing to overwrite existing private key at {priv_path}")
    _write_new(priv_path, b64url_encode(pair.private) + "\n", 0o600)
    _write_new(pub_path, b64url_encode(pair.public) + "\n", 0o644)
    return priv_path, pub_path


def _write_new(path: Path, text: str, mode: int) -> None:
    tmp = path.with_name(f".{path.name}.{os.getpid()}")
    tmp.unlink(missing_ok=True)
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | getattr(os, "O_NOFOLLOW", 0), mode)
    try:
        with os.fdopen(fd, "w") as fh:
            fh.write(text)
        os.chmod(tmp, mode)
        os.replace(tmp, path)
    except BaseException:
        tmp.unlink(missing_ok=True)
        raise


def _read_key(path: Path, name: str) -> bytes:
    try:
        if not path.exists():
            raise KeyStoreError(f"{name} key not found at {path}; run `secret-gate keygen`")
        raw = b64url_decode(path.read_text().strip())
    except TokenError as exc:
        raise KeyStoreError(f"{name} key at {path} is corrupt") from exc
    except OSError as exc:
        raise KeyStoreError(f"无法读取 {path}：{exc.strerror or exc}") from None
    if len(raw) != KEY_BYTES:
        raise KeyStoreError(f"{name} key at {path} has wrong length")
    return raw


def load_private_key(home: Path) -> bytes:
    return _load_private_from_dir(Path(home))


def _load_private_from_dir(home: Path) -> bytes:
    path = home / PRIVATE_KEY_FILE
    try:
        info = path.stat() if path.exists() else None
    except OSError as exc:
        raise KeyStoreError(f"无法读取 {path}：{exc.strerror or exc}") from None
    if info is not None and fsacl.IS_WINDOWS:
        try:
            problem = fsacl.private_problem(path)
        except Exception as exc:  # noqa: BLE001 - pywintypes.error: an ACL that cannot be read is not trusted
            problem = f"its access control list cannot be read ({exc})"
        if problem:
            raise KeyStoreError(f"private key {path} is not private ({problem}); keep it in the gate home "
                                f"(secret-gate keygen makes that readable by you only)")
    elif info is not None:
        mode = stat.S_IMODE(info.st_mode)
        if mode & 0o077:
            raise KeyStoreError(f"private key {path} is readable by others (mode {mode:o}); chmod 600")
    return _read_key(path, "private")


def load_public_key(home: Path) -> bytes:
    return _read_key(Path(home) / PUBLIC_KEY_FILE, "public")


def parse_public_key(text: str) -> bytes:
    try:
        raw = b64url_decode(text.strip())
    except TokenError as exc:
        raise KeyStoreError("public key is not valid base64url") from exc
    if len(raw) != KEY_BYTES:
        raise KeyStoreError("public key has wrong length")
    return raw
