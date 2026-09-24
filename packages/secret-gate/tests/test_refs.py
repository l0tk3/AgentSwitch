"""Scoped short references: registry rules and resolution through the same policy as tokens."""

from __future__ import annotations

import stat

import pytest

from secret_gate.constants import REF_MAX_AGE_SECONDS, RELEASED_SCOPE_RETENTION_SECONDS, USE_EXEC, USE_HTTP, USE_OTP
from secret_gate.errors import PolicyViolation, RefError, ValidationError
from secret_gate.refs import RefRegistry, check_scope, new_ref
from secret_gate.resolver import Resolver
from secret_gate.tokens import find_refs, find_secrets, is_ref, is_secret
from tests.fixtures import fake_secrets as fs

SCOPE_A = "scope-a-0123456789abcdefghij"
SCOPE_B = "scope-b-0123456789abcdefghij"
HOST = "portal-a.example.com:443"


class Clock:
    def __init__(self, now: float = 1_700_000_000.0) -> None:
        self.now = now

    def __call__(self) -> float:
        return self.now


@pytest.fixture
def clock():
    return Clock()


@pytest.fixture
def registry(tmp_path, clock):
    return RefRegistry(tmp_path / "gate" / "refs.sqlite3", clock=clock)


@pytest.fixture
def scoped(keypair, registry):
    def make(scope):
        return Resolver(keypair.private, refs=registry, scope=scope)
    return make


def test_reference_shape_and_detection():
    ref = new_ref()
    assert len(ref) == 24 and is_ref(ref) and is_secret(ref)
    assert not is_ref(ref + "x") and not is_ref("enc:ref:short")
    text = f"a={ref}&b=enc%3Aref%3A{ref[8:]}&c={ref}"
    assert find_refs(text) == (ref,)
    assert find_refs(f"{ref}Z") == ()  # a longer run is not a reference


def test_find_secrets_lists_tokens_then_refs(portal_pass):
    ref = new_ref()
    assert find_secrets(f"{ref} {portal_pass}") == (portal_pass, ref)


def test_register_is_stable_per_scope_and_distinct_across_scopes(registry, portal_pass):
    a1 = registry.register(SCOPE_A, portal_pass, fs.PORTAL.label)
    a2 = registry.register(SCOPE_A, portal_pass, fs.PORTAL.label)
    b = registry.register(SCOPE_B, portal_pass, fs.PORTAL.label)
    assert a1 == a2 and a1 != b
    assert registry.lookup(SCOPE_A, a1).token == portal_pass


def test_registry_file_is_private_and_holds_no_plaintext_or_scope(registry, portal_pass):
    registry.register(SCOPE_A, portal_pass, fs.PORTAL.label)
    assert stat.S_IMODE(registry.path.stat().st_mode) == 0o600
    raw = registry.path.read_bytes()
    assert fs.PORTAL.password.encode() not in raw and SCOPE_A.encode() not in raw


def test_same_label_in_two_tasks_does_not_mix(scoped, registry, keypair):
    from secret_gate.policy import SecretPayload
    from secret_gate.tokens import make_token

    def tok(value):
        return make_token(keypair.public, SecretPayload.create(value=value, hosts=[HOST], uses=[USE_HTTP], label="acct1/pass"))

    ra = registry.register(SCOPE_A, tok("value-for-a"), "acct1/pass")
    rb = registry.register(SCOPE_B, tok("value-for-b"), "acct1/pass")
    assert scoped(SCOPE_A).resolve(ra, use=USE_HTTP, host=HOST).value == "value-for-a"
    assert scoped(SCOPE_B).resolve(rb, use=USE_HTTP, host=HOST).value == "value-for-b"
    with pytest.raises(RefError, match="different task"):
        scoped(SCOPE_B).resolve(ra, use=USE_HTTP, host=HOST)


def test_reference_keeps_the_sealed_policy(scoped, registry, portal_pass):
    ref = registry.register(SCOPE_A, portal_pass, fs.PORTAL.label)
    r = scoped(SCOPE_A)
    assert r.resolve(ref, use=USE_HTTP, host=HOST).value == fs.PORTAL.password
    with pytest.raises(PolicyViolation, match="not allowed on host"):
        r.resolve(ref, use=USE_HTTP, host=fs.EVIL_HOST)
    with pytest.raises(PolicyViolation, match="does not allow use"):
        r.resolve(ref, use=USE_EXEC)
    with pytest.raises(PolicyViolation, match="does not allow use"):
        r.resolve(ref, use=USE_OTP)


