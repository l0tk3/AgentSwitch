"""Authorized field transfer (gate-next-v0 §5.2): grant parsing, sealing in the browser gate, destination checks."""

from __future__ import annotations

import asyncio
import json

import pytest

from secret_gate.audit import Audit
from secret_gate.browser_gate import BrowserGate
from secret_gate.errors import ValidationError
from secret_gate.refs import RefRegistry
from secret_gate.resolver import Resolver
from secret_gate.transfer import TransferGrant, legend, seal_matches, show_sealed
from tests.test_browser_gate import FakePlaywright, texts

SOURCE = "https://crm.example.com/customers/42"
DEST = "https://erp.example.com:8443/customers/new"
SCOPE = "transfer-scope-0123456789abc"
EMAIL = "alice.demo@example.com"
PHONE = "13800138000"
GRANT = {"source": ["crm.example.com"], "destination": ["erp.example.com:8443"], "fields": ["email", "phone"],
         "purpose": "register the customer's contact details in the ERP"}


def grant(**changes) -> TransferGrant:
    return TransferGrant.parse(json.dumps({**GRANT, **changes}))


def run(coro):
    return asyncio.run(coro)


@pytest.fixture
def audit_path(tmp_path):
    return tmp_path / "logs" / "browser-audit.jsonl"


@pytest.fixture
def setup(keypair, tmp_path, audit_path):
    pw = FakePlaywright(SOURCE)
    pw.echo = f'- paragraph [ref=e9]: "Contact {EMAIL}, {PHONE}"'
    resolver = Resolver(keypair.private, refs=RefRegistry(tmp_path / "refs.sqlite3"), scope=SCOPE)
    gate = BrowserGate(resolver, pw, output_dir=None, transfer=grant(), public_key=keypair.public,
                       audit=Audit(audit_path, SCOPE))
    return gate, pw


def test_grant_parsing():
    g = grant()
    assert g.source == ("crm.example.com",) and g.destination == ("erp.example.com:8443",) and g.fields == ("email", "phone")
    assert g.is_source("crm.example.com:443") and not g.is_source("erp.example.com:8443")
    assert g.allows_destination("erp.example.com:8443") and not g.allows_destination("erp.example.com:443")
    assert "email, phone" in g.describe()


@pytest.mark.parametrize("bad", [
    "not json", "[]", json.dumps({**GRANT, "extra": 1}), json.dumps({k: v for k, v in GRANT.items() if k != "purpose"}),
    json.dumps({**GRANT, "source": ["*.example.com"]}), json.dumps({**GRANT, "destination": []}),
    json.dumps({**GRANT, "destination": ["https://erp.example.com/x"]}), json.dumps({**GRANT, "source": ["a.com"] * 9}),
    json.dumps({**GRANT, "fields": []}), json.dumps({**GRANT, "fields": ["password"]}), json.dumps({**GRANT, "fields": "email"}),
    json.dumps({**GRANT, "purpose": ""}), json.dumps({**GRANT, "purpose": "x" * 201}),
])
def test_invalid_grants_are_refused(bad):
    with pytest.raises(ValidationError):
        TransferGrant.parse(bad)


def test_grant_needs_scope_and_public_key(resolver, keypair):
    with pytest.raises(ValidationError, match="scope"):
        BrowserGate(resolver, FakePlaywright(), transfer=grant(), public_key=keypair.public)


def test_seal_matches_labels_per_kind_and_reuses_known_values():
    minted = []

    def mint(payload):
        minted.append(payload)
        return f"enc:ref:{len(minted):016d}"

    first = seal_matches(f"{EMAIL} {PHONE} bob@example.org", grant(), (), mint)
    assert [r.label for r in first] == ["page/email-1", "page/phone-1", "page/email-2"]
    assert all(p.hosts == ("erp.example.com:8443",) and p.uses == frozenset({"fill"}) for p in minted)
    again = seal_matches(f"{EMAIL} carol@example.net", grant(), first, mint)
    assert [r.label for r in again] == ["page/email-3"]
    shown = show_sealed(f"mail {EMAIL} / {EMAIL.replace('@', '%40')}", first)
    assert EMAIL not in shown and shown.count(first[0].token) == 2
    assert "erp.example.com:8443" in legend(first, grant())


def test_source_page_output_shows_references_and_legend(setup, audit_path):
    gate, pw = setup
    out = texts(run(gate.call_tool("browser_snapshot", {})))
    assert EMAIL not in out and PHONE not in out
    refs = [r.token for r in gate.state.sealed]
    assert len(refs) == 2 and all(ref in out for ref in refs)
    assert "sealed page data" in out and "erp.example.com:8443" in out
    log = audit_path.read_text()
    assert EMAIL not in log and PHONE not in log and SCOPE not in log and '"event": "seal"' in log


