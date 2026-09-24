"""Generated harness snippets: identical to the shipped config/ files for the placeholder paths, valid for real ones."""

from __future__ import annotations

import json
import shlex
import tomllib
from pathlib import Path

import pytest

from secret_gate.errors import ValidationError
from secret_gate.harness_config import (
    HARNESSES,
    GateContext,
    claude_code,
    codex,
    harness_config,
    opencode,
    opencode_launch_env,
)

ROOT = Path(__file__).resolve().parent.parent
PLACEHOLDER = GateContext(
    home=Path("/Users/YOU/.secret-gate"),
    port=8080,
    command=("/Users/YOU/Desktop/WorkSpace/Projects/AgentSwitch/packages/secret-gate/.venv/bin/secret-gate",),
    user_home=Path("/Users/YOU"),
)
PROXY_VARS = ("HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy", "NO_PROXY", "no_proxy")


def _custom(tmp_path: Path, command=("/opt/sg/bin/secret-gate",)) -> GateContext:
    return GateContext(home=tmp_path / "gate home", port=9443, command=command, user_home=Path("/Users/someone"))


def test_claude_code_matches_the_shipped_snippet():
    shipped = json.loads((ROOT / "config" / "claude-code.settings.snippet.json").read_text())
    assert json.loads(claude_code(PLACEHOLDER).snippet) == shipped


def test_opencode_matches_the_shipped_snippet():
    shipped = json.loads((ROOT / "config" / "opencode.snippet.json").read_text())
    assert json.loads(opencode(PLACEHOLDER).snippet) == shipped


def test_codex_matches_the_shipped_snippet():
    shipped = tomllib.loads((ROOT / "config" / "codex.config.snippet.toml").read_text())
    assert tomllib.loads(codex(PLACEHOLDER).snippet) == shipped


def test_claude_code_real_paths_outside_home(tmp_path):
    ctx = _custom(tmp_path)
    settings = json.loads(claude_code(ctx).snippet)
    env = settings["env"]
    assert env["SECRET_GATE_HOME"] == str(ctx.home)
    assert {env[v] for v in ("HTTP_PROXY", "http_proxy", "HTTPS_PROXY", "https_proxy")} == {"http://127.0.0.1:9443"}
    assert env["SSL_CERT_FILE"] == str(ctx.home / "ca.pem") == env["NODE_EXTRA_CA_CERTS"]
    assert "127.0.0.1" not in env["NO_PROXY"]                              # loopback sites go through the gate
    assert f"Read(/{ctx.home}/**)" in settings["permissions"]["deny"]        # `//abs` = absolute in Claude Code
    assert f"Bash(cat {ctx.home}/*)" in settings["permissions"]["deny"]


def test_claude_code_mcp_hint_runs_this_installation(tmp_path):
    ctx = _custom(tmp_path)
    hint = next(line for line in claude_code(ctx).apply if "claude mcp add" in line)
    argv = shlex.split(hint.split(": ", 1)[1])
    assert argv[-3:] == ["--", "/opt/sg/bin/secret-gate", "mcp"] and f"SECRET_GATE_HOME={ctx.home}" in argv


def test_codex_module_fallback_and_quoting(tmp_path):
    ctx = _custom(tmp_path, command=('/py "3"\\bin/python', "-m", "secret_gate.cli"))
    data = tomllib.loads(codex(ctx).snippet)
    server = data["mcp_servers"]["secret-gate"]
    assert server["command"] == '/py "3"\\bin/python'
    assert server["args"] == ["-m", "secret_gate.cli", "mcp"]
    assert server["env"]["SECRET_GATE_HOME"] == str(ctx.home)
    policy = data["shell_environment_policy"]["set"]
    assert set(PROXY_VARS) <= set(policy) and policy["https_proxy"] == "http://127.0.0.1:9443"
    assert data["sandbox_workspace_write"]["network_access"] is True


def test_opencode_real_paths_and_launch_env(tmp_path):
    ctx = _custom(tmp_path)
    cfg = json.loads(opencode(ctx).snippet)
    assert cfg["mcp"]["secret-gate"]["command"] == ["/opt/sg/bin/secret-gate", "mcp"]
    assert cfg["permission"]["read"][f"{ctx.home}/*"] == "deny"
    exports = dict(shlex.split(line)[1].split("=", 1) for line in opencode_launch_env(ctx))
    assert set(PROXY_VARS) <= set(exports)
    assert exports["SECRET_GATE_HOME"] == str(ctx.home)                     # survives the space in the path
    assert exports["NO_PROXY"].startswith("127.0.0.1,")                    # OpenCode CLI <-> server loopback


@pytest.mark.parametrize("harness", HARNESSES)
def test_every_harness_states_scope_and_where_it_goes(harness, tmp_path):
    config = harness_config(harness, _custom(tmp_path))
    assert config.harness == harness and config.scope and config.apply
    everything = config.snippet + "\n".join(config.apply)                  # OpenCode: port in the launch env
    assert "9443" in everything and "8080" not in everything


def test_unknown_harness():
    with pytest.raises(ValidationError, match="unknown harness"):
        harness_config("vim", PLACEHOLDER)
