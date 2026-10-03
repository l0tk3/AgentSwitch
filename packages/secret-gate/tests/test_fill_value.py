"""`secret-gate fill-value`: a person's Fill Ciphertext in AgentSwitch's shared browser (docs/browser-v0.md §1).

The value comes back only for use fill and only when the focused field's frame and every frame above it are on hosts
the ciphertext allows; it is on stdout and nowhere else (not the audit, not an error)."""

from __future__ import annotations

import io
import json

import pytest

from secret_gate.constants import USE_EXEC, USE_FILL, USE_HTTP
from secret_gate.keystore import load_public_key
from secret_gate.policy import SecretPayload
from secret_gate.refs import new_ref
from secret_gate.rpc_protocol import RemoteError
from secret_gate.tokens import make_token
from tests.fixtures import fake_secrets as fs
from tests.service_fixtures import running_service

LOGIN = "https://login.portal-a.example.com/login?next=%2F"


def _cli(monkeypatch, capsys, payload):
    from secret_gate.cli import main

    monkeypatch.setattr("sys.stdin", io.StringIO(payload if isinstance(payload, str) else json.dumps(payload)))
    code = main(["fill-value"])
    captured = capsys.readouterr()
    return code, (json.loads(captured.out) if captured.out.strip() else None), captured.err


def _audit(home) -> list[dict]:
    path = home / "logs" / "browser-audit.jsonl"
    return [json.loads(line) for line in path.read_text().splitlines()] if path.exists() else []


def test_fill_value_is_fill_only_host_checked_for_every_frame_and_never_recorded(gate_home, monkeypatch, capsys, portal_pass, keypair):
    code, out, _ = _cli(monkeypatch, capsys, {"token": portal_pass, "urls": [LOGIN]})
    assert code == 0 and out == {"value": fs.PORTAL.password, "label": fs.PORTAL.label}
    # A field in an allowed frame of an allowed page: both hosts checked.
    code, out, _ = _cli(monkeypatch, capsys, {"token": portal_pass, "urls": ["https://portal-a.example.com/frame", LOGIN]})
    assert code == 0 and out["value"] == fs.PORTAL.password
    refusals = [
        ([LOGIN, "https://evil.example/"], "not allowed on host"),                    # an allowed iframe in a foreign page
        (["https://evil.example/frame", LOGIN], "not allowed on host"),               # a foreign iframe in an allowed page
        (["https://evil.example/"], "not allowed on host"),
        (["about:srcdoc", LOGIN], "non-http page"),
        (["file:///etc/passwd"], "non-http page"),
    ]
    for urls, why in refusals:
        code, out, err = _cli(monkeypatch, capsys, {"token": portal_pass, "urls": urls})
        assert code == 2 and out is None and why in err, urls
        assert fs.PORTAL.password not in err
    exec_only = make_token(keypair.public, SecretPayload.create(value="db-secret-1", hosts=[], uses=[USE_EXEC], label="db/pw"))
    code, out, err = _cli(monkeypatch, capsys, {"token": exec_only, "urls": [LOGIN]})
    assert code == 2 and out is None and "does not allow use" in err
    lines = _audit(gate_home)
    assert [line["event"] for line in lines] == ["fill", "fill"] + ["refused"] * (len(refusals) + 1)
    assert lines[0]["host"] == "login.portal-a.example.com:443" and lines[0]["labels"] == [fs.PORTAL.label] and lines[0]["by"] == "person"
    assert lines[1]["frames"] == ["portal-a.example.com:443", "login.portal-a.example.com:443"]
    text = (gate_home / "logs" / "browser-audit.jsonl").read_text()
    assert fs.PORTAL.password not in text and portal_pass not in text


@pytest.mark.parametrize("payload", [
    "not json", {"token": "x"}, {"token": "enc:v1:abc", "urls": [LOGIN]}, {"urls": [LOGIN], "token": 1},
    {"token": None, "urls": []}, {"token": "t", "urls": "https://a/"}, {"token": "t", "urls": [LOGIN] * 17},
    {"token": "t", "urls": [LOGIN], "extra": 1}, "x" * ((1 << 17) + 1),
])
def test_fill_value_rejects_bad_requests(gate_home, monkeypatch, capsys, payload):
    code, out, err = _cli(monkeypatch, capsys, payload)
    assert code == 2 and out is None and err.startswith("error:")


def test_fill_value_refuses_references_which_belong_to_a_task(gate_home, monkeypatch, capsys):
    code, out, err = _cli(monkeypatch, capsys, {"token": new_ref(), "urls": [LOGIN]})
    assert code == 2 and out is None and "belongs to one task" in err


def test_fill_value_through_the_gate_service_asks_browser_resolve_for_each_frame():
    from secret_gate.fill_cli import fill_value_remote

    with running_service() as svc:
        pub = load_public_key(svc.home)
        fill = make_token(pub, SecretPayload.create(value=fs.PORTAL.password, hosts=list(fs.PORTAL.hosts), uses=[USE_FILL], label="portal-a/fill"))
        http_only = make_token(pub, SecretPayload.create(value=fs.PORTAL.password, hosts=list(fs.PORTAL.hosts), uses=[USE_HTTP], label="portal-a/http"))

        def run(token, urls):
            import contextlib
            import sys

            out = io.StringIO()
            old = sys.stdin
            sys.stdin = io.StringIO(json.dumps({"token": token, "urls": urls}))
            try:
                with contextlib.redirect_stdout(out):
                    code = fill_value_remote(None, client=svc.client, public=svc.public)
            finally:
                sys.stdin = old
            return code, out.getvalue()

        code, out = run(fill, ["https://portal-a.example.com/f", LOGIN])
        assert code == 0 and json.loads(out) == {"value": fs.PORTAL.password, "label": "portal-a/fill"}
        with pytest.raises(RemoteError, match="does not allow use 'fill'"):
            run(http_only, [LOGIN])   # the service types only values sealed for filling
        with pytest.raises(RemoteError, match="not allowed on host"):
            run(fill, [LOGIN, "https://evil.example/"])
        resolves = [json.loads(line) for line in svc.audit.read_text().splitlines() if '"browser.resolve"' in line]
        assert [line["host"] for line in resolves[:2]] == ["portal-a.example.com:443", "login.portal-a.example.com:443"]
        assert fs.PORTAL.password not in svc.audit.read_text()
