"""Key material on disk. Private key is 0600; anything looser is refused."""

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


def save_keypair(home: Path, pair: KeyPair, *, overwrite: bool = False) -> tuple[Path, Path]:
    home.mkdir(parents=True, exist_ok=True)
    home.chmod(0o700)
    priv_path, pub_path = home / PRIVATE_KEY_FILE, home / PUBLIC_KEY_FILE
    if priv_path.exists() and not overwrite:
        raise KeyStoreError(f"refusing to overwrite existing private key at {priv_path}")
    fd = os.open(priv_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    with os.fdopen(fd, "w") as fh:
        fh.write(b64url_encode(pair.private) + "\n")
    priv_path.chmod(0o600)
    pub_path.write_text(b64url_encode(pair.public) + "\n")
    return priv_path, pub_path


def _read_key(path: Path, name: str) -> bytes:
    if not path.exists():
        raise KeyStoreError(f"{name} key not found at {path}; run `secret-gate keygen`")
    try:
        raw = b64url_decode(path.read_text().strip())
    except TokenError as exc:
        raise KeyStoreError(f"{name} key at {path} is corrupt") from exc
    if len(raw) != KEY_BYTES:
        raise KeyStoreError(f"{name} key at {path} has wrong length")
    return raw


def _resolve_dir(home: Path) -> Path:
    """`home` may be a gate home (with named keypairs) or a keypair directory itself."""
    from .keyring import CURRENT_FILE, KEYS_DIR, key_dir

    if (home / CURRENT_FILE).exists() or (home / KEYS_DIR).is_dir():
        return key_dir(home)
    return home


def load_all_private_keys(home: Path) -> tuple[bytes, ...]:
    """Every private key under a gate home, current first (empty tuple if none)."""
    from .keyring import all_key_dirs

    seen: list[bytes] = []
    for d in all_key_dirs(home):
        key = _load_private_from_dir(d)
        if key not in seen:
            seen.append(key)
    return tuple(seen)


def load_private_key(home: Path) -> bytes:
    return _load_private_from_dir(_resolve_dir(home))


def _load_private_from_dir(home: Path) -> bytes:
    path = home / PRIVATE_KEY_FILE
    if path.exists():
        mode = stat.S_IMODE(path.stat().st_mode)
        if mode & 0o077:
            raise KeyStoreError(f"private key {path} is readable by others (mode {mode:o}); chmod 600")
    return _read_key(path, "private")


def load_public_key(home: Path) -> bytes:
    return _read_key(_resolve_dir(home) / PUBLIC_KEY_FILE, "public")


def parse_public_key(text: str) -> bytes:
    try:
        raw = b64url_decode(text.strip())
    except TokenError as exc:
        raise KeyStoreError("public key is not valid base64url") from exc
    if len(raw) != KEY_BYTES:
        raise KeyStoreError("public key has wrong length")
    return raw
