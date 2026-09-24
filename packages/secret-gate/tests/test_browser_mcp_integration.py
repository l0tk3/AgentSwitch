"""End to end over real MCP stdio: client -> `secret-gate browser` -> fake Playwright MCP process."""

from __future__ import annotations

import asyncio
import json
import os
import sys
from pathlib import Path

import pytest
from mcp import ClientSession, StdioServerParameters, types
from mcp.client.stdio import stdio_client

from secret_gate.browser_mcp import PROXY_VARS, downstream_command, downstream_env, parse_command, private_output_dir
from secret_gate.errors import ValidationError
from tests.fixtures import fake_secrets as fs

FAKE = Path(__file__).parent / "fixtures" / "fake_playwright_mcp.py"
PAGE = "https://login.portal-a.example.com/signin"


def test_downstream_env_strips_proxy_vars():
    env = {"PATH": "/bin", "HTTP_PROXY": "http://127.0.0.1:8080", "https_proxy": "x", "ALL_PROXY": "y"}
    out = downstream_env(env)
    assert out == {"PATH": "/bin"}
    assert env["HTTP_PROXY"]  # input untouched
    assert not (set(downstream_env()) & set(PROXY_VARS))


def test_downstream_command_forces_private_output_dir(tmp_path):
    out = private_output_dir(tmp_path / "home")
    assert out.is_dir() and (out.stat().st_mode & 0o777) == 0o700
    assert downstream_command(["npx", "pw"], out) == ["npx", "pw", f"--output-dir={out}"]
    assert downstream_command(["npx", "pw", "--output-dir=/x"], out) == ["npx", "pw", "--output-dir=/x"]
    assert downstream_command(["npx", "--output-dir", "/x"], out) == ["npx", "--output-dir", "/x"]


def test_parse_command():
    assert parse_command(["--", "npx", "-y", "pw"]) == ["npx", "-y", "pw"]
    assert parse_command(["npx"]) == ["npx"]
    with pytest.raises(ValidationError):
        parse_command(["--"])


def _params(gate_home: Path, log: Path, **extra: str) -> StdioServerParameters:
    env = {**os.environ, "SECRET_GATE_HOME": str(gate_home), "FAKE_PW_LOG": str(log),
           "HTTP_PROXY": "http://127.0.0.1:1", **extra}  # the proxy would break the child if it leaked through
    return StdioServerParameters(
        command=sys.executable,
        args=["-m", "secret_gate.cli", "browser", "--", sys.executable, str(FAKE)],
        env=env,
    )


def _text(result: types.CallToolResult) -> str:
    return "\n".join(c.text for c in result.content if isinstance(c, types.TextContent))


def test_fill_through_real_mcp_processes(gate_home, tmp_path, portal_pass, portal_user):
    log = tmp_path / "fills.jsonl"

    async def scenario() -> dict:
        async with stdio_client(_params(gate_home, log)) as (read, write), ClientSession(read, write) as s:
            await asyncio.wait_for(s.initialize(), 30)
            names = {t.name for t in (await s.list_tools()).tools}
            await s.call_tool("browser_navigate", {"url": PAGE})
            fill = await s.call_tool("secret_fill", {"target": "e1", "token": portal_pass, "submit": True})
            form = await s.call_tool("browser_fill_form", {"fields": [
                {"target": "e2", "name": "u", "type": "textbox", "value": portal_user}]})
            snap = await s.call_tool("browser_snapshot", {})
            shot = await s.call_tool("browser_take_screenshot", {})
            unsafe = await s.call_tool("browser_run_code_unsafe", {"code": "1"})
            data_tab = await s.call_tool("browser_tabs", {"action": "new", "url": "data:text/html,<textarea>"})
            copy = await s.call_tool("browser_press_key", {"key": "Meta+c"})
            upload = await s.call_tool("browser_file_upload", {"paths": ["page-1.yml"]})
            find = await s.call_tool("browser_find", {"text": fs.PORTAL.password[:5]})
            await s.call_tool("browser_navigate", {"url": PAGE + "?next"})
            shot_after = await s.call_tool("browser_take_screenshot", {})
            leftovers = sorted(p.name for p in (gate_home / "browser-out").iterdir())
            return {"names": names, "fill": fill, "form": form, "snap": snap, "shot": shot, "unsafe": unsafe,
                    "data_tab": data_tab, "copy": copy, "upload": upload, "find": find,
                    "shot_after": shot_after, "leftovers": leftovers}

    r = asyncio.run(asyncio.wait_for(scenario(), 90))
    assert "secret_fill" in r["names"] and "browser_evaluate" not in r["names"]
    assert not r["fill"].isError and not r["form"].isError
    for res in (r["fill"], r["form"]):
        assert fs.PORTAL.password not in _text(res) and fs.PORTAL.username not in _text(res)
        assert "Ran Playwright code" not in _text(res) and ".yml" not in _text(res)
    events = [json.loads(line) for line in log.read_text().splitlines()]
    assert {e["text"] for e in events} == {fs.PORTAL.password, fs.PORTAL.username}
    assert events[0]["submit"] is True
    assert {e["cwd"] for e in events} == {str(gate_home / "browser-out")}  # fake ran in the private dir
    assert r["leftovers"] == []  # every page-*.yml the fake wrote was swept
    snap_text = _text(r["snap"])
    assert fs.PORTAL.password not in snap_text and fs.PORTAL.username not in snap_text
    assert f"[REDACTED:{fs.PORTAL.label}]" in snap_text and "[REDACTED:portal-a/user]" in snap_text
    # The page shows both values: the capture is masked (e1, e2, password inputs) and verified.
    assert not r["shot"].isError and "masked 3 region" in _text(r["shot"])
    assert any(isinstance(c, types.ImageContent) for c in r["shot"].content)
    assert '"current": "nonempty"' in _text(r["fill"])
    assert r["unsafe"].isError and "disabled" in _text(r["unsafe"])
    for key, needle in (("data_tab", "http(s)"), ("copy", "copy/cut"), ("upload", "uploading"), ("find", "matches part")):
        assert r[key].isError and needle in _text(r[key]), key
    assert not r["shot_after"].isError


