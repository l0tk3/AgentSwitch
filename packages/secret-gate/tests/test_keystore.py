import pytest

from secret_gate.crypto import generate_keypair
from secret_gate.errors import KeyStoreError
from secret_gate.keystore import (
    gate_home,
    load_private_key,
    load_public_key,
    parse_public_key,
    save_keypair,
)


def test_save_and_load(tmp_path):
    kp = generate_keypair()
    priv, pub = save_keypair(tmp_path / "h", kp)
    assert oct(priv.stat().st_mode & 0o777) == "0o600"
    assert load_private_key(tmp_path / "h") == kp.private
    assert load_public_key(tmp_path / "h") == kp.public


def test_refuse_overwrite(tmp_path):
    save_keypair(tmp_path, generate_keypair())
    with pytest.raises(KeyStoreError):
        save_keypair(tmp_path, generate_keypair())
    save_keypair(tmp_path, generate_keypair(), overwrite=True)


def test_refuse_loose_permissions(tmp_path):
    priv, _ = save_keypair(tmp_path, generate_keypair())
    priv.chmod(0o644)
    with pytest.raises(KeyStoreError, match="readable by others"):
        load_private_key(tmp_path)


def test_missing_and_corrupt(tmp_path):
    with pytest.raises(KeyStoreError, match="not found"):
        load_private_key(tmp_path)
    (tmp_path / "key.pub").write_text("@@@")
    with pytest.raises(KeyStoreError, match="corrupt"):
        load_public_key(tmp_path)
    (tmp_path / "key.pub").write_text("AAAA")
    with pytest.raises(KeyStoreError, match="wrong length"):
        load_public_key(tmp_path)


def test_parse_public_key(keypair):
    from secret_gate.crypto import b64url_encode

    assert parse_public_key(b64url_encode(keypair.public)) == keypair.public
    with pytest.raises(KeyStoreError):
        parse_public_key("@@")
    with pytest.raises(KeyStoreError):
        parse_public_key("AAAA")


def test_gate_home_env(monkeypatch, tmp_path):
    monkeypatch.setenv("SECRET_GATE_HOME", str(tmp_path))
    assert gate_home() == tmp_path
    monkeypatch.delenv("SECRET_GATE_HOME")
    assert gate_home().name == ".secret-gate"
