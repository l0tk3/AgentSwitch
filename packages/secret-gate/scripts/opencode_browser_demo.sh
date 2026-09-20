#!/usr/bin/env bash
# Launch an interactive OpenCode (TUI) session whose browser (Playwright MCP) goes through the gate.
#
#   scripts/opencode_browser_demo.sh http://site.example.com:8400 [more-origins...]
#
# Prerequisites (see README "Setup"): a current keypair (UI or `secret-gate keys new work --use`)
# and `secret-gate proxy` running on $GATE_PORT (default 8080) with the same SECRET_GATE_HOME.
# OpenCode needs a DeepSeek credential already configured (`opencode auth login`).
#
# What it sets up, all in a throw-away work dir under $TMPDIR:
#   * ./opencode.json: model $SG_MODEL (default deepseek/deepseek-flash), MCP servers secret-gate
#     and Playwright (separate Chromium profile, proxy = gate, https errors ignored, navigation
#     restricted to the origins you list), permissions: reading the gate home and keygen denied,
#     webfetch denied (it would bypass the proxy), everything else asks.
#   * ./AGENTS.md = this package's AGENTS.md (how to treat enc:v1: values).
#   * Process env: proxy (both cases) so the bash tool goes through the gate; NO_PROXY keeps the
#     CLI<->server loopback and the DeepSeek API direct; PWD = work dir (OpenCode reads it).
# Your ~/.config/opencode is not touched. --standalone avoids the background service, which
# would keep its own (proxy-less) environment.
#
# The Playwright MCP entry clears the proxy for its own process (npx would otherwise contact the
# npm registry through the gate and hang); the browser it launches still uses --proxy-server.
# First run needs the package cached: `npx -y @playwright/mcp@0.0.82 --help`.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GATE="$ROOT/.venv/bin/secret-gate"
OPENCODE="${OPENCODE_BIN:-$(command -v opencode || echo "$HOME/.opencode/bin/opencode")}"
GATE_PORT="${GATE_PORT:-8080}"
export SECRET_GATE_HOME="${SECRET_GATE_HOME:-$HOME/.secret-gate}"
PROXY="http://127.0.0.1:$GATE_PORT"
PW_MCP_VERSION="${PW_MCP_VERSION:-0.0.82}"
MODEL="${SG_MODEL:-deepseek/deepseek-flash}"
NO_PROXY_LIST="127.0.0.1,api.deepseek.com,.deepseek.com"

if [ $# -lt 1 ]; then
  echo "usage: $0 https://site.example.com [https://login.site.example.com ...]" >&2; exit 2
fi
if [ ! -x "$OPENCODE" ]; then
  echo "opencode not found (set OPENCODE_BIN)" >&2; exit 1
fi
if ! nc -z 127.0.0.1 "$GATE_PORT" 2>/dev/null; then
  echo "gate proxy not listening on $PROXY; start it: $GATE proxy -p $GATE_PORT" >&2; exit 1
fi
if ! "$GATE" keys --json 2>/dev/null | grep -q '"current": true'; then
  echo "no current keypair in $SECRET_GATE_HOME; create one in the UI or run: $GATE keys new work --use" >&2; exit 1
fi

ORIGINS="$(IFS=';'; echo "$*")"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/sg-opencode-demo.XXXX")"
PROFILE="$WORK/chromium-profile"
cp "$ROOT/AGENTS.md" "$WORK/AGENTS.md"

cat > "$WORK/opencode.json" <<JSON
{
  "\$schema": "https://opencode.ai/config.json",
  "model": "$MODEL",
  "mcp": {
    "secret-gate": {
      "type": "local",
      "command": ["$GATE", "mcp"],
      "enabled": true,
      "environment": {"SECRET_GATE_HOME": "$SECRET_GATE_HOME"}
    },
    "playwright": {
      "type": "local",
      "command": ["npx", "-y", "--prefer-offline", "@playwright/mcp@$PW_MCP_VERSION",
                  "--proxy-server=$PROXY",
                  "--ignore-https-errors",
                  "--user-data-dir=$PROFILE",
                  "--allowed-origins=$ORIGINS"],
      "enabled": true,
      "environment": {
        "HTTP_PROXY": "", "http_proxy": "", "HTTPS_PROXY": "", "https_proxy": "",
        "NO_PROXY": "*", "no_proxy": "*"
      }
    }
  },
  "permission": {
    "read": {"*": "allow", "$SECRET_GATE_HOME/*": "deny"},
    "bash": {"*": "ask", "curl *": "allow", "secret-gate keygen*": "deny", "cat $SECRET_GATE_HOME/*": "deny"},
    "edit": "ask",
    "webfetch": "deny"
  }
}
JSON

cat <<MSG
work dir : $WORK
origins  : $ORIGINS
model    : $MODEL
proxy    : $PROXY   (gate home: $SECRET_GATE_HOME)

Make tokens first (UI, or):
  $GATE enc --label site/pass --host <host[:port]>
Then in the session say something like:
  打开 <url>，用户名 <user>，密码 enc:v1:...，登录后告诉我首页标题。

Launching opencode ...
MSG

cd "$WORK"
export PWD="$WORK"
export HTTP_PROXY="$PROXY" http_proxy="$PROXY" HTTPS_PROXY="$PROXY" https_proxy="$PROXY"
export NO_PROXY="$NO_PROXY_LIST" no_proxy="$NO_PROXY_LIST"
exec "$OPENCODE" --standalone "$WORK"