def test_wrong_host_never_reaches_fake_browser(gate_home, tmp_path, bank_pass):
    log = tmp_path / "fills.jsonl"

    async def scenario():
        async with stdio_client(_params(gate_home, log)) as (read, write), ClientSession(read, write) as s:
            await asyncio.wait_for(s.initialize(), 30)
            await s.call_tool("browser_navigate", {"url": PAGE})
            return await s.call_tool("browser_type", {"target": "pw", "text": bank_pass})

    r = asyncio.run(asyncio.wait_for(scenario(), 90))
    assert r.isError
    assert "host" in _text(r).lower()
    assert fs.BANK.password not in _text(r)
    assert not log.exists()


def test_transfer_grant_seals_page_data_into_references_end_to_end(gate_home, tmp_path):
    log = tmp_path / "fills.jsonl"
    email = "alice.demo@example.com"
    grant = {"source": ["login.portal-a.example.com"], "destination": ["erp.example.test"], "fields": ["email"],
             "purpose": "register the customer's contact e-mail in the ERP"}
    params = _params(gate_home, log, SECRET_GATE_SCOPE="e2e-scope-0123456789abcdefgh", SECRET_GATE_TRANSFER=json.dumps(grant),
                     FAKE_PW_PAGE_TEXT=f"Contact {email}")

    async def scenario() -> dict:
        async with stdio_client(params) as (read, write), ClientSession(read, write) as s:
            await asyncio.wait_for(s.initialize(), 30)
            await s.call_tool("browser_navigate", {"url": PAGE})
            source = _text(await s.call_tool("browser_snapshot", {}))
            ref = next(w for w in source.split() if w.startswith("enc:ref:"))
            wrong = await s.call_tool("secret_fill", {"target": "e1", "token": ref})  # still on the source host
            await s.call_tool("browser_navigate", {"url": "https://erp.example.test/customers/new"})
            fill = await s.call_tool("secret_fill", {"target": "e1", "token": ref})
            dest = _text(await s.call_tool("browser_snapshot", {}))
            return {"source": source, "ref": ref, "wrong": wrong, "fill": fill, "dest": dest}

    r = asyncio.run(asyncio.wait_for(scenario(), 90))
    assert email not in r["source"] and "page/email-1" in r["source"] and "erp.example.test" in r["source"]
    assert r["wrong"].isError and "not allowed on host" in _text(r["wrong"])
    assert not r["fill"].isError and email not in _text(r["fill"])
    assert email not in r["dest"] and r["ref"] in r["dest"]
    typed = [json.loads(line) for line in log.read_text().splitlines()]
    assert [e["text"] for e in typed] == [email]  # the destination page received the real value
    audit = (gate_home / "logs" / "browser-audit.jsonl").read_text()
    assert email not in audit and '"event": "seal"' in audit and '"event": "fill"' in audit and "e2e-scope" not in audit


def test_transfer_grant_without_scope_is_not_applied(gate_home, tmp_path):
    from secret_gate.browser_mcp import execution_config

    grant = json.dumps({"source": ["a.example.com"], "destination": ["b.example.com"], "fields": ["phone"], "purpose": "x"})
    assert execution_config({"SECRET_GATE_TRANSFER": grant}, gate_home) == (None, None, None)
    scope, parsed, key = execution_config({"SECRET_GATE_TRANSFER": grant, "SECRET_GATE_SCOPE": "s" * 32}, gate_home)
    assert scope == "s" * 32 and parsed.destination == ("b.example.com",) and len(key) == 32
    assert execution_config({}, gate_home) == (None, None, None)
    bad = json.dumps({"source": ["-a.example.com"], "destination": ["b.example.com"], "fields": ["phone"], "purpose": "x"})
    assert execution_config({"SECRET_GATE_TRANSFER": bad, "SECRET_GATE_SCOPE": "s" * 32}, gate_home) == ("s" * 32, None, None)
    env = downstream_env({"SECRET_GATE_SCOPE": "x", "SECRET_GATE_TRANSFER": "y", "PATH": "/bin"})
    assert env == {"PATH": "/bin"}
