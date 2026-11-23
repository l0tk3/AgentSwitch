from __future__ import annotations

import sys

import pytest

from secret_gate.constants import KIND_TOTP, USE_EXEC, USE_HTTP, USE_OTP
from secret_gate.crypto import generate_keypair
from secret_gate.policy import SecretPayload
from secret_gate.resolver import Resolver
from secret_gate.tokens import make_token

from .fixtures import fake_secrets as fs

FIXED_TIME = 1_700_000_000.0
WINDOWS = sys.platform == "win32"

# Whole modules about POSIX-only things are not collected on Windows: the macOS LaunchAgent (service.py), the macOS and
# Linux service installs carried out with modes and chown (their Windows counterpart is test_system_windows.py), and
# the agents' harness configuration (bootstrap, harness_config), which belongs to the daemon and terminals that are not
# ported to Windows (gate-simple-v0 §5).
collect_ignore = ["test_service.py", "test_system_install.py", "test_system_linux.py", "test_system_plan.py",
                  "test_bootstrap.py", "test_config_snippets.py", "test_harness_config.py"] if WINDOWS else []


def private(path, mode: int | None = None) -> bool:
    """Only this user may read `path`: its mode is `mode` (None: no group/other bits) on POSIX; on Windows, where
    modes say nothing, its ACL grants nobody untrusted (fsacl.private_problem)."""
    import stat

    if WINDOWS:
        from secret_gate.fsacl import private_problem

        return private_problem(path) is None
    actual = stat.S_IMODE(path.stat().st_mode)
    return actual & 0o077 == 0 if mode is None else actual == mode


def pytest_configure(config):
    config.addinivalue_line("markers", "posix: needs POSIX (file modes, AF_UNIX, uids, sh); skipped on Windows")
    config.addinivalue_line("markers", "windows: needs Windows (ACLs, named pipes, cmd); skipped elsewhere")


def pytest_collection_modifyitems(config, items):
    """`posix` tests are skipped on Windows, `windows` tests everywhere else (gate-simple-v0 §5: the Windows CI job
    runs the core suite; what only makes sense on one kind of system says so with a marker)."""
    for item in items:
        if WINDOWS and item.get_closest_marker("posix"):
            item.add_marker(pytest.mark.skip(reason="POSIX only (modes, AF_UNIX, uids or sh)"))
        if not WINDOWS and item.get_closest_marker("windows"):
            item.add_marker(pytest.mark.skip(reason="Windows only"))


@pytest.fixture(scope="session")
def keypair():
    return generate_keypair()


@pytest.fixture(scope="session")
def other_keypair():
    return generate_keypair()


@pytest.fixture
def resolver(keypair):
    return Resolver(keypair.private, clock=lambda: FIXED_TIME)


def _tok(pub, *, value, hosts, uses, label, kind="secret"):
    return make_token(pub, SecretPayload.create(value=value, hosts=hosts, uses=uses, label=label, kind=kind))


@pytest.fixture
def portal_pass(keypair):
    return _tok(keypair.public, value=fs.PORTAL.password, hosts=fs.PORTAL.hosts, uses={USE_HTTP}, label=fs.PORTAL.label)


@pytest.fixture
def portal_user(keypair):
    return _tok(keypair.public, value=fs.PORTAL.username, hosts=fs.PORTAL.hosts, uses={USE_HTTP}, label="portal-a/user")


@pytest.fixture
def portal_totp(keypair):
    return _tok(keypair.public, value=fs.TOTP_SECRET_B32, hosts=fs.PORTAL.hosts, uses={USE_HTTP, USE_OTP}, label=fs.TOTP_LABEL, kind=KIND_TOTP)


@pytest.fixture
def bank_pass(keypair):
    return _tok(keypair.public, value=fs.BANK.password, hosts=fs.BANK.hosts, uses={USE_HTTP}, label=fs.BANK.label)


@pytest.fixture
def api_bearer(keypair):
    return _tok(keypair.public, value=fs.API_BEARER.password, hosts=fs.API_BEARER.hosts, uses={USE_HTTP}, label=fs.API_BEARER.label)


@pytest.fixture
def db_pass(keypair):
    return _tok(keypair.public, value=fs.DB.password, hosts=(), uses={USE_EXEC}, label=fs.DB.label)


@pytest.fixture
def gate_home(tmp_path, monkeypatch, keypair):
    from secret_gate.keystore import save_keypair

    home = tmp_path / "gate"
    save_keypair(home, keypair)
    monkeypatch.setenv("SECRET_GATE_HOME", str(home))
    return home


@pytest.fixture(autouse=True)
def no_real_gate_service(tmp_path_factory, monkeypatch):
    """No test may find the machine's real gate service: SECRET_GATE_PUBLIC points at an empty directory
    (child processes inherit it), so the CLI, MCP and browser servers stay in local mode unless a test
    starts its own service on a temporary socket."""
    monkeypatch.setenv("SECRET_GATE_PUBLIC", str(tmp_path_factory.mktemp("no-gate-public")))
