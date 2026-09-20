"""Named keypairs under SECRET_GATE_HOME.

Layout:
    <home>/keys/<name>/key.priv, key.pub     one directory per keypair
    <home>/current                           name of the keypair new tokens are made for
    <home>/key.priv, key.pub                 legacy single keypair, reported as "default"

Only the *current* keypair is used to mint tokens; the gate decrypts with every keypair it
holds, so switching never invalidates tokens made earlier.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from pathlib import Path

from .constants import PRIVATE_KEY_FILE, PUBLIC_KEY_FILE
from .crypto import b64url_encode, generate_keypair
from .errors import KeyStoreError

KEYS_DIR = "keys"
CURRENT_FILE = "current"
LEGACY_NAME = "default"
NAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$")
RESERVED_NAMES = frozenset({KEYS_DIR, CURRENT_FILE})


@dataclass(frozen=True)
class KeypairInfo:
    name: str
    public: str  # base64url
    current: bool
    path: Path


def validate_name(name: str) -> str:
    if not isinstance(name, str) or not NAME_PATTERN.match(name) or name in RESERVED_NAMES:
        raise KeyStoreError(f"invalid keypair name {name!r}: letters, digits, . _ - only, max 32")
    return name


def _legacy_dir(home: Path) -> Path | None:
    return home if (home / PRIVATE_KEY_FILE).exists() else None


def _named_dirs(home: Path) -> dict[str, Path]:
    keys = home / KEYS_DIR
    if not keys.is_dir():
        return {}
    return {p.name: p for p in sorted(keys.iterdir()) if (p / PRIVATE_KEY_FILE).exists()}


def _all_dirs(home: Path) -> dict[str, Path]:
    dirs = _named_dirs(home)
    legacy = _legacy_dir(home)
    if legacy is not None and LEGACY_NAME not in dirs:
        dirs[LEGACY_NAME] = legacy
    return dirs


def current_name(home: Path) -> str | None:
    marker = home / CURRENT_FILE
    dirs = _all_dirs(home)
    if marker.exists():
        name = marker.read_text().strip()
        return name if name in dirs else None
    if LEGACY_NAME in dirs:
        return LEGACY_NAME
    return None


def key_dir(home: Path) -> Path:
    """Directory holding the current keypair; raises when there is none."""
    name = current_name(home)
    if name is None:
        raise KeyStoreError(f"no keypair in {home}; run `secret-gate keygen`")
    return _all_dirs(home)[name]


def list_keypairs(home: Path) -> tuple[KeypairInfo, ...]:
    cur = current_name(home)
    out = []
    for name, path in sorted(_all_dirs(home).items()):
        pub = (path / PUBLIC_KEY_FILE).read_text().strip() if (path / PUBLIC_KEY_FILE).exists() else ""
        out.append(KeypairInfo(name=name, public=pub, current=(name == cur), path=path))
    return tuple(out)


def create_keypair(home: Path, name: str) -> KeypairInfo:
    """Generate a new named keypair. It becomes current only if nothing was current before."""
    from .keystore import save_keypair  # local import: keystore imports this module

    validate_name(name)
    if name in _all_dirs(home):
        raise KeyStoreError(f"keypair {name!r} already exists")
    target = home / KEYS_DIR / name
    pair = generate_keypair()
    save_keypair(target, pair)
    if current_name(home) is None:
        set_current(home, name)
    return KeypairInfo(name=name, public=b64url_encode(pair.public), current=(current_name(home) == name), path=target)


def set_current(home: Path, name: str) -> None:
    if name not in _all_dirs(home):
        raise KeyStoreError(f"no keypair named {name!r}")
    home.mkdir(parents=True, exist_ok=True)
    (home / CURRENT_FILE).write_text(name + "\n")


def all_key_dirs(home: Path) -> tuple[Path, ...]:
    """Every keypair directory, current first."""
    dirs = _all_dirs(home)
    cur = current_name(home)
    ordered = ([dirs[cur]] if cur else []) + [p for n, p in sorted(dirs.items()) if n != cur]
    return tuple(ordered)
