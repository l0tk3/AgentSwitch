"""Moving a login user's gate home into the gate service (gate-service-v0 §5), run as root by `system install`.

Two phases, so a failure never loses a private key:

1. `migrate_keys` / `migrate_files` *copy* into the service's gate home and verify each copy (bytes read back, a
   private key must derive its public key). Every old keypair becomes a legacy keypair: decrypt only.
2. `cleanup_user_home` runs only after the service answered with those keys. It deletes an original only when
   an identical copy is in the gate home, then leaves `MOVED.txt`. Files it does not know stay where they are.

The login user's directories are only touched through UserDir (no symlink is ever followed).
"""

from __future__ import annotations

import os
import sqlite3
from dataclasses import dataclass
from pathlib import Path

from nacl.public import PrivateKey

from .constants import EXEC_TEMPLATES_FILE, PRIVATE_KEY_FILE, PUBLIC_KEY_FILE, REFS_FILE
from .crypto import KEY_BYTES, b64url_decode, b64url_encode
from .errors import TokenError, ValidationError
from .keyring import CURRENT_FILE, KEYS_DIR, LEGACY_DIR, LEGACY_NAME, NAME_PATTERN, RESERVED_NAMES, list_keypairs
from .keystore import make_private_dirs
from .upstream_tls import UPSTREAM_INSECURE_FILE
from .user_dir import UserDir

TRUSTED_FILES = (EXEC_TEMPLATES_FILE, UPSTREAM_INSECURE_FILE, "screenshot-mask.json")
TRANSIENT_FILES = ("ca.pem", "proxy.pid", CURRENT_FILE)  # regenerated or meaningless once the service runs
TRANSIENT_DIRS = ("browser-out",)
LOGS_DIR = "logs"
MIGRATED_LOGS = "logs/before-service"
MOVED_FILE = "MOVED.txt"
OLD_CA_KEY_FILES = ("mitmproxy-ca.pem", "mitmproxy-ca.p12")
PRIVATE_FILE_MODE = 0o600


@dataclass(frozen=True)
class OldKey:
    name: str
    private_text: bytes
    public_text: bytes
    where: tuple[str, ...]  # directory relative to the old home: () for the top-level keypair


def _valid_pair(private_text: bytes, public_text: bytes | None) -> bytes | None:
    """The public key text the private key derives, or None when the pair is unusable."""
    try:
        raw = b64url_decode(private_text.decode("ascii").strip())
    except (TokenError, UnicodeDecodeError):
        return None
    if len(raw) != KEY_BYTES:
        return None
    derived = b64url_encode(bytes(PrivateKey(raw).public_key))
    if public_text is not None and public_text.decode("ascii", "replace").strip() != derived:
        return None
    return (derived + "\n").encode()


def _old_pair(directory: UserDir, where: tuple[str, ...], name: str, found: list[OldKey], bad: list[str]) -> None:
    private = directory.read(PRIVATE_KEY_FILE, 4096)
    if private is None:
        return
    public = _valid_pair(private, directory.read(PUBLIC_KEY_FILE, 4096))
    if public is None:
        bad.append("/".join((*where, PRIVATE_KEY_FILE)))
        return
    found.append(OldKey(name=name, private_text=private, public_text=public, where=where))


def find_old_keys(home: UserDir) -> tuple[tuple[OldKey, ...], tuple[str, ...]]:
    """(usable keypairs, paths of unusable private keys) of an old gate home, in a stable order."""
    found: list[OldKey] = []
    bad: list[str] = []
    _old_pair(home, (), LEGACY_NAME, found, bad)
    keys = home.sub(KEYS_DIR)
    if keys is not None:
        with keys:
            for name in keys.names():
                sub = keys.sub(name)
                if sub is None:
                    continue
                with sub:
                    _old_pair(sub, (KEYS_DIR, name), name, found, bad)
                    if name == LEGACY_DIR:
                        for legacy in sub.names():
                            inner = sub.sub(legacy)
                            if inner is not None:
                                with inner:
                                    _old_pair(inner, (KEYS_DIR, LEGACY_DIR, legacy), legacy, found, bad)
    return tuple(found), tuple(bad)


def unique_name(wanted: str, taken: set[str]) -> str:
    base = wanted if NAME_PATTERN.fullmatch(wanted) and wanted not in RESERVED_NAMES else "key"
    if base not in taken:
        return base
    for n in range(2, 1000):
        candidate = f"{base[:28]}-{n}"
        if candidate not in taken:
            return candidate
    raise ValidationError(f"无法为密钥 {wanted} 选定名称")


