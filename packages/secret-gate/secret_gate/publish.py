"""The gate service's public files (gate-service-v0 §3.3): `keys.json` and `ca.pem` in `<root>/gate-public/`.

The service writes them (atomically: temp file + rename, mode 0644) at start and after every key change; the
login user's CLI, the daemon and the apps only read them. Nothing here ever holds a private key: `keys.json`
lists public keys, `ca.pem` is the mitmproxy CA certificate without its key.
"""

from __future__ import annotations

import json
import os
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from .crypto import KEY_BYTES, b64url_decode
from .errors import KeyStoreError, TokenError
from .keyring import LEGACY_NAME, NAME_PATTERN, list_keypairs
from .service_paths import CA_PEM, KEYS_JSON

PUBLIC_FILE_MODE = 0o644
MITMPROXY_CA_CERT = "mitmproxy-ca-cert.pem"
MAX_KEYS_JSON_BYTES = 1 << 20
_ROW_KEYS = frozenset({"name", "publicKey", "current", "legacy", "createdAt"})


@dataclass(frozen=True)
class KeyRow:
    name: str
    public_key: str
    current: bool
    legacy: bool
    created_at: str

    def to_json(self) -> dict[str, Any]:
        return {"name": self.name, "publicKey": self.public_key, "current": self.current, "legacy": self.legacy,
                "createdAt": self.created_at}

    def cli_json(self) -> dict[str, Any]:
        """The row as `secret-gate keys --json` has always printed it (plus `legacy`)."""
        return {"name": self.name, "public": self.public_key, "current": self.current, "legacy": self.legacy}


def key_rows(home: Path) -> tuple[KeyRow, ...]:
    return tuple(KeyRow(name=k.name, public_key=k.public, current=k.current, legacy=k.legacy, created_at=k.created_at)
                 for k in list_keypairs(home))


def write_public(path: Path, data: bytes) -> None:
    """Temp file in the same directory, then rename: a reader sees the old file or the new one, never half."""
    fd, tmp = tempfile.mkstemp(dir=path.parent, prefix=f".{path.name}.")
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(data)
        os.chmod(tmp, PUBLIC_FILE_MODE)
        os.replace(tmp, path)
    except BaseException:
        Path(tmp).unlink(missing_ok=True)
        raise


def publish_keys(home: Path, public: Path) -> tuple[KeyRow, ...]:
    rows = key_rows(home)
    write_public(public / KEYS_JSON, (json.dumps([r.to_json() for r in rows], indent=1) + "\n").encode())
    return rows


def publish_ca(confdir: Path, public: Path) -> bool:
    """Copy the proxy's CA certificate (never `mitmproxy-ca.pem`, which holds the key) to `<public>/ca.pem`."""
    source = Path(confdir) / MITMPROXY_CA_CERT
    try:
        data = source.read_bytes()
    except FileNotFoundError:
        return False
    if b"PRIVATE KEY" in data or b"-----BEGIN CERTIFICATE-----" not in data:
        raise KeyStoreError(f"{source} 不是证书文件，未发布")
    target = public / CA_PEM
    try:
        if target.read_bytes() == data:
            return True
    except OSError:
        pass
    write_public(target, data)
    return True


# -- client side ---------------------------------------------------------------------------------

def parse_rows(data: object) -> tuple[KeyRow, ...]:
    """Validate keys.json as untrusted input."""
    if not isinstance(data, list):
        raise KeyStoreError("keys.json 格式无效")
    rows: list[KeyRow] = []
    for item in data:
        if not isinstance(item, dict) or set(item) != _ROW_KEYS:
            raise KeyStoreError("keys.json 格式无效")
        name, public = item["name"], item["publicKey"]
        if not isinstance(name, str) or not (NAME_PATTERN.fullmatch(name) or name == LEGACY_NAME):
            raise KeyStoreError("keys.json 格式无效：密钥名称")
        if not isinstance(public, str) or not _valid_public(public):
            raise KeyStoreError(f"keys.json 格式无效：密钥 {name} 的公钥")
        if not all(isinstance(item[k], bool) for k in ("current", "legacy")) or not isinstance(item["createdAt"], str):
            raise KeyStoreError("keys.json 格式无效")
        rows.append(KeyRow(name=name, public_key=public, current=item["current"], legacy=item["legacy"],
                           created_at=item["createdAt"]))
    if sum(r.current for r in rows) > 1 or any(r.current and r.legacy for r in rows):
        raise KeyStoreError("keys.json 格式无效：当前密钥")
    return tuple(rows)


def _valid_public(text: str) -> bool:
    try:
        return len(b64url_decode(text)) == KEY_BYTES
    except TokenError:
        return False


def read_rows(public: Path) -> tuple[KeyRow, ...]:
    path = Path(public) / KEYS_JSON
    try:
        raw = path.read_bytes()[:MAX_KEYS_JSON_BYTES + 1]
    except FileNotFoundError:
        raise KeyStoreError(f"未找到 {path}；凭据网关服务可能未运行") from None
    except OSError as exc:
        raise KeyStoreError(f"无法读取 {path}：{exc.strerror or exc}") from None
    if len(raw) > MAX_KEYS_JSON_BYTES:
        raise KeyStoreError("keys.json 过大")
    try:
        data = json.loads(raw)
    except ValueError:
        raise KeyStoreError("keys.json 不是有效的 JSON") from None
    return parse_rows(data)


def current_public_key(rows: tuple[KeyRow, ...]) -> bytes:
    for row in rows:
        if row.current:
            return b64url_decode(row.public_key)
    raise KeyStoreError("凭据网关服务无当前密钥；请在 Mac 应用的「密钥」页新建或切换密钥。")
