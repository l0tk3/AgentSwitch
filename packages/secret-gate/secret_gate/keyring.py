"""Named keypairs under SECRET_GATE_HOME.

Layout:
    <home>/keys/<name>/key.priv, key.pub          one directory per keypair
    <home>/keys/legacy/<name>/key.priv, key.pub   legacy keypairs: decrypt only (gate-service-v0 §5)
    <home>/current                                name of the keypair new tokens are made for
    <home>/key.priv, key.pub                      single keypair of old homes, reported as "default"

Only the *current* keypair is used to mint tokens; the gate decrypts with every keypair it holds, so switching
never invalidates tokens made earlier. A legacy keypair was moved in from a home the login user could read: it
keeps opening old tokens but can never become current again, and `retire_keypair` deletes it on request.
"""

from __future__ import annotations

import re
import shutil
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from .constants import PRIVATE_KEY_FILE, PUBLIC_KEY_FILE
from .crypto import b64url_encode, generate_keypair
from .errors import KeyStoreError

KEYS_DIR = "keys"
LEGACY_DIR = "legacy"
CURRENT_FILE = "current"
LEGACY_NAME = "default"
NAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$")
RESERVED_NAMES = frozenset({KEYS_DIR, CURRENT_FILE, LEGACY_DIR})


@dataclass(frozen=True)
class KeypairInfo:
    name: str
    public: str  # base64url
    current: bool
    path: Path
    legacy: bool = False
    created_at: str = ""  # ISO 8601 UTC, from the key file's modification time


def validate_name(name: str) -> str:
    if not isinstance(name, str) or not NAME_PATTERN.fullmatch(name) or name in RESERVED_NAMES:
        raise KeyStoreError(f"invalid keypair name {name!r}: letters, digits, . _ - only, max 32")
    return name


def _unreadable(path: Path, exc: OSError) -> KeyStoreError:
    return KeyStoreError(f"无法读取 {path}：{exc.strerror or exc}")


def _has_key(directory: Path) -> bool:
    try:
        return (directory / PRIVATE_KEY_FILE).exists()
    except OSError as exc:  # PermissionError on a directory this user may not enter
        raise _unreadable(directory, exc) from None


def _scan(parent: Path) -> dict[str, Path]:
    """Subdirectories of `parent` that hold a private key, by name."""
    try:
        if not parent.is_dir():
            return {}
        entries = sorted(parent.iterdir())
    except OSError as exc:
        raise _unreadable(parent, exc) from None
    return {p.name: p for p in entries if _has_key(p)}


def _named_dirs(home: Path) -> dict[str, Path]:
    return _scan(home / KEYS_DIR)


def _legacy_dirs(home: Path) -> dict[str, Path]:
    return _scan(home / KEYS_DIR / LEGACY_DIR)


def _active_dirs(home: Path) -> dict[str, Path]:
    """Keypairs that may be current: named ones, plus the single keypair of an old home as "default"."""
    dirs = _named_dirs(home)
    if LEGACY_NAME not in dirs and _has_key(home):
        dirs[LEGACY_NAME] = home
    return dirs


def current_name(home: Path) -> str | None:
    marker = home / CURRENT_FILE
    dirs = _active_dirs(home)
    try:
        if marker.exists():
            name = marker.read_text().strip()
            return name if name in dirs else None
    except OSError as exc:
        raise _unreadable(marker, exc) from None
    if LEGACY_NAME in dirs:
        return LEGACY_NAME
    return None


def key_dir(home: Path) -> Path:
    """Directory holding the current keypair; raises when there is none."""
    name = current_name(home)
    if name is None:
        raise KeyStoreError(f"no keypair in {home}; run `secret-gate keygen`")
    return _active_dirs(home)[name]


def _created_at(path: Path) -> str:
    for candidate in (path / PUBLIC_KEY_FILE, path / PRIVATE_KEY_FILE):
        try:
            mtime = candidate.stat().st_mtime
        except OSError:
            continue
        return datetime.fromtimestamp(mtime, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    return ""


def _public_text(path: Path) -> str:
    pub = path / PUBLIC_KEY_FILE
    try:
        return pub.read_text().strip() if pub.exists() else ""
    except OSError as exc:
        raise _unreadable(pub, exc) from None


def _info(name: str, path: Path, *, current: bool, legacy: bool) -> KeypairInfo:
    return KeypairInfo(name=name, public=_public_text(path), current=current, path=path, legacy=legacy,
                       created_at=_created_at(path))


def list_keypairs(home: Path) -> tuple[KeypairInfo, ...]:
    """Keypairs that may be current (sorted by name), then legacy ones (sorted by name)."""
    cur = current_name(home)
    active = [_info(n, p, current=(n == cur), legacy=False) for n, p in sorted(_active_dirs(home).items())]
    legacy = [_info(n, p, current=False, legacy=True) for n, p in sorted(_legacy_dirs(home).items())]
    return tuple(active + legacy)


def _taken(home: Path) -> set[str]:
    return set(_active_dirs(home)) | set(_legacy_dirs(home))


def create_keypair(home: Path, name: str) -> KeypairInfo:
    """Generate a new named keypair. It becomes current only if nothing was current before."""
    from .keystore import save_keypair  # local import: keystore imports this module

    validate_name(name)
    if name in _taken(home):
        raise KeyStoreError(f"keypair {name!r} already exists")
    target = home / KEYS_DIR / name
    pair = generate_keypair()
    save_keypair(target, pair)
    if current_name(home) is None:
        set_current(home, name)
    return KeypairInfo(name=name, public=b64url_encode(pair.public), current=(current_name(home) == name), path=target,
                       created_at=_created_at(target))


def set_current(home: Path, name: str) -> None:
    if name not in _active_dirs(home):
        if name in _legacy_dirs(home):
            raise KeyStoreError(f"密钥 {name} 已停用（仅解密），无法设为当前密钥。")
        raise KeyStoreError(f"no keypair named {name!r}")
    home.mkdir(parents=True, exist_ok=True)
    (home / CURRENT_FILE).write_text(name + "\n")


def retire_keypair(home: Path, name: str) -> None:
    """Delete a legacy keypair: tokens made for it can no longer be opened. The current keypair cannot be retired."""
    if name == current_name(home):
        raise KeyStoreError(f"密钥 {name} 是当前密钥，无法删除。")
    legacy = _legacy_dirs(home)
    if name not in legacy:
        if name in _active_dirs(home):
            raise KeyStoreError(f"密钥 {name} 未停用；仅可删除已停用（仅解密）的密钥。")
        raise KeyStoreError(f"no keypair named {name!r}")
    try:
        shutil.rmtree(legacy[name])
    except OSError as exc:
        raise KeyStoreError(f"无法删除密钥 {name}：{exc.strerror or exc}") from None


def legacy_key_dirs(home: Path) -> tuple[Path, ...]:
    """The moved-in keypairs (decrypt only), sorted by name."""
    return tuple(p for _, p in sorted(_legacy_dirs(home).items()))


def all_key_dirs(home: Path) -> tuple[Path, ...]:
    """Every keypair directory, current first, legacy last."""
    dirs = _active_dirs(home)
    cur = current_name(home)
    ordered = ([dirs[cur]] if cur else []) + [p for n, p in sorted(dirs.items()) if n != cur]
    return tuple(ordered) + tuple(p for _, p in sorted(_legacy_dirs(home).items()))
