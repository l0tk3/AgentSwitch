#!/usr/bin/env bash
# End to end (docs/app-v0.md §7): the phone's client code (AgentSwitchKit) against the runtime bundled in
# AgentSwitch.app. Starts the bundled gate and daemon with throw-away homes, non-default ports, echo router and
# executors, asks the Mac side for a pairing link, runs LiveDaemonTests with it, and stops everything.
# Never touches ~/.secret-gate or a daemon/gate you already run. Build the app first: packages/mac-app/scripts/build-app.sh
set -euo pipefail
cd "$(dirname "$0")/.."
APP="${APP:-../mac-app/build/AgentSwitch.app}"
RUNTIME="$APP/Contents/Resources/runtime"
[ -x "$RUNTIME/node/bin/node" ] || { echo "no bundled runtime at $RUNTIME; run packages/mac-app/scripts/build-app.sh" >&2; exit 1; }
LOCAL=${LOCAL:-4911} REMOTE=${REMOTE:-4913} GATE=${GATE:-8190} OPENCODE=${OPENCODE:-4914}
WORK="$(mktemp -d "${TMPDIR:-/tmp}/agentswitch-e2e.XXXXXX")"
mkdir -p "$WORK/as-home" "$WORK/sg-home" "$WORK/logs"
BASE_ENV=(HOME="$HOME" USER="$USER" TMPDIR="${TMPDIR:-/tmp}" LANG="${LANG:-en_US.UTF-8}")
GATE_ENV=("${BASE_ENV[@]}" PATH="$RUNTIME/python/bin:/usr/bin:/bin" SECRET_GATE_HOME="$WORK/sg-home")
pids=()
cleanup() {
  for pid in "${pids[@]}"; do kill -INT "$pid" 2>/dev/null || true; done
  sleep 1
  for pid in "${pids[@]}"; do kill -KILL "$pid" 2>/dev/null || true; done
  rm -rf "$WORK"
}
trap cleanup EXIT

for port in "$LOCAL" "$REMOTE" "$GATE" "$OPENCODE"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then echo "port $port is busy; set LOCAL/REMOTE/GATE/OPENCODE" >&2; exit 1; fi
done

env -i "${GATE_ENV[@]}" "$RUNTIME/python/bin/secret-gate" keys --json new default --use >/dev/null
env -i "${GATE_ENV[@]}" "$RUNTIME/python/bin/secret-gate" proxy --port "$GATE" >"$WORK/logs/gate.log" 2>&1 &
pids+=($!)
env -i "${BASE_ENV[@]}" PATH="/usr/bin:/bin:/usr/sbin:/sbin" \
  AGENTSWITCH_HOME="$WORK/as-home" AGENTSWITCH_PORT="$LOCAL" AGENTSWITCH_REMOTE=1 AGENTSWITCH_REMOTE_PORT="$REMOTE" \
  AGENTSWITCH_OPENCODE_PORT="$OPENCODE" AGENTSWITCH_EXECUTORS=echo AGENTSWITCH_ROUTER=echo AGENTSWITCH_REMOTE_NAME="E2E Mac" \
  SECRET_GATE_HOME="$WORK/sg-home" SECRET_GATE_BIN="$RUNTIME/python/bin/secret-gate" SECRET_GATE_PROXY="http://127.0.0.1:$GATE" \
  "$RUNTIME/node/bin/node" --no-warnings=ExperimentalWarning "$RUNTIME/daemon/dist/cli.js" serve >"$WORK/logs/daemon.log" 2>&1 &
pids+=($!)

for _ in $(seq 1 120); do curl -sf "http://127.0.0.1:$LOCAL/healthz" >/dev/null && break; sleep 0.5; done
curl -sf "http://127.0.0.1:$LOCAL/healthz" >/dev/null || { echo "daemon did not come up:" >&2; tail -20 "$WORK/logs/daemon.log" >&2; exit 1; }
# The local API wants the token the daemon wrote on start-up (daemon api/localAuth.ts).
AUTH="Authorization: Bearer $(cat "$WORK/as-home/local-token")"
LINK="$(curl -sf -X POST -H "$AUTH" "http://127.0.0.1:$LOCAL/pairing" | "$RUNTIME/node/bin/node" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).link))')"
[ -n "$LINK" ] || { echo "no pairing link" >&2; exit 1; }

AGENTSWITCH_E2E_THROWAWAY=1 AGENTSWITCH_E2E_LINK="$LINK" swift test --filter LiveDaemonTests 2>&1 | tail -5
echo "devices after the test:"; curl -sf -H "$AUTH" "http://127.0.0.1:$LOCAL/devices" | "$RUNTIME/node/bin/node" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>{for(const d of JSON.parse(s))console.log(`  ${d.name} (${d.platform}) revoked=${d.revokedAt!==null}`)})'
