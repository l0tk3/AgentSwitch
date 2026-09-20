#!/usr/bin/env bash
# Launch an interactive Claude Code session whose browser (Playwright MCP) goes through the gate.
#
#   scripts/browser_demo.sh https://portal-a.example.com [more-origins...]
#
# Prerequisites (see README "Setup"): `secret-gate keygen` done and `secret-gate proxy` running on
# $GATE_PORT (default 8080) with the same SECRET_GATE_HOME as this shell.
#
# What it sets up, all in a throw-away work dir under $TMPDIR:
#   * Playwright MCP behind secret-gate browser: separate Chromium profile, proxy = gate, https errors ignored (so the
#     mitmproxy CA does not need to be trusted), navigation restricted to the origins you list.
#   * secret-gate MCP (secret_describe / secret_otp / secret_http / secret_exec).
#   * Bash tools also go through the gate; ~/.secret-gate is deny-listed for Read.
#   * CLAUDE.md = AGENTS.md (how to treat enc:v1: values).
# Your ~/.claude settings are not touched: everything is passed with --settings / --mcp-config.
# Permission mode is forced to "default" (prompt for anything not allowed) because a global
# defaultMode of "dontAsk" would otherwise silently deny every Playwright/secret-gate/Bash call.
# Playwright and secret-gate tools plus curl are pre-allowed; everything else prompts.
# Claude in Chrome is disabled (--no-chrome) so the model uses the proxied Playwright browser.
#
# Playwright MCP runs behind `secret-gate browser`: enc:v1: values typed into the page are swapped
# for the real value by the gate (secret_fill / browser_type / browser_fill_form), snapshots are
# redacted, and JS evaluation / file output / screenshots-with-values are blocked. The gate strips
# the proxy from the Playwright process env (npx would hang behind the gate); the browser still
# uses --proxy-server. First run needs the package cached: `npx -y @playwright/mcp@0.0.82 --help`.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
GATE="$ROOT/.venv/bin/secret-gate"
GATE_PORT="${GATE_PORT:-8080}"
export SECRET_GATE_HOME="${SECRET_GATE_HOME:-$HOME/.secret-gate}"
PROXY="http://127.0.0.1:$GATE_PORT"
PW_MCP_VERSION="${PW_MCP_VERSION:-0.0.82}"

if [ $# -lt 1 ]; then
  echo "usage: $0 https://site.example.com [https://login.site.example.com ...]" >&2; exit 2
fi
if ! nc -z 127.0.0.1 "$GATE_PORT" 2>/dev/null; then
  echo "gate proxy not listening on $PROXY; start it: $GATE proxy -p $GATE_PORT" >&2; exit 1
fi
if ! "$GATE" keys --json 2>/dev/null | grep -q '"current": true'; then
  echo "no current keypair in $SECRET_GATE_HOME; create one in the UI or run: $GATE keys new work --use" >&2; exit 1
fi

ORIGINS="$(IFS=';'; echo "$*")"
WORK="$(mktemp -d "${TMPDIR:-/tmp}/sg-browser-demo.XXXX")"
PROFILE="$WORK/chromium-profile"
cp "$ROOT/AGENTS.md" "$WORK/CLAUDE.md"

cat > "$WORK/settings.json" <<EOF
{
  "env": {
    "SECRET_GATE_HOME": "$SECRET_GATE_HOME",
    "HTTP_PROXY": "$PROXY", "http_proxy": "$PROXY",
    "HTTPS_PROXY": "$PROXY", "https_proxy": "$PROXY",
    "NO_PROXY": "api.anthropic.com,.anthropic.com,claude.ai,.claude.ai,.statsig.com,.sentry.io",
    "no_proxy": "api.anthropic.com,.anthropic.com,claude.ai,.claude.ai,.statsig.com,.sentry.io"
  },
  "permissions": {
    "defaultMode": "default",
    "allow": ["mcp__playwright", "mcp__secret-gate", "Bash(curl *)"],
    "deny": ["Read($SECRET_GATE_HOME/**)", "Bash(cat $SECRET_GATE_HOME/*)", "Bash(secret-gate keygen*)"]
  }
}
EOF

cat > "$WORK/mcp.json" <<EOF
{
  "mcpServers": {
    "secret-gate": {"command": "$GATE", "args": ["mcp"], "env": {"SECRET_GATE_HOME": "$SECRET_GATE_HOME"}},
    "playwright": {
      "command": "$GATE",
      "args": ["browser", "--",
               "npx", "-y", "--prefer-offline", "@playwright/mcp@$PW_MCP_VERSION",
               "--proxy-server=$PROXY",
               "--ignore-https-errors",
               "--user-data-dir=$PROFILE",
               "--allowed-origins=$ORIGINS"],
      "env": {"SECRET_GATE_HOME": "$SECRET_GATE_HOME"}
    }
  }
}
EOF

cat <<EOF
work dir : $WORK
origins  : $ORIGINS
proxy    : $PROXY   (gate home: $SECRET_GATE_HOME)

Make tokens first, e.g.:
  $GATE enc --label site/pass --host <host> --host <login-host>
  $GATE enc --label site/totp --kind totp --use otp
Then in the session say something like:
  打开 <url>，用户名 <user>，密码 enc:v1:...，验证码用 secret_otp 从 enc:v1:... 取，登录后告诉我首页标题。

Launching claude ...
EOF
cd "$WORK"
exec claude --no-chrome --permission-mode default \
  --settings "$WORK/settings.json" --mcp-config "$WORK/mcp.json" --strict-mcp-config
