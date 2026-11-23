"""Key material on disk: the gate's one keypair (keyring.py). Private key is 0600; anything looser is refused."""

from __future__ import annotations

import os
import stat
from pathlib import Path

from .constants import DEFAULT_HOME, HOME_ENV_VAR, PRIVATE_KEY_FILE, PUBLIC_KEY_FILE
from .crypto import KEY_BYTES, KeyPair, b64url_decode, b64url_encode
from .errors import KeyStoreError, TokenError


def gate_home() -> Path:
    override = os.environ.get(HOME_ENV_VAR)
    return Path(override).expanduser() if override else DEFAULT_HOME


def make_private_dirs(path: Path) -> None:
    """Create `path` and every missing parent with mode 0700 (umask cannot loosen it); tighten `path` itself."""
    missing: list[Path] = []
    probe = path
    while not probe.exists():
        missing.append(probe)
        probe = probe.parent
    for directory in reversed(missing):
        directory.mkdir(mode=0o700, exist_ok=True)
        directory.chmod(0o700)
    path.chmod(0o700)


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
    fd = os.open(tmp, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, mode)
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
    if info is not None:
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
