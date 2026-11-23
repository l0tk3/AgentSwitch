"""The gate's one keypair (gate-simple-v0 §1).

Layout:
    <home>/key.priv   private key, 0600 (base64url)
    <home>/key.pub    public key (base64url)

There is exactly one keypair, and it is reported as KEY_NAME. Replacing it (`secret-gate keygen --force` without the
service, `secret-gate system rotate-key` with it) makes every token sealed to the old one unusable: there is no
second, decrypt-only key any more. Directories of the former multi-key layout (`keys/`, `current`) are ignored.
"""

from __future__ import annotations

import re
from dataclasses import dataclass
from datetime import UTC, datetime
from pathlib import Path

from .constants import PRIVATE_KEY_FILE, PUBLIC_KEY_FILE
from .crypto import b64url_encode, generate_keypair
from .errors import KeyStoreError

KEY_NAME = "main"
NAME_PATTERN = re.compile(r"^[A-Za-z0-9][A-Za-z0-9._-]{0,31}$")


@dataclass(frozen=True)
class KeypairInfo:
    name: str
    public: str  # base64url
    path: Path
    created_at: str = ""  # ISO 8601 UTC, from the key file's modification time


def _unreadable(path: Path, exc: OSError) -> KeyStoreError:
    return KeyStoreError(f"无法读取 {path}：{exc.strerror or exc}")


def has_keypair(home: Path) -> bool:
    path = Path(home) / PRIVATE_KEY_FILE
    try:
        return path.exists()
    except OSError as exc:  # PermissionError on a directory this user may not enter
        raise _unreadable(path, exc) from None


def _created_at(home: Path) -> str:
    for candidate in (home / PUBLIC_KEY_FILE, home / PRIVATE_KEY_FILE):
        try:
            mtime = candidate.stat().st_mtime
        except OSError:
            continue
        return datetime.fromtimestamp(mtime, UTC).strftime("%Y-%m-%dT%H:%M:%SZ")
    return ""


def keypair_info(home: Path) -> KeypairInfo | None:
    """The keypair of `home`, or None when there is none."""
    home = Path(home)
    if not has_keypair(home):
        return None
    pub = home / PUBLIC_KEY_FILE
    try:
        public = pub.read_text().strip() if pub.exists() else ""
    except OSError as exc:
        raise _unreadable(pub, exc) from None
    return KeypairInfo(name=KEY_NAME, public=public, path=home, created_at=_created_at(home))


def create_keypair(home: Path, *, replace: bool = False) -> KeypairInfo:
    """Generate the keypair. Refuses when one exists unless `replace`: then the old one is gone for good."""
    from .keystore import save_keypair  # local import: keystore imports this module

    home = Path(home)
    if has_keypair(home) and not replace:
        raise KeyStoreError(f"{home} 中已有密钥；替换会使已有密文全部失效（secret-gate keygen --force）")
    pair = generate_keypair()
    save_keypair(home, pair, overwrite=replace)
    return KeypairInfo(name=KEY_NAME, public=b64url_encode(pair.public), path=home, created_at=_created_at(home))
