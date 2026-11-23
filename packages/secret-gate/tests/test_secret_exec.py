"""secret_exec without templates (gate-simple-v0 §2.1): the agent's own argv, values only in env, run as the login
user in the MCP process, a minimal environment, empty stdin, output through the redactor. Real child processes."""

from __future__ import annotations

import json
import os
import subprocess

import pytest

from secret_gate.constants import MAX_BODY_BYTES, USE_EXEC, USE_FILL, USE_HTTP
from secret_gate.errors import GateError, PolicyViolation, ValidationError
from secret_gate.gate_ops import EXEC_PATH, check_exec_argv, check_exec_env, exec_child_env, op_exec
from secret_gate.mcp_backend import LocalMcpBackend, RemoteMcpBackend
from secret_gate.policy import SecretPayload
from secret_gate.refs import RefRegistry
from secret_gate.resolver import Resolver
from secret_gate.tokens import make_token
from tests.service_fixtures import running_service

VALUE = "s3cret-Exec-Value-42"
SCOPE = "exec-scope-0123456789abcdefghij"


def _token(public: bytes, *, value: str = VALUE, uses=(USE_EXEC,), label: str = "db/pass") -> str:
    return make_token(public, SecretPayload.create(value=value, hosts=["db.example.com"], uses=set(uses), label=label))


@pytest.fixture
def local(keypair, tmp_path):
    resolver = Resolver(keypair.private, refs=RefRegistry(tmp_path / "refs.sqlite3"), scope=SCOPE)
    return LocalMcpBackend(resolver), resolver, keypair.public


def _no_value(out: dict) -> None:
    assert VALUE not in json.dumps(out) and VALUE.lower() not in json.dumps(out).lower()


def test_the_value_reaches_the_command_only_through_env_and_never_comes_back(local):
    backend, _, public = local
    token = _token(public)
    out = backend.exec(["/bin/sh", "-c", 'test "$DB_PASSWORD" = "' + "$EXPECTED" + '" ; echo len=${#DB_PASSWORD}'],
                       {"DB_PASSWORD": token, "EXPECTED": token})
    assert out["returncode"] == 0 and out["stdout"] == f"len={len(VALUE)}\n"
    for argv in (["/usr/bin/env"], ["/usr/bin/printenv"], ["/usr/bin/printenv", "DB_PASSWORD"],
                 ["/bin/sh", "-c", "set -x; echo \"$DB_PASSWORD\" >/dev/null; echo $DB_PASSWORD | tr a-z A-Z"],
                 ["/bin/sh", "-c", "echo $DB_PASSWORD | cut -c 3-14"],
                 ["/bin/sh", "-c", "printf %s \"$DB_PASSWORD\" | base64"],
                 ["/bin/sh", "-c", "printf %s \"$DB_PASSWORD\" | xxd -p"]):
        out = backend.exec(argv, {"DB_PASSWORD": token})
        assert out["returncode"] == 0, out
        _no_value(out)
        assert "[REDACTED:db/pass]" in out["stdout"] + out["stderr"]


def test_the_child_environment_is_minimal_and_stdin_empty(local, monkeypatch, tmp_path):
    backend, _, public = local
    monkeypatch.setenv("SECRET_GATE_SCOPE", SCOPE)
    monkeypatch.setenv("LEAKY_TOKEN", "should-not-pass")
    monkeypatch.setenv("LANG", "en_US.UTF-8")
    monkeypatch.chdir(tmp_path)
    out = backend.exec(["/usr/bin/env"], {"DB_PASSWORD": _token(public)})
    names = {line.split("=", 1)[0] for line in out["stdout"].splitlines()}
    assert names <= {"PATH", "HOME", "LANG", "LC_ALL", "TZ", "TMPDIR", "DB_PASSWORD", "PWD", "SHLVL", "_"}
    assert "LEAKY_TOKEN" not in names and "SECRET_GATE_SCOPE" not in names and "DB_PASSWORD" in names
    assert f"PATH={EXEC_PATH}" in out["stdout"].splitlines()
    out = backend.exec(["/bin/sh", "-c", "cat; pwd"], {"DB_PASSWORD": _token(public)})
    assert out["stdout"] == f"{os.path.realpath(tmp_path)}\n" or out["stdout"] == f"{tmp_path}\n"   # stdin was empty
    assert exec_child_env({"HOME": "/h", "PATH": "/evil", "LD_PRELOAD": "x", "TZ": "UTC"}) == {
        "HOME": "/h", "TZ": "UTC", "PATH": EXEC_PATH}


def test_it_runs_as_the_login_user(local):
    backend, _, public = local
    out = backend.exec(["/usr/bin/id", "-u"], {"DB_PASSWORD": _token(public)})
    assert out["stdout"].strip() == str(os.getuid())


@pytest.mark.parametrize("argv", [
    ["echo", "enc:v1:" + "A" * 40], ["curl", "-u", "x:enc:ref:" + "A" * 16], ["echo", "ENC:V1:abc"],
    ["echo", "enc%3Av1%3A" + "A" * 30], ["sh", "-c", "echo enc:"], [], "echo hi", [""], ["a\0b"], ["x"] * 257,
])
def test_argv_may_not_carry_a_token(argv):
    with pytest.raises(ValidationError):
        check_exec_argv(argv)


