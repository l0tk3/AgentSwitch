#!/usr/bin/env bash
# Starts a runtime built by build-runtime.sh the way a node runs it — `agentswitch node run`, the keeper: the gate's
# keypair, the gate, the daemon — in a throw-away home on ports of its own, waits for the daemon to answer, asks
# `doctor`, draws `agentswitch config`'s first screen in a pseudo-terminal, and stops it. The node in use on this machine (its home, its ports, its service) is not touched. CI runs
# this on every runtime it builds (.github/workflows/ci.yml).
#
#   scripts/smoke.sh <runtime>     build-runtime.sh's <out>, or ~/.local/share/agentswitch/runtime/current
#   SMOKE_PORT=24711               the daemon's local port (default); OpenCode, remote and gate take the next three
#
# Agents and their sign-ins are each machine's own: doctor's agents and tools may be missing here; the runtime and the
# service must not be.
set -euo pipefail

[ -n "${1:-}" ] || { echo "usage: smoke.sh <runtime>" >&2; exit 2; }
R="$(cd "$1" && pwd)"
port="${SMOKE_PORT:-24711}"
work="$(mktemp -d "${TMPDIR:-/tmp}/agentswitch-smoke.XXXXXX")"
export HOME="$work/home" AGENTSWITCH_HOME="$work/home/.agentswitch" SECRET_GATE_HOME="$work/home/.secret-gate"
mkdir -p "$AGENTSWITCH_HOME"
printf '{"name":"smoke","ports":{"local":%d,"opencode":%d,"remote":%d,"gate":%d}}\n' \
  "$port" $((port + 1)) $((port + 2)) $((port + 3)) > "$AGENTSWITCH_HOME/node.json"

as() { "$R/node/bin/node" --no-warnings=ExperimentalWarning "$R/daemon/dist/cli.js" "$@"; }

# Node itself in the background, not `as` (a subshell there would take the signal, and the keeper would go on).
"$R/node/bin/node" --no-warnings=ExperimentalWarning "$R/daemon/dist/cli.js" node run > "$work/keeper.log" 2>&1 &
keeper=$!
stop() {
  kill -TERM "$keeper" 2>/dev/null || true
  for _ in $(seq 1 20); do kill -0 "$keeper" 2>/dev/null || break; sleep 0.5; done
  kill -KILL "$keeper" 2>/dev/null || true
  # SIGTERM has the keeper stop the daemon, then the gate; nothing of the throw-away node may stay.
  if command -v ss >/dev/null && ss -ltn | grep -qE ":($port|$((port + 1))|$((port + 2))|$((port + 3)))\b"; then
    echo "error: something still listens on the smoke node's ports after the keeper stopped" >&2
    ss -ltnp >&2 || true
    rm -rf "$work"
    exit 1
  fi
  rm -rf "$work"
}
trap stop EXIT

up=""
for _ in $(seq 1 90); do
  if curl -fsS -m 2 --noproxy '*' "http://127.0.0.1:$port/healthz" 2>/dev/null | grep -q '"ok":true'; then up=1; break; fi
  kill -0 "$keeper" 2>/dev/null || break
  sleep 1
done
if [ -z "$up" ]; then
  echo "error: the daemon did not answer on 127.0.0.1:$port; the keeper said:" >&2
  cat "$work/keeper.log" >&2
  exit 1
fi
echo "the daemon answers on 127.0.0.1:$port"

report="$(as doctor || true)"
echo "$report"
missing="$(echo "$report" | grep -E '^✗ (node|node-pty|secret-gate|node\.json|keeper|gate|daemon) ' || true)"
# The terminals' holder (docs/terminal-v0.md §10) is part of a runtime: without it terminals end with the service.
echo "$report" | grep -qE '^✓ pty-hold ' || missing="${missing:+$missing
}✗ pty-hold (not in the runtime)"
if [ -n "$missing" ]; then
  echo "error: the runtime or the service is not whole:" >&2
  echo "$missing" >&2
  echo "--- keeper log" >&2
  cat "$work/keeper.log" >&2
  exit 1
fi
# `agentswitch config` (docs/tui-v0.md) on a terminal of its own (`script`): its screen drawn from this node's
# profiles — the runtime's ink, react and yoga load — and Q leaves it.
if command -v script >/dev/null; then
  screen="$( (sleep 4; printf q) | timeout 30 script -qfec "'$R/node/bin/node' --no-warnings=ExperimentalWarning '$R/daemon/dist/cli.js' config --lang en" /dev/null 2>&1 || true)"
  if ! echo "$screen" | grep -q 'Default only, for now'; then
    echo "error: agentswitch config did not draw its first screen:" >&2
    echo "$screen" | tail -20 >&2
    exit 1
  fi
  echo "✓ config draws its screen"
fi
echo "smoke ok"
