"""Named keypairs: several under SECRET_GATE_HOME/keys/<name>/, one marked current.

A legacy home with key.priv at the root keeps working and is reported as "default".
"""
import pytest

from secret_gate.crypto import generate_keypair
from secret_gate.errors import KeyStoreError
from secret_gate.keyring import create_keypair, current_name, key_dir, list_keypairs, set_current
from secret_gate.keystore import load_all_private_keys, load_private_key, load_public_key, save_keypair


def test_empty_home_has_no_keypairs(tmp_path):
    assert list_keypairs(tmp_path) == ()
    assert current_name(tmp_path) is None
    with pytest.raises(KeyStoreError, match="not found"):
        load_private_key(tmp_path)


def test_create_sets_current_and_layout(tmp_path):
    info = create_keypair(tmp_path, "work")
    assert info.name == "work" and info.current is True and len(info.public) > 20
    assert key_dir(tmp_path) == tmp_path / "keys" / "work"
    assert (key_dir(tmp_path) / "key.priv").exists()
    assert oct((key_dir(tmp_path) / "key.priv").stat().st_mode & 0o777) == "0o600"
    assert load_public_key(tmp_path) == load_public_key(key_dir(tmp_path))


def test_second_keypair_not_current_until_switched(tmp_path):
    create_keypair(tmp_path, "work")
    create_keypair(tmp_path, "home")
    assert current_name(tmp_path) == "work"
    assert [k.name for k in list_keypairs(tmp_path)] == ["home", "work"]
    set_current(tmp_path, "home")
    assert current_name(tmp_path) == "home"
    assert load_private_key(tmp_path) == load_private_key(tmp_path / "keys" / "home")


def test_all_private_keys_current_first(tmp_path):
    a = create_keypair(tmp_path, "a")
    b = create_keypair(tmp_path, "b")
    set_current(tmp_path, "a")
    keys = load_all_private_keys(tmp_path)
    assert len(keys) == 2 and keys[0] == load_private_key(tmp_path / "keys" / "a")
    assert a.public != b.public


def test_legacy_root_key_is_default(tmp_path):
    kp = generate_keypair()
    save_keypair(tmp_path, kp)
    assert [k.name for k in list_keypairs(tmp_path)] == ["default"]
    assert current_name(tmp_path) == "default"
    assert load_private_key(tmp_path) == kp.private
    create_keypair(tmp_path, "new")  # legacy stays current; both remain loadable
    assert current_name(tmp_path) == "default"
    set_current(tmp_path, "new")
    assert current_name(tmp_path) == "new"
    assert kp.private in load_all_private_keys(tmp_path)
    assert load_private_key(tmp_path) != kp.private


@pytest.mark.parametrize("bad", ["", "../x", "a b", "x" * 40, "keys", "-dash"])
def test_rejects_bad_names(tmp_path, bad):
    with pytest.raises(KeyStoreError):
        create_keypair(tmp_path, bad)


def test_duplicate_and_unknown(tmp_path):
    create_keypair(tmp_path, "work")
    with pytest.raises(KeyStoreError, match="exists"):
        create_keypair(tmp_path, "work")
    with pytest.raises(KeyStoreError, match="no keypair"):
        set_current(tmp_path, "nope")