def _legacy_root(gate: Path) -> Path:
    return gate / KEYS_DIR / LEGACY_DIR


def _existing_copy(gate: Path, private_text: bytes) -> str | None:
    """Name of a legacy keypair in the gate home holding this very private key."""
    legacy = _legacy_root(gate)
    if not legacy.is_dir():
        return None
    for entry in sorted(legacy.iterdir()):
        try:
            if (entry / PRIVATE_KEY_FILE).read_bytes().strip() == private_text.strip():
                return entry.name
        except OSError:
            continue
    return None


def _write_private(path: Path, data: bytes) -> None:
    fd = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL | os.O_NOFOLLOW, PRIVATE_FILE_MODE)
    with os.fdopen(fd, "wb") as fh:
        fh.write(data)
    if path.read_bytes() != data:
        raise ValidationError(f"{path} 写入后校验不一致")


def migrate_keys(source: Path, owner_uid: int, gate: Path) -> tuple[str, ...]:
    """Copy every usable old keypair into `<gate>/keys/legacy/<name>/` (0700/0600) and verify it.

    Returns one line per keypair for the report. Nothing in `source` is changed."""
    with (UserDir.open(source, owner_uid) or _nothing()) as home:
        if home is None:
            return (f"{source} 不存在，无需迁移密钥",)
        keys, bad = find_old_keys(home)
    lines = [f"无法迁移 {source / path}（格式无效或与公钥不符），原文件保留" for path in bad]
    for key in keys:
        done = _existing_copy(gate, key.private_text)
        if done is not None:
            lines.append(f"密钥 {key.name}：已在服务中（legacy/{done}）")
            continue
        name = unique_name(key.name, {k.name for k in list_keypairs(gate)})
        target = _legacy_root(gate) / name
        make_private_dirs(target)
        _write_private(target / PRIVATE_KEY_FILE, key.private_text)
        _write_private(target / PUBLIC_KEY_FILE, key.public_text)
        if _valid_pair(target.joinpath(PRIVATE_KEY_FILE).read_bytes(), target.joinpath(PUBLIC_KEY_FILE).read_bytes()) is None:
            raise ValidationError(f"迁移后的密钥 {name} 校验失败")
        lines.append(f"密钥 {key.name} → legacy/{name}（仅解密）")
    return tuple(lines)


class _nothing:
    """`with (UserDir.open(...) or _nothing()) as d` gives None when the directory is missing."""

    def __enter__(self) -> None:
        return None

    def __exit__(self, *exc: object) -> None:
        return None


def _refs_db_ok(path: Path) -> bool:
    try:
        with sqlite3.connect(f"file:{path}?mode=ro", uri=True) as conn:
            return conn.execute("PRAGMA integrity_check").fetchone() == ("ok",)
    except sqlite3.Error:
        return False


def migrate_files(source: Path, owner_uid: int, gate: Path) -> tuple[str, ...]:
    """Copy the refs registry, the trusted config files and the logs into the gate home (0600), verified."""
    lines: list[str] = []
    with (UserDir.open(source, owner_uid) or _nothing()) as home:
        if home is None:
            return (f"{source} 不存在，无需迁移文件",)
        for name in (REFS_FILE, *TRUSTED_FILES):
            data = home.read(name)
            if data is None:
                continue
            target = gate / name
            if target.exists():
                lines.append(f"{name}：服务目录中已有，保留服务中的版本")
                continue
            staging = gate / f".{name}.migrating"
            staging.unlink(missing_ok=True)
            _write_private(staging, data)
            if name == REFS_FILE and not _refs_db_ok(staging):
                staging.unlink()
                lines.append(f"{name}：已损坏，未迁移（短引用只在任务执行期间有效）")
                continue
            os.replace(staging, target)
            lines.append(f"{name} → {target}")
        lines.extend(_migrate_logs(home, gate))
    return tuple(lines)


def _migrate_logs(home: UserDir, gate: Path) -> list[str]:
    logs = home.sub(LOGS_DIR)
    if logs is None:
        return []
    target = gate / MIGRATED_LOGS
    copied = 0
    with logs:
        for name in logs.names():
            data = logs.read(name)
            if data is None or (target / name).exists():
                continue
            make_private_dirs(target)
            _write_private(target / name, data)
            copied += 1
    return [f"日志 {copied} 个 → {target}"] if copied else []