def test_reference_without_scope_is_refused(scoped, registry, portal_pass):
    ref = registry.register(SCOPE_A, portal_pass, fs.PORTAL.label)
    with pytest.raises(RefError, match="no task scope"):
        scoped(None).resolve(ref, use=USE_HTTP, host=HOST)


def test_resolver_without_registry_rejects_references(resolver):
    with pytest.raises(ValidationError, match="not available"):
        resolver.resolve(new_ref(), use=USE_HTTP, host=HOST)


def test_release_ends_the_scope_but_not_the_ciphertext(scoped, registry, portal_pass):
    ref = registry.register(SCOPE_A, portal_pass, fs.PORTAL.label)
    assert registry.release(SCOPE_A) == 1
    with pytest.raises(RefError, match="released"):
        scoped(SCOPE_A).resolve(ref, use=USE_HTTP, host=HOST)
    with pytest.raises(RefError, match="cannot register"):
        registry.register(SCOPE_A, portal_pass, fs.PORTAL.label)
    assert registry.release(SCOPE_A) == 0
    # The original enc:v1: still works wherever its own policy allows: release is not revocation.
    assert scoped(None).resolve(portal_pass, use=USE_HTTP, host=HOST).value == fs.PORTAL.password
    # Continuation: a trusted caller registers it again in a fresh scope.
    again = registry.register(SCOPE_B, portal_pass, fs.PORTAL.label)
    assert again != ref and scoped(SCOPE_B).resolve(again, use=USE_HTTP, host=HOST).value == fs.PORTAL.password


def test_releasing_an_unknown_scope_blocks_it_for_good(registry, portal_pass):
    assert registry.release(SCOPE_A) == 0
    with pytest.raises(RefError):
        registry.register(SCOPE_A, portal_pass, fs.PORTAL.label)


def test_unknown_reference_and_missing_file(registry, tmp_path, portal_pass):
    empty = RefRegistry(tmp_path / "none" / "refs.sqlite3")
    with pytest.raises(RefError, match="unknown"):
        empty.lookup(SCOPE_A, new_ref())
    assert not empty.path.exists()  # a lookup never creates the file
    registry.register(SCOPE_A, portal_pass, fs.PORTAL.label)
    with pytest.raises(RefError, match="unknown"):
        registry.lookup(SCOPE_A, new_ref())


@pytest.mark.parametrize("scope", ["short", "has space in it 0123456789", "x" * 65, None, 42])
def test_invalid_scopes(scope):
    with pytest.raises(ValidationError):
        check_scope(scope)


def test_register_validates_inputs(registry, portal_pass):
    with pytest.raises(ValidationError):
        registry.register(SCOPE_A, "enc:v1:short", fs.PORTAL.label)
    with pytest.raises(ValidationError):
        registry.register(SCOPE_A, portal_pass, "bad label\n")
    with pytest.raises(ValidationError):
        registry.lookup(SCOPE_A, "enc:ref:nope")


def test_stale_scopes_expire_and_old_releases_are_forgotten(registry, clock, portal_pass, bank_pass):
    ref = registry.register(SCOPE_A, portal_pass, fs.PORTAL.label)
    clock.now += REF_MAX_AGE_SECONDS + 1
    registry.register(SCOPE_B, bank_pass, fs.BANK.label)  # any write prunes
    with pytest.raises(RefError, match="released"):
        registry.lookup(SCOPE_A, ref)
    clock.now += RELEASED_SCOPE_RETENTION_SECONDS + 1
    registry.register("scope-c-0123456789abcdefghij", bank_pass, fs.BANK.label)
    # Forgotten after the retention window (scopes are random and never reused by the dispatcher).
    assert registry.register(SCOPE_A, portal_pass, fs.PORTAL.label).startswith("enc:ref:")


def test_substitute_handles_plain_and_urlencoded_references(scoped, registry, portal_pass, portal_user):
    ref = registry.register(SCOPE_A, portal_pass, fs.PORTAL.label)
    body = f"user={portal_user}&pass=enc%3Aref%3A{ref[8:]}&again={ref}"
    out, res = scoped(SCOPE_A).substitute(body, use=USE_HTTP, host=HOST)
    assert fs.PORTAL.password in out and ref not in out and "enc%3Aref" not in out
    assert {r.label for r in res} == {fs.PORTAL.label, "portal-a/user"}


