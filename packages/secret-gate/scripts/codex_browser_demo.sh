#!/usr/bin/env bash
# Launch an interactive Codex (TUI) session whose browser (Playwright MCP) goes through the gate.
#
#   scripts/codex_browser_demo.sh http://site.example.com:8400 [more-origins...]
#   CODEX_BIN=/Applications/ChatGPT.app/Contents/Resources/codex-cli/bin/codex scripts/codex_browser_demo.sh ...
#
# Prerequisites (see README "Setup"): a current keypair (UI or `secret-gate keys new work --use`),
# `secret-gate proxy` running on $GATE_PORT (default 8080) with the same SECRET_GATE_HOME, and a
# logged-in codex (~/.codex/auth.json).
#
# What it sets up, all throw-away under $TMPDIR:
#   * A private CODEX_HOME holding a 0600 copy of auth.json (deleted when codex exits) and our
#     config.toml. Your real ~/.codex/config.toml is never loaded.
#   * config.toml: approval on-request, workspace-write sandbox with network_access (the sandbox
#     blocks localhost otherwise, so the gate would be unreachable), proxy for the shell tool via
#     [shell_environment_policy] set (both cases), MCP servers secret-gate and Playwright
#     behind `secret-gate browser` (secret_fill, redacted snapshots)
#     (separate Chromium profile, proxy = gate, https errors ignored, navigation restricted to
#     the origins you list).
#   * A work dir (git init so the TUI does not warn) with AGENTS.md = this package's AGENTS.md.
#
# The proxy is NOT exported into the codex process: its own websocket to chatgpt.com honours
# HTTP(S)_PROXY and would be captured by the gate. MCP servers inherit that clean env, so npx
# reaches the npm registry directly. First run needs the package cached:
# `npx -y @playwright/mcp@0.0.82 --help`.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GATE="$ROOT/.venv/bin/secret-gate"
CODEX="${CODEX_BIN:-$(command -v codex || true)}"
GATE_PORT="${GATE_PORT:-8080}"
export SECRET_GATE_HOME="${SECRET_GATE_HOME:-$HOME/.secret-gate}"
PROXY="http://127.0.0.1:$GATE_PORT"
PW_MCP_VERSION="${PW_MCP_VERSION:-0.0.82}"
MODEL="${SG_MODEL:-}"
AUTH_SRC="$HOME/.codex/auth.json"

if [ $# -lt 1 ]; then
  echo "usage: $0 https://site.example.com [https://login.site.example.com ...]" >&2; exit 2
fi
if [ -z "$CODEX" ] || [ ! -x "$CODEX" ]; then
  echo "codex not found (set CODEX_BIN)" >&2; exit 1
fi
if [ ! -f "$AUTH_SRC" ]; then
  echo "$AUTH_SRC not found; run: codex login" >&2; exit 1
fi
if ! nc -z 127.0.0.1 "$GATE_PORT" 2>/dev/null; then
  echo "gate proxy not listening on $PROXY; start it: $GATE proxy -p $GATE_PORT" >&2; exit 1
fi
if ! "$GATE" keys --json 2>/dev/null | grep -q '"current": true'; then
  echo "no current keypair in $SECRET_GATE_HOME; create one in the UI or run: $GATE keys new work --use" >&2; exit 1
fi

ORIGINS="$(IFS=';'; echo "$*")"
BASE="$(mktemp -d "${TMPDIR:-/tmp}/sg-codex-demo.XXXX")"
CODEX_HOME="$BASE/codex-home"
WORK="$BASE/work"
PROFILE="$BASE/chromium-profile"
mkdir -p "$CODEX_HOME" "$WORK"
chmod 700 "$CODEX_HOME"
cp "$AUTH_SRC" "$CODEX_HOME/auth.json"
chmod 600 "$CODEX_HOME/auth.json"
trap 'rm -rf "$CODEX_HOME"' EXIT   # the auth.json copy never outlives the session

cp "$ROOT/AGENTS.md" "$WORK/AGENTS.md"
git -C "$WORK" init -q 2>/dev/null || true

{
  echo 'approval_policy = "on-request"'
  echo 'sandbox_mode = "workspace-write"'
  [ -n "$MODEL" ] && echo "model = \"$MODEL\""
  cat <<TOML

[sandbox_workspace_write]
network_access = true

[shell_environment_policy]
inherit = "all"
set = { HTTP_PROXY = "$PROXY", http_proxy = "$PROXY", HTTPS_PROXY = "$PROXY", https_proxy = "$PROXY", SECRET_GATE_HOME = "$SECRET_GATE_HOME" }

[mcp_servers.secret-gate]
command = "$GATE"
args = ["mcp"]

[mcp_servers.secret-gate.env]
SECRET_GATE_HOME = "$SECRET_GATE_HOME"

[mcp_servers.playwright]
command = "$GATE"
args = ["browser", "--", "npx", "-y", "--prefer-offline", "@playwright/mcp@$PW_MCP_VERSION", "--proxy-server=$PROXY", "--ignore-https-errors", "--user-data-dir=$PROFILE", "--allowed-origins=$ORIGINS"]

[mcp_servers.playwright.env]
SECRET_GATE_HOME = "$SECRET_GATE_HOME"
TOML
} > "$CODEX_HOME/config.toml"

cat <<MSG
codex    : $CODEX ($("$CODEX" --version 2>/dev/null || echo '?'))
codex home: $CODEX_HOME   (auth copy removed on exit)
work dir : $WORK
origins  : $ORIGINS
proxy    : $PROXY   (gate home: $SECRET_GATE_HOME)

Make tokens first (UI, or):
  $GATE enc --label site/pass --host <host[:port]>
Then in the session say something like:
  打开 <url>，用户名 <user>，密码 enc:v1:...，登录后告诉我首页标题。

Launching codex ...
MSG

# Keep the gate proxy away from codex's own API/websocket traffic.
unset HTTP_PROXY http_proxy HTTPS_PROXY https_proxy ALL_PROXY all_proxy
cd "$WORK"
CODEX_HOME="$CODEX_HOME" "$CODEX" -C "$WORK"