# -- phase 2: after the service answered ---------------------------------------------------------

def _drop_key(home: UserDir, key: OldKey) -> None:
    directory = home
    opened: list[UserDir] = []
    try:
        for part in key.where:
            nxt = directory.sub(part)
            if nxt is None:
                return
            opened.append(nxt)
            directory = nxt
        directory.unlink(PRIVATE_KEY_FILE)
        directory.unlink(PUBLIC_KEY_FILE)
    finally:
        for d in reversed(opened):
            d.close()


def _prune_key_dirs(home: UserDir) -> None:
    keys = home.sub(KEYS_DIR)
    if keys is None:
        return
    with keys:
        legacy = keys.sub(LEGACY_DIR)
        if legacy is not None:
            with legacy:
                for name in legacy.names():
                    legacy.rmdir(name)
        for name in keys.names():
            keys.rmdir(name)
    home.rmdir(KEYS_DIR)


def _same_file(home: UserDir, name: str, target: Path) -> bool:
    try:
        return home.read(name) == target.read_bytes()
    except OSError:
        return False


def cleanup_user_home(source: Path, owner_uid: int, gate: Path, moved_text: str) -> tuple[str, ...]:
    """Delete originals that have an identical copy in the gate home, then leave MOVED.txt."""
    with (UserDir.open(source, owner_uid) or _nothing()) as home:
        if home is None:
            return ()
        keys, _bad = find_old_keys(home)
        kept: list[str] = []
        for key in keys:
            if _existing_copy(gate, key.private_text) is None:
                kept.append("/".join((*key.where, PRIVATE_KEY_FILE)))
                continue
            _drop_key(home, key)
        _prune_key_dirs(home)
        home.unlink(REFS_FILE + "-journal")
        home.unlink(REFS_FILE)  # references only live for one execution; the service keeps its own registry
        for name in TRUSTED_FILES:
            if home.kind(name) == "file" and not _same_file(home, name, gate / name):
                kept.append(name)
            else:
                home.unlink(name)
        for name in TRANSIENT_FILES:
            home.unlink(name)
        _clear_dirs(home, gate)
        home.write_new(MOVED_FILE, moved_text.encode())
        left = sorted(set(home.names()) - {MOVED_FILE})
    lines = [f"{source} 中已迁移的原有文件已删除，留下 {MOVED_FILE}"]
    lines += [f"保留 {source / k}：服务目录中无相同的副本" for k in kept]
    holding = {k.split("/", 1)[0] for k in kept}
    lines += [f"保留 {source / n}：未识别的文件" for n in left if n not in holding]
    return tuple(lines)


def _clear_dirs(home: UserDir, gate: Path) -> None:
    for name in TRANSIENT_DIRS:
        sub = home.sub(name)
        if sub is not None:
            with sub:
                for entry in sub.names():
                    if sub.kind(entry) in ("file", "link"):
                        sub.unlink(entry)
            home.rmdir(name)
    logs = home.sub(LOGS_DIR)
    if logs is not None:
        with logs:
            for entry in logs.names():
                if logs.kind(entry) == "file" and _same_file(logs, entry, gate / MIGRATED_LOGS / entry):
                    logs.unlink(entry)
        home.rmdir(LOGS_DIR)


def delete_old_ca_keys(mitmproxy_dir: Path, owner_uid: int) -> tuple[str, ...]:
    """The login user's old mitmproxy CA private key (`mitmproxy-ca.pem`, `.p12`); certificates stay."""
    with (UserDir.open(mitmproxy_dir, owner_uid) or _nothing()) as directory:
        if directory is None:
            return ()
        removed = [name for name in OLD_CA_KEY_FILES if directory.unlink(name)]
    return tuple(f"已删除旧 CA 私钥 {mitmproxy_dir / name}" for name in removed)


def remove_user_file(path: Path, owner_uid: int) -> bool:
    """Unlink one file in a directory of the login user (e.g. the old LaunchAgent plist), never following links."""
    parts = Path(path).parts
    with (UserDir.open(Path(*parts[:-1]), owner_uid) or _nothing()) as parent:
        return parent is not None and parent.unlink(parts[-1])


def user_file_exists(path: Path) -> bool:
    return os.path.lexists(path)
