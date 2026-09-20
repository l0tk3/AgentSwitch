"""The shipped agent configs must set BOTH proxy variable cases.

curl ignores uppercase HTTP_PROXY for http:// targets (httpoxy mitigation), so an
uppercase-only config silently bypasses the gate. Found by scripts/claude_code_e2e.py.
"""
import json
import re
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parent.parent
REQUIRED = ("HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy")


def test_env_sh_exports_both_cases():
    text = (ROOT / "scripts" / "env.sh").read_text()
    exported = set(re.findall(r"\b([A-Za-z_]+)=", text))
    assert set(REQUIRED) <= exported


def test_claude_code_snippet_has_both_cases():
    env = json.loads((ROOT / "config" / "claude-code.settings.snippet.json").read_text())["env"]
    assert set(REQUIRED) <= set(env)
    assert env["HTTP_PROXY"] == env["http_proxy"]
    assert env["HTTPS_PROXY"] == env["https_proxy"]


def test_codex_snippet_has_both_cases():
    text = (ROOT / "config" / "codex.config.snippet.toml").read_text()
    for name in REQUIRED:
        assert re.search(rf"\b{name}\s*=", text), name


@pytest.mark.parametrize("name", ["codex.config.snippet.toml", "opencode.snippet.json"])
def test_snippets_point_at_this_package(name):
    text = (ROOT / "config" / name).read_text()
    assert "packages/secret-gate/.venv/bin/secret-gate" in text


def test_no_proxy_never_excludes_loopback_ip():
    """127.0.0.1 must not be in NO_PROXY: local test sites and the e2e rely on going through the gate."""
    env = json.loads((ROOT / "config" / "claude-code.settings.snippet.json").read_text())["env"]
    assert "127.0.0.1" not in env["NO_PROXY"]


def test_opencode_snippet_mcp_env_and_key_guard():
    cfg = json.loads((ROOT / "config" / "opencode.snippet.json").read_text())
    server = cfg["mcp"]["secret-gate"]
    assert server["type"] == "local"
    assert "SECRET_GATE_HOME" in server["environment"]
    denied_reads = [k for k, v in cfg["permission"]["read"].items() if v == "deny"]
    assert any(".secret-gate" in k for k in denied_reads)


def test_codex_snippet_mcp_env():
    text = (ROOT / "config" / "codex.config.snippet.toml").read_text()
    assert "[mcp_servers.secret-gate.env]" in text and "SECRET_GATE_HOME" in text
    assert "network_access = true" in text


def test_browser_demo_overrides_global_permission_mode():
    """A global defaultMode of "dontAsk" silently denies every tool the demo needs (seen in a
    real session: Playwright, secret-gate and Bash all refused). The demo must pin the mode and
    pre-allow its own tools, and must not offer the un-proxied Chrome integration."""
    text = (ROOT / "scripts" / "browser_demo.sh").read_text()
    assert '"defaultMode": "default"' in text
    assert "--permission-mode default" in text
    assert "--no-chrome" in text
    for rule in ("mcp__playwright", "mcp__secret-gate", "Bash(curl *)"):
        assert rule in text, rule


def test_opencode_browser_demo_config():
    """OpenCode demo: proxy in both cases for the bash tool, loopback + DeepSeek kept direct, the
    Playwright MCP process itself un-proxied (npx hangs behind the gate), webfetch denied because
    OpenCode's fetch does not honour the proxy, and no touch of ~/.config/opencode."""
    text = (ROOT / "scripts" / "opencode_browser_demo.sh").read_text()
    for name in REQUIRED:
        assert re.search(rf"\b{name}=", text), name
    assert "127.0.0.1" in text and "api.deepseek.com" in text
    assert '"webfetch": "deny"' in text
    assert '"$SECRET_GATE_HOME/*": "deny"' in text
    assert "--standalone" in text
    assert 'export PWD="$WORK"' in text
    assert ".config/opencode" not in text.split("set -euo pipefail")[1]


def test_codex_browser_demo_config():
    """Codex demo: proxy only inside [shell_environment_policy] set (both cases), never exported
    into the codex process (its websocket would be captured); sandbox network on; private
    CODEX_HOME with a 0600 auth copy that is removed on exit; no dangerous bypass flag."""
    text = (ROOT / "scripts" / "codex_browser_demo.sh").read_text()
    set_line = re.search(r"^set = \{(.*)\}$", text, re.M).group(1)
    for name in ("HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy"):
        assert f"{name} = " in set_line, name
    body = text.split("set -euo pipefail")[1]
    assert not re.search(r"^\s*export\s+(HTTP|HTTPS|http|https)_PROXY", body, re.M)
    assert "unset HTTP_PROXY http_proxy HTTPS_PROXY https_proxy" in body
    assert "network_access = true" in body
    assert "[mcp_servers.playwright]" in body and "[mcp_servers.secret-gate]" in body
    assert 'chmod 600 "$CODEX_HOME/auth.json"' in body
    assert "trap 'rm -rf \"$CODEX_HOME\"' EXIT" in body
    assert "dangerously" not in body
    assert "~/.codex/config.toml" not in body


@pytest.mark.parametrize("script", ["browser_demo.sh", "opencode_browser_demo.sh", "codex_browser_demo.sh"])
def test_demos_run_playwright_behind_the_gate(script):
    """Every demo must launch Playwright MCP through `secret-gate browser` so secret_fill exists,
    snapshots are redacted and browser_evaluate is hidden. A raw npx entry would type tokens
    verbatim into the page and let the model read the DOM."""
    text = (ROOT / "scripts" / script).read_text()
    assert "@playwright/mcp@" in text
    assert re.search(r'"browser",\s*"--",?\s*\n?\s*"npx"', text), "playwright must be wrapped by secret-gate browser"
    assert not re.search(r'command(\s*=\s*|":\s*)"npx"', text)
