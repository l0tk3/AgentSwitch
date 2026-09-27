"""Legacy keypairs (gate-service-v0 §5): decrypt only, never current, deletable; plus the keystore fixes."""

from __future__ import annotations

import os
import stat

import pytest

from secret_gate.cli import main
from secret_gate.constants import USE_HTTP
from secret_gate.crypto import b64url_encode, generate_keypair
from secret_gate.errors import KeyStoreError
from secret_gate.keyring import (
    all_key_dirs,
    create_keypair,
    current_name,
    list_keypairs,
    retire_keypair,
    set_current,
)
from secret_gate.keystore import load_all_private_keys, load_private_key, save_keypair
from secret_gate.policy import SecretPayload
from secret_gate.resolver import Resolver
from secret_gate.tokens import make_token


def _legacy(home, name):
    pair = generate_keypair()
    save_keypair(home / "keys" / "legacy" / name, pair)
    return pair


def _mode(path) -> int:
    return stat.S_IMODE(path.stat().st_mode)


def test_legacy_keys_decrypt_but_never_become_current(tmp_path):
    old = _legacy(tmp_path, "work")
    create_keypair(tmp_path, "main")
    rows = list_keypairs(tmp_path)
    assert [(k.name, k.current, k.legacy) for k in rows] == [("main", True, False), ("work", False, True)]
    assert rows[1].public == b64url_encode(old.public) and rows[1].created_at.endswith("Z")
    with pytest.raises(KeyStoreError, match="已停用（仅解密）"):
        set_current(tmp_path, "work")
    assert current_name(tmp_path) == "main"
    token = make_token(old.public, SecretPayload.create(value="pw-legacy-1", hosts=["a.example"], uses=[USE_HTTP], label="a/p"))
    assert Resolver.from_home(tmp_path).resolve(token, use=USE_HTTP, host="a.example:443").value == "pw-legacy-1"
    assert all_key_dirs(tmp_path)[-1] == tmp_path / "keys" / "legacy" / "work"   # current first, legacy last
    assert old.private in load_all_private_keys(tmp_path)


def test_a_home_with_only_legacy_keys_has_no_current(tmp_path):
    _legacy(tmp_path, "default")
    assert current_name(tmp_path) is None
    with pytest.raises(KeyStoreError, match="no keypair"):
        load_private_key(tmp_path)
    assert len(load_all_private_keys(tmp_path)) == 1   # the proxy can still open old tokens


def test_retire_deletes_only_legacy_keys(tmp_path):
    _legacy(tmp_path, "old")
    create_keypair(tmp_path, "main")
    create_keypair(tmp_path, "spare")
    with pytest.raises(KeyStoreError, match="当前密钥"):
        retire_keypair(tmp_path, "main")
    with pytest.raises(KeyStoreError, match="未停用"):
        retire_keypair(tmp_path, "spare")
    with pytest.raises(KeyStoreError, match="no keypair"):
        retire_keypair(tmp_path, "nope")
    retire_keypair(tmp_path, "old")
    assert [k.name for k in list_keypairs(tmp_path)] == ["main", "spare"]
    assert not (tmp_path / "keys" / "legacy" / "old").exists()


def test_names_are_unique_across_current_and_legacy_and_legacy_is_reserved(tmp_path):
    _legacy(tmp_path, "work")
    with pytest.raises(KeyStoreError, match="exists"):
        create_keypair(tmp_path, "work")
    with pytest.raises(KeyStoreError, match="invalid"):
        create_keypair(tmp_path, "legacy")


def test_save_keypair_makes_every_created_directory_private(tmp_path):
    tmp_path.chmod(0o755)
    old = os.umask(0o022)
    try:
        create_keypair(tmp_path / "fresh", "main")
    finally:
        os.umask(old)
    for path in (tmp_path / "fresh", tmp_path / "fresh" / "keys", tmp_path / "fresh" / "keys" / "main"):
        assert _mode(path) == 0o700, path
    assert _mode(tmp_path) == 0o755    # a parent that already existed is left alone


def test_unreadable_directories_raise_a_gate_error(tmp_path):
    create_keypair(tmp_path, "main")
    keys = tmp_path / "keys"
    keys.chmod(0o000)
    try:
        if os.access(keys, os.R_OK):
            pytest.skip("running as root: permissions are not enforced")
        with pytest.raises(KeyStoreError, match="无法读取"):
            list_keypairs(tmp_path)
        with pytest.raises(KeyStoreError):
            load_all_private_keys(tmp_path)
    finally:
        keys.chmod(0o700)


def test_pubkey_prints_the_current_named_key(tmp_path, monkeypatch, capsys):
    monkeypatch.setenv("SECRET_GATE_HOME", str(tmp_path))
    assert main(["keys", "new", "a"]) == 0
    assert main(["keys", "new", "b", "--use"]) == 0
    capsys.readouterr()
    assert main(["pubkey"]) == 0
    assert capsys.readouterr().out.strip() == next(k.public for k in list_keypairs(tmp_path) if k.name == "b")


def test_cli_keys_json_marks_legacy_and_retire(tmp_path, monkeypatch, capsys):
    import json

    monkeypatch.setenv("SECRET_GATE_HOME", str(tmp_path))
    _legacy(tmp_path, "old")
    assert main(["keys", "new", "main"]) == 0
    capsys.readouterr()
    assert main(["keys", "--json"]) == 0
    rows = json.loads(capsys.readouterr().out)
    assert rows == [{"name": "main", "public": rows[0]["public"], "current": True, "legacy": False},
                    {"name": "old", "public": rows[1]["public"], "current": False, "legacy": True}]
    assert main(["keys", "use", "old"]) == 2
    assert "已停用" in capsys.readouterr().err
    assert main(["keys", "retire", "old"]) == 0
    assert "old" not in capsys.readouterr().out
