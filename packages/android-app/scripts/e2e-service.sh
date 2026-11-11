#!/usr/bin/env bash
# A throw-away AgentSwitch service to try the phone app against (as ../ios-app/scripts/e2e-live.sh does for the
# iPhone's logic): the runtime bundled in AgentSwitch.app, started with throw-away homes on non-default ports, echo
# router and executors, and a home folder of its own. Prints a pairing link, then runs until interrupted. It never
# touches your home folder, the gate's real home or a daemon/gate you already run. Build the Mac app first: ../mac-app/scripts/build-app.sh
#
#   scripts/e2e-service.sh                 # prints the link; pair the emulator with
#   adb shell am start -n com.agentswitch.android/.MainActivity --es pairLink '<link>'
#
# LINK_FILE=<path>: the link is also written there. FAKE_AGENT=1: `claude` in a terminal is the daemon tests' stand-in
# (packages/daemon/tests/fixtures/fakeTerminalAgent.mjs), so terminals can be opened without any agent or model.
set -euo pipefail
cd "$(dirname "$0")/.."
APP="${APP:-../mac-app/build/AgentSwitch.app}"
RUNTIME="$APP/Contents/Resources/runtime"
[ -x "$RUNTIME/node/bin/node" ] || { echo "no bundled runtime at $RUNTIME; run packages/mac-app/scripts/build-app.sh" >&2; exit 1; }
RUNTIME="$(cd "$RUNTIME" && pwd)"
LOCAL=${LOCAL:-4911} REMOTE=${REMOTE:-4913} GATE=${GATE:-8190} OPENCODE=${OPENCODE:-4914}
# macOS ends TMPDIR in a slash; a home folder with `//` in its path is one the service refuses to list (bad-path).
TMP="${TMPDIR:-/tmp}"
WORK="$(mktemp -d "${TMP%/}/agentswitch-android-e2e.XXXXXX")"
mkdir -p "$WORK/as-home" "$WORK/sg-home" "$WORK/logs" "$WORK/bin" "$WORK/home/project"
# A home of its own: the service reads the agents' sessions and writes into the agents' own settings under HOME (Codex's
# trusted hooks, for one), and serves HOME's files to a paired phone — none of that is yours here.
BASE_ENV=(HOME="$WORK/home" USER="$USER" TMPDIR="${TMPDIR:-/tmp}" LANG="${LANG:-en_US.UTF-8}")
# SECRET_GATE_PUBLIC: an empty dir, so the CLI never finds an installed gate service's socket and works on the
# throw-away home.
GATE_ENV=("${BASE_ENV[@]}" PATH="$RUNTIME/python/bin:/usr/bin:/bin" SECRET_GATE_HOME="$WORK/sg-home" SECRET_GATE_PUBLIC="$WORK/no-gate-service")
pids=()
cleanup() {
  for pid in ${pids[@]+"${pids[@]}"}; do kill -INT "$pid" 2>/dev/null || true; done
  sleep 1
  for pid in ${pids[@]+"${pids[@]}"}; do kill -KILL "$pid" 2>/dev/null || true; done
  rm -rf "$WORK"
}
trap cleanup EXIT
trap 'exit 0' INT TERM

for port in "$LOCAL" "$REMOTE" "$GATE" "$OPENCODE"; do
  if lsof -nP -iTCP:"$port" -sTCP:LISTEN >/dev/null 2>&1; then echo "port $port is busy; set LOCAL/REMOTE/GATE/OPENCODE" >&2; exit 1; fi
done

AGENT_ENV=()
if [ "${FAKE_AGENT:-0}" = "1" ]; then
  FAKE="$(cd ../daemon/tests/fixtures && pwd)/fakeTerminalAgent.mjs"
  printf '#!/bin/sh\nexec "%s" "%s" "$@"\n' "$RUNTIME/node/bin/node" "$FAKE" > "$WORK/bin/claude"
  chmod +x "$WORK/bin/claude"
  # The stand-in reports to the service through the real hook program, as Claude Code does.
  AGENT_ENV=(CLAUDE_BIN="$WORK/bin/claude" FAKE_HOOK_SCRIPT="$RUNTIME/daemon/dist/terminals/hookClient.js")
fi

env -i "${GATE_ENV[@]}" "$RUNTIME/python/bin/secret-gate" keys --json new default --use >/dev/null
env -i "${GATE_ENV[@]}" "$RUNTIME/python/bin/secret-gate" proxy --port "$GATE" >"$WORK/logs/gate.log" 2>&1 &
pids+=($!)
env -i "${BASE_ENV[@]}" PATH="/usr/bin:/bin:/usr/sbin:/sbin" ${AGENT_ENV[@]+"${AGENT_ENV[@]}"} \
  AGENTSWITCH_HOME="$WORK/as-home" AGENTSWITCH_PORT="$LOCAL" AGENTSWITCH_REMOTE=1 AGENTSWITCH_REMOTE_PORT="$REMOTE" \
  AGENTSWITCH_OPENCODE_PORT="$OPENCODE" AGENTSWITCH_EXECUTORS=echo AGENTSWITCH_ROUTER=echo AGENTSWITCH_REMOTE_NAME="${NAME:-E2E Mac}" \
  SECRET_GATE_HOME="$WORK/sg-home" SECRET_GATE_PUBLIC="$WORK/no-gate-service" SECRET_GATE_BIN="$RUNTIME/python/bin/secret-gate" SECRET_GATE_PROXY="http://127.0.0.1:$GATE" \
  "$RUNTIME/node/bin/node" --no-warnings=ExperimentalWarning "$RUNTIME/daemon/dist/cli.js" serve >"$WORK/logs/daemon.log" 2>&1 &
pids+=($!)

for _ in $(seq 1 120); do curl -sf "http://127.0.0.1:$LOCAL/healthz" >/dev/null && break; sleep 0.5; done
curl -sf "http://127.0.0.1:$LOCAL/healthz" >/dev/null || { echo "daemon did not come up:" >&2; tail -20 "$WORK/logs/daemon.log" >&2; exit 1; }
# The local API wants the token the daemon wrote on start-up (daemon api/localAuth.ts).
AUTH="Authorization: Bearer $(cat "$WORK/as-home/local-token")"
LINK="$(curl -sf -X POST -H "$AUTH" "http://127.0.0.1:$LOCAL/pairing" | "$RUNTIME/node/bin/node" -e 'let s="";process.stdin.on("data",d=>s+=d).on("end",()=>process.stdout.write(JSON.parse(s).link))')"
[ -n "$LINK" ] || { echo "no pairing link" >&2; exit 1; }
[ -z "${LINK_FILE:-}" ] || printf '%s' "$LINK" > "$LINK_FILE"
[ -z "${HOME_FILE:-}" ] || printf '%s' "$WORK" > "$HOME_FILE"
echo "service: local http://127.0.0.1:$LOCAL  remote https://<this Mac>:$REMOTE  home $WORK"
echo "link: $LINK"
echo "running; interrupt to stop and remove everything."
while :; do sleep 3600 & wait $! || true; done
