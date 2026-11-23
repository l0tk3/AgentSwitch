"""The pywin32 glue of the Windows gate (gate-simple-v0 §5), on a real Windows: ACLs, the user-mode key, liveness.

Skipped everywhere else (the `windows` marker); the decisions behind it are tested on every system in
test_system_windows.py, the named pipe in test_rpc.py, secret_exec with cmd and PowerShell in test_secret_exec.py.
"""

from __future__ import annotations

import os
import subprocess
import sys

import pytest

from secret_gate import fsacl
from secret_gate.errors import KeyStoreError
from secret_gate.keyring import create_keypair
from secret_gate.keystore import load_private_key

pytestmark = pytest.mark.windows


def test_restrict_to_current_user_leaves_only_this_user_and_children_inherit_it(tmp_path):
    home = tmp_path / "home"
    home.mkdir()
    fsacl.restrict_to_current_user(home)
    aces, owner = fsacl.read_acl(home)
    me = fsacl.current_user_sid()
    assert [(a.kind, a.sid) for a in aces if not a.inherit_only] == [("allow", me)] and owner
    (home / "key.priv").write_text("x")
    child, _owner = fsacl.read_acl(home / "key.priv")
    assert {a.sid for a in child} == {me}                                  # inherited, nothing of its own
    assert fsacl.private_problem(home / "key.priv") is None


def test_set_acl_is_exactly_the_grants_and_resets_what_is_below(tmp_path):
    top = tmp_path / "top"
    (top / "sub").mkdir(parents=True)
    (top / "sub" / "f").write_text("x")
    fsacl.set_acl(top / "sub" / "f", ((fsacl.USERS_SID, "read"), (fsacl.current_user_sid(), "full")))
    assert fsacl.private_problem(top / "sub" / "f") == f"readable by {fsacl.USERS_SID}"
    fsacl.set_acl(top, ((fsacl.SYSTEM_SID, "full"), (fsacl.current_user_sid(), "full")), reset_children=True)
    assert fsacl.private_problem(top / "sub" / "f") is None                 # its own entry for Users is gone
    assert {a.sid for a in fsacl.read_acl(top)[0]} == {fsacl.SYSTEM_SID, fsacl.current_user_sid()}


def test_owner_rights_count_as_the_owner_and_an_acl_others_may_write_is_refused(tmp_path):
    """The user's temporary directory carries an OWNER RIGHTS entry (S-1-3-4): files made there are this user's. The
    admin's upstream-insecure.txt is trusted by its real ACL, refused once Users may change it."""
    from secret_gate.errors import ValidationError
    from secret_gate.reload import read_insecure_hosts

    path = tmp_path / "upstream-insecure.txt"
    path.write_text("a.example\n")
    fsacl.set_acl(path, ((fsacl.OWNER_RIGHTS_SID, "full"), (fsacl.SYSTEM_SID, "full")))
    assert fsacl.owner_sid(path) in fsacl.trusted_sids()          # this user (or Administrators, on Windows Server)
    assert fsacl.private_problem(path) is None and fsacl.write_problem(path) is None
    assert read_insecure_hosts(path) == {"a.example"}
    fsacl.set_acl(path, ((fsacl.OWNER_RIGHTS_SID, "full"), (fsacl.USERS_SID, "modify")))
    with pytest.raises(ValidationError, match=f"writable by {fsacl.USERS_SID}"):
        read_insecure_hosts(path)


def test_keygen_makes_a_home_only_this_user_can_read_and_a_readable_key_is_refused(tmp_path):
    home = tmp_path / "gate"
    create_keypair(home)
    assert fsacl.private_problem(home) is None and fsacl.private_problem(home / "key.priv") is None
    assert {a.sid for a in fsacl.read_acl(home)[0] if not a.inherit_only} == {fsacl.current_user_sid()}
    assert len(load_private_key(home)) == 32
    fsacl.set_acl(home / "key.priv", ((fsacl.current_user_sid(), "full"), ("S-1-1-0", "read")))   # Everyone
    with pytest.raises(KeyStoreError, match="is not private"):
        load_private_key(home)


def test_the_cli_keygen_on_windows(tmp_path):
    home = tmp_path / "cli-home"
    env = {**os.environ, "SECRET_GATE_HOME": str(home)}
    done = subprocess.run([sys.executable, "-m", "secret_gate.cli", "keygen"], env=env, capture_output=True, text=True)
    assert done.returncode == 0, done.stderr
    assert fsacl.private_problem(home / "key.priv") is None


def test_liveness_without_os_kill():
    from secret_gate.proxy_pid import alive

    assert alive(os.getpid()) and fsacl.process_alive(os.getpid())
    child = subprocess.Popen([sys.executable, "-c", "pass"])
    child.wait()
    assert not fsacl.process_alive(child.pid) or child.pid == os.getpid()


def test_links_and_junctions_are_never_followed(tmp_path):
    target = tmp_path / "target"
    target.mkdir()
    junction = tmp_path / "junction"
    subprocess.run(["cmd", "/c", "mklink", "/J", str(junction), str(target)], check=True, capture_output=True)
    assert fsacl.is_link(junction) and not fsacl.is_link(target)


def test_known_folders_and_the_windows_directory_come_from_the_system(monkeypatch):
    monkeypatch.setenv("ProgramData", "C:\\Users\\Public\\evil")
    monkeypatch.setenv("SystemRoot", "C:\\Users\\Public\\evil")
    assert "evil" not in fsacl.known_folder("ProgramData", "x") and "evil" not in fsacl.windows_dir()
    assert os.path.isdir(fsacl.known_folder("ProgramFiles", "x"))
