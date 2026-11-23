"""The gate's one keypair (gate-simple-v0 §1): <home>/key.priv and key.pub, nothing else."""
import pytest

from secret_gate.errors import KeyStoreError
from secret_gate.keyring import KEY_NAME, create_keypair, has_keypair, keypair_info
from secret_gate.keystore import load_private_key, load_public_key
from secret_gate.publish import key_rows
from secret_gate.crypto import b64url_encode


def test_empty_home_has_no_keypair(tmp_path):
    assert keypair_info(tmp_path) is None and not has_keypair(tmp_path)
    assert key_rows(tmp_path) == ()
    with pytest.raises(KeyStoreError, match="not found"):
        load_private_key(tmp_path)


def test_create_writes_the_one_keypair_at_the_top_of_the_home(tmp_path):
    info = create_keypair(tmp_path)
    assert info.name == KEY_NAME and info.path == tmp_path and len(info.public) > 20
    assert oct((tmp_path / "key.priv").stat().st_mode & 0o777) == "0o600"
    assert b64url_encode(load_public_key(tmp_path)) == info.public
    assert [r.cli_json() for r in key_rows(tmp_path)] == [
        {"name": KEY_NAME, "public": info.public, "current": True, "legacy": False, "created": info.created_at}]
    assert sorted(p.name for p in tmp_path.iterdir()) == ["key.priv", "key.pub"]


def test_a_second_create_is_refused_and_replace_makes_a_new_key(tmp_path):
    first = create_keypair(tmp_path)
    old_private = load_private_key(tmp_path)
    with pytest.raises(KeyStoreError, match="已有密钥"):
        create_keypair(tmp_path)
    assert load_private_key(tmp_path) == old_private
    second = create_keypair(tmp_path, replace=True)
    assert second.public != first.public and load_private_key(tmp_path) != old_private
    assert len(key_rows(tmp_path)) == 1


def test_directories_of_the_old_multi_key_layout_are_ignored(tmp_path):
    (tmp_path / "keys" / "legacy" / "old").mkdir(parents=True)
    (tmp_path / "keys" / "legacy" / "old" / "key.priv").write_text("x")
    (tmp_path / "current").write_text("old\n")
    assert keypair_info(tmp_path) is None
    create_keypair(tmp_path)
    assert [r.name for r in key_rows(tmp_path)] == [KEY_NAME]
