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


def _params(gate_home: Path, log: Path) -> StdioServerParameters:
    env = {**os.environ, "SECRET_GATE_HOME": str(gate_home), "FAKE_PW_LOG": str(log),
           "HTTP_PROXY": "http://127.0.0.1:1"}  # would break the child if it leaked through
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
            fill = await s.call_tool("secret_fill", {"target": "pw", "token": portal_pass, "submit": True})
            form = await s.call_tool("browser_fill_form", {"fields": [
                {"target": "user", "name": "u", "type": "textbox", "value": portal_user}]})
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
    assert r["shot"].isError and "screenshot refused" in _text(r["shot"])
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