def test_describe_reference_shows_ref_and_policy_never_value(scoped, registry, portal_pass):
    ref = registry.register(SCOPE_A, portal_pass, fs.PORTAL.label)
    info = scoped(SCOPE_A).describe(ref)
    assert info["ref"] == ref and info["label"] == fs.PORTAL.label and info["uses"] == [USE_HTTP]
    assert fs.PORTAL.password not in str(info) and portal_pass not in str(info)


def test_scoped_copy_and_register_helper(scoped, portal_pass):
    base = scoped(None)
    with pytest.raises(ValidationError, match="no execution scope"):
        base.register(portal_pass)
    a = base.scoped(SCOPE_A)
    ref = a.register(portal_pass)
    assert a.scope == SCOPE_A and base.scope is None
    assert a.ciphertext(ref) == portal_pass and a.ciphertext(portal_pass) == portal_pass


def test_from_home_attaches_registry(gate_home, portal_pass):
    r = Resolver.from_home(gate_home, scope=SCOPE_A)
    ref = r.register(portal_pass)
    assert (gate_home / "refs.sqlite3").exists()
    assert Resolver.from_home(gate_home, scope=SCOPE_A).resolve(ref, use=USE_HTTP, host=HOST).value == fs.PORTAL.password


# -- CLI for the dispatcher -------------------------------------------------------------------------

def _cli(monkeypatch, capsys, argv, payload):
    import io
    import json

    from secret_gate.cli import main

    monkeypatch.setattr("sys.stdin", io.StringIO(payload if isinstance(payload, str) else json.dumps(payload)))
    code = main(argv)
    captured = capsys.readouterr()
    return code, (json.loads(captured.out) if captured.out.strip() else None), captured.err


def test_cli_register_and_release(gate_home, monkeypatch, capsys, portal_pass, other_keypair):
    from secret_gate.policy import SecretPayload
    from secret_gate.tokens import make_token

    foreign = make_token(other_keypair.public, SecretPayload.create(value="x" * 8, hosts=[HOST], uses=[USE_HTTP], label="f/x"))
    code, out, _ = _cli(monkeypatch, capsys, ["refs", "register"], {"scope": SCOPE_A, "tokens": [portal_pass, foreign, 7]})
    assert code == 1 and len(out["refs"]) == 3
    first = out["refs"][0]
    assert first["label"] == fs.PORTAL.label and first["uses"] == [USE_HTTP] and is_ref(first["ref"])
    assert "error" in out["refs"][1] and "error" in out["refs"][2] and foreign not in json_dump(out)
    code, again, _ = _cli(monkeypatch, capsys, ["refs", "register"], {"scope": SCOPE_A, "tokens": [portal_pass]})
    assert code == 0 and again["refs"][0]["ref"] == first["ref"]
    assert Resolver.from_home(gate_home, scope=SCOPE_A).resolve(first["ref"], use=USE_HTTP, host=HOST).value == fs.PORTAL.password
    assert _cli(monkeypatch, capsys, ["refs", "release"], {"scope": SCOPE_A})[:2] == (0, {"released": 1})
    code, out, err = _cli(monkeypatch, capsys, ["refs", "register"], {"scope": SCOPE_A, "tokens": [portal_pass]})
    assert code == 2 and out is None and "released" in err


@pytest.mark.parametrize("payload", ["not json", {"scope": SCOPE_A}, {"scope": "bad", "tokens": []},
                                     {"scope": SCOPE_A, "tokens": "x"}, {"scope": SCOPE_A, "tokens": ["a"] * 257},
                                     {"scope": SCOPE_A, "tokens": [], "extra": 1}])
def test_cli_register_rejects_bad_requests(gate_home, monkeypatch, capsys, payload):
    code, out, err = _cli(monkeypatch, capsys, ["refs", "register"], payload)
    assert code == 2 and out is None and err.startswith("error:")


def test_cli_request_size_limit(gate_home, monkeypatch, capsys):
    code, _, err = _cli(monkeypatch, capsys, ["refs", "release"], "x" * ((1 << 20) + 1))
    assert code == 2 and "too large" in err


def json_dump(value) -> str:
    import json

    return json.dumps(value)


def test_lookup_itself_expires_old_references(registry, clock, portal_pass):
    ref = registry.register(SCOPE_A, portal_pass, fs.PORTAL.label)
    clock.now += REF_MAX_AGE_SECONDS + 1
    with pytest.raises(RefError, match="expired"):
        registry.lookup(SCOPE_A, ref)