def test_sealed_reference_fills_only_on_destination_and_stays_hidden(setup):
    gate, pw = setup
    run(gate.call_tool("browser_snapshot", {}))
    email_ref = gate.state.sealed[0].token
    with pytest.raises(RuntimeError, match="not allowed on host"):
        run(gate.call_tool("secret_fill", {"target": "e1", "token": email_ref}))  # still on the source page
    pw.url, pw.echo = DEST, ""
    out = texts(run(gate.call_tool("secret_fill", {"target": "e1", "token": email_ref})))
    assert pw.typed["e1"] == EMAIL and EMAIL not in out
    snap = texts(run(gate.call_tool("browser_snapshot", {})))
    assert EMAIL not in snap and email_ref in snap  # the destination shows the reference, not the value


def test_sealed_value_cannot_leave_through_the_proxy_or_secret_http(setup):
    from secret_gate.constants import USE_HTTP
    from secret_gate.errors import PolicyViolation

    gate, pw = setup
    run(gate.call_tool("browser_snapshot", {}))
    email_ref = gate.state.sealed[0].token
    resolver = gate._resolver
    with pytest.raises(PolicyViolation, match="does not allow use 'http'"):
        resolver.resolve(email_ref, use=USE_HTTP, host="erp.example.com:8443")  # what the proxy and secret_http ask for


def test_sealed_reference_refused_when_form_submits_elsewhere(setup):
    gate, pw = setup
    run(gate.call_tool("browser_snapshot", {}))
    email_ref = gate.state.sealed[0].token
    pw.url, pw.echo = DEST, ""
    for action, needle in (("https://collector.example.net/x", "does not name"), ("javascript:void(0)", "non-http")):
        pw.form_action = action
        with pytest.raises(RuntimeError, match=needle):
            run(gate.call_tool("secret_fill", {"target": "e1", "token": email_ref}))
    pw.form_action = ""  # no form at all (a script submits): allowed, the host policy still applies
    run(gate.call_tool("secret_fill", {"target": "e1", "token": email_ref}))
    assert pw.typed == {"e1": EMAIL}


def test_sealed_values_are_protected_like_filled_ones(setup):
    gate, pw = setup
    run(gate.call_tool("browser_snapshot", {}))
    with pytest.raises(RuntimeError, match="matches part"):
        run(gate.call_tool("browser_find", {"text": EMAIL[:6]}))
    with pytest.raises(RuntimeError, match="copy/cut"):
        run(gate.call_tool("browser_press_key", {"key": "Control+c"}))


def test_no_sealing_outside_the_source_or_for_other_kinds(setup):
    gate, pw = setup
    pw.url = "https://other.example.com/"
    out = texts(run(gate.call_tool("browser_snapshot", {})))
    assert EMAIL in out and gate.state.sealed == ()  # not a source: shown as the page shows it
    pw.url, pw.echo = SOURCE, '- paragraph [ref=e9]: "ID 11010519491231002X"'
    out = texts(run(gate.call_tool("browser_snapshot", {})))
    assert "11010519491231002X" in out and gate.state.sealed == ()  # not a granted kind


def test_audit_log_is_private_and_best_effort(tmp_path, capsys):
    import stat

    path = tmp_path / "logs" / "a.jsonl"
    Audit(path, SCOPE).record("fill", host="x:443", ok=True)
    assert stat.S_IMODE(path.stat().st_mode) == 0o600 and json.loads(path.read_text())["event"] == "fill"
    Audit(None).record("ignored")
    blocked = tmp_path / "file"
    blocked.write_text("")
    Audit(blocked / "a.jsonl").record("x")
    assert "audit log not written" in capsys.readouterr().err


def test_reformatted_sealed_values_still_show_as_references(setup):
    gate, pw = setup
    run(gate.call_tool("browser_snapshot", {}))
    email_ref, phone_ref = (r.token for r in gate.state.sealed)
    pw.url, pw.echo = DEST, f'- paragraph [ref=e9]: "Saved: {EMAIL.upper()}, +86 138-0013-8000, other 13900000000"'
    out = texts(run(gate.call_tool("browser_snapshot", {})))
    assert EMAIL.upper() not in out and "138-0013-8000" not in out
    assert email_ref in out and phone_ref in out and "13900000000" in out  # not sealed, not a source: unchanged


def test_error_text_from_a_source_page_is_sealed(setup):
    gate, pw = setup

    async def failing(name, args):
        if name == "browser_click":
            from mcp import types
            return types.CallToolResult(content=[types.TextContent(type="text", text=f"### Error\n<span>{EMAIL}</span> intercepts pointer events")], isError=True)
        return await FakePlaywright.call_tool(pw, name, args)

    pw.call_tool = failing  # type: ignore[assignment]
    with pytest.raises(RuntimeError) as exc:
        run(gate.call_tool("browser_click", {"target": "e9"}))
    assert EMAIL not in str(exc.value) and "enc:ref:" in str(exc.value)