@pytest.mark.parametrize("name", [
    "LD_PRELOAD", "LD_LIBRARY_PATH", "DYLD_INSERT_LIBRARIES", "PATH", "HOME", "PYTHONPATH", "PYTHONSTARTUP",
    "NODE_OPTIONS", "BASH_ENV", "ENV", "IFS", "PERL5OPT", "RUBYOPT", "GIT_SSH_COMMAND", "LC_ALL", "TMPDIR",
    "SECRET_GATE_HOME", "BASH_FUNC_x%%", "db_password", "Db_Password", "1ABC", "A-B", "A" * 65, "",
])
def test_dangerous_or_odd_env_names_are_refused(name, keypair):
    with pytest.raises(ValidationError):
        check_exec_env({name: _token(keypair.public)})


@pytest.mark.parametrize("value", [
    "plain", "enc:v1:", " enc:ref:AAAAAAAAAAAAAAAA", "enc:ref:AAAAAAAAAAAAAAAA enc:ref:BBBBBBBBBBBBBBBB",
    "x enc:ref:AAAAAAAAAAAAAAAA", 42, None,
])
def test_each_env_value_must_be_exactly_one_token_or_ref(value):
    with pytest.raises(ValidationError):
        check_exec_env({"DB_PASSWORD": value})


def test_env_must_name_one_to_thirty_two_variables():
    for env in ({}, None, [], {f"V{n}": "enc:ref:AAAAAAAAAAAAAAAA" for n in range(33)}):
        with pytest.raises(ValidationError):
            check_exec_env(env)
    assert check_exec_env({"PGPASSWORD": "enc:ref:AAAAAAAAAAAAAAAA"}) == {"PGPASSWORD": "enc:ref:AAAAAAAAAAAAAAAA"}


def test_only_exec_tokens_open_and_nothing_runs_otherwise(local):
    backend, _, public = local
    ran: list = []
    guarded = LocalMcpBackend(backend._resolver, exec_runner=lambda *a, **k: ran.append(a))
    for uses in ((USE_HTTP,), (USE_FILL,), (USE_HTTP, USE_FILL)):
        with pytest.raises(PolicyViolation, match="does not allow use 'exec'"):
            guarded.exec(["true"], {"DB_PASSWORD": _token(public, uses=uses)})
    with pytest.raises(ValidationError):
        guarded.exec(["echo", _token(public)], {"DB_PASSWORD": _token(public)})
    assert ran == []


def test_references_of_this_execution_work(local):
    backend, resolver, public = local
    ref = resolver.register(_token(public))
    out = backend.exec(["/bin/sh", "-c", "echo $PW"], {"PW": ref})
    assert out["stdout"] == "[REDACTED:db/pass]\n"


def test_large_output_is_withheld_whole_and_failures_name_only_their_kind(local):
    backend, resolver, public = local
    token = _token(public)

    def big(argv, **_kw):
        return subprocess.CompletedProcess(argv, 0, stdout="x" * (MAX_BODY_BYTES + 1) + VALUE, stderr="")

    out = LocalMcpBackend(resolver, exec_runner=big).exec(["big"], {"PW": token})
    assert "内容过大，已扣下" in out["stdout"] and VALUE not in out["stdout"]
    with pytest.raises(GateError, match=r"command failed to run \(FileNotFoundError\)"):
        backend.exec(["/nonexistent/tool"], {"PW": token})

    def slow(argv, **kw):
        raise subprocess.TimeoutExpired(argv, kw["timeout"], output=VALUE)

    with pytest.raises(GateError, match="timed out") as exc:
        LocalMcpBackend(resolver, exec_runner=slow).exec(["sleep", "999"], {"PW": token})
    assert VALUE not in str(exc.value)


def test_op_exec_hands_the_runner_the_minimal_environment(keypair):
    seen: dict = {}

    def runner(argv, **kw):
        seen.update(kw, argv=argv)
        return subprocess.CompletedProcess(argv, 0, stdout="", stderr="")

    resolver = Resolver(keypair.private)
    op_exec(lambda t: resolver.resolve_exact(t, use=USE_EXEC), argv=["tool", "--flag"],
            env={"API_KEY": _token(keypair.public)}, runner=runner, base_env={"HOME": "/home/u", "SECRET": "x"}, cwd="/tmp")
    assert seen["argv"] == ["tool", "--flag"] and seen["stdin"] == subprocess.DEVNULL and seen["cwd"] == "/tmp"
    assert seen["env"] == {"HOME": "/home/u", "PATH": EXEC_PATH, "API_KEY": VALUE}


def test_with_the_service_the_command_runs_as_this_user_with_a_value_from_exec_resolve():
    with running_service() as svc:
        from secret_gate.keystore import load_public_key

        token = _token(load_public_key(svc.home))
        out = RemoteMcpBackend(svc.client, None).exec(["/bin/sh", "-c", "id -u; printenv PW"], {"PW": token})
        assert out["stdout"] == f"{os.getuid()}\n[REDACTED:db/pass]\n"
        audit = svc.audit.read_text()
        assert VALUE not in audit and "exec.resolve" in audit and "printenv" not in audit
