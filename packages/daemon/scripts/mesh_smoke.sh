#!/bin/zsh
# docs/mesh-v0.md by hand: two throw-away services on this machine, paired through the command line as two Macs would
# be, each using the other. No model is called, no agent is started. Not part of the tests.
#
#   scripts/mesh_smoke.sh            ports 4931/4933 and 4941/4943, state in a temp folder that is deleted at the end
#   MESH_SMOKE_THEN='<command>'      run once the two are paired, before Laptop removes Studio,
#                                    with A_HOME, A_PORT (Studio) and B_HOME, B_PORT (Laptop) in its environment and
#                                    nothing else of this shell's: how the Mac app's `-nodesProbe` is pointed at Laptop
#   MESH_SMOKE_TERMINALS=1           the services offer terminals (none is started)
#
# Every process here gets an environment built from nothing. A shell inside an AgentSwitch terminal carries the real
# service's AGENTSWITCH_HOME, ports and gate settings; a `serve` that inherited them would run a second service on the
# real state. The script stops if either service is not on
# its own throw-away state.
set -u
D="$(cd "$(dirname "$0")/.." && pwd)"
S="$(mktemp -d "${TMPDIR:-/tmp}/agentswitch-mesh.XXXXXX")"
NODE_BIN="$(dirname "$(command -v node)")"
# The service is node itself with tsx as its loader, not tsx's launcher: the launcher starts node as a child, and a
# signal sent to it leaves that child running.
RUN=("$NODE_BIN/node" --no-warnings=ExperimentalWarning --import tsx src/cli.ts)
cd "$D"
clean() {  # home local-port command…
  local home="$1" port="$2"; shift 2
  env -i PATH="$NODE_BIN:/usr/bin:/bin:/usr/sbin:/sbin" HOME="$S/$home" TMPDIR="${TMPDIR:-/tmp}" LANG=en_US.UTF-8 \
    AGENTSWITCH_HOME="$S/$home/state" AGENTSWITCH_PORT="$port" AGENTSWITCH_EXECUTORS=echo \
    AGENTSWITCH_BROWSER_HOST=0 AGENTSWITCH_TERMINALS="${MESH_SMOKE_TERMINALS:-0}" AGENTSWITCH_SESSIONS=0 "$@"
}
serve() {  # name home local-port remote-port
  mkdir -p "$S/$2"
  clean "$2" "$3" env AGENTSWITCH_REMOTE=1 AGENTSWITCH_REMOTE_PORT="$4" AGENTSWITCH_REMOTE_NAME="$1" AGENTSWITCH_OPENCODE_PORT=$(( $3 + 5 )) "${RUN[@]}" serve > "$S/$2.log" 2>&1
}
serve "Studio" a 4931 4933 & PA=$!
serve "Laptop" b 4941 4943 & PB=$!
stop() {
  for p in $PA $PB; do pkill -TERM -P $p 2>/dev/null; kill $p 2>/dev/null; done
  wait 2>/dev/null
  rm -rf "$S"
  local left="$(lsof -nP -iTCP:4931 -iTCP:4933 -iTCP:4941 -iTCP:4943 -sTCP:LISTEN 2>/dev/null | tail -n +2)"
  [ -n "$left" ] && { echo; echo "LEFT RUNNING (stop these by hand):"; echo "$left"; }
}
trap stop EXIT
for p in 4931 4941; do
  n=0
  until curl -s -m 1 "http://127.0.0.1:$p/healthz" >/dev/null 2>&1; do
    n=$((n+1)); [ $n -gt 60 ] && { echo "the service on $p did not start"; tail -5 "$S"/*.log; exit 1; }
    python3 -c 'import time; time.sleep(0.4)'
  done
done
# Each service says where its state is in the line it prints once it listens; that line may land a moment after the port answers.
for h in a b; do
  n=0
  until grep -q "home=" "$S/$h.log"; do n=$((n+1)); [ $n -gt 25 ] && break; python3 -c 'import time; time.sleep(0.2)'; done
  grep -qF "home=$S/$h/state" "$S/$h.log" || { echo "STOP: service $h is not on its throw-away state"; echo "--- log:"; cat "$S/$h.log"; exit 1; }
done
A() { clean a 4931 "${RUN[@]}" "$@"; }
B() { clean b 4941 "${RUN[@]}" "$@"; }
step() { echo; echo "== $1"; }

step "Studio shows a pairing code"; LINK=$(A pair --json | python3 -c 'import sys,json; print(json.load(sys.stdin)["link"])'); echo "a link of ${#LINK} characters"
step "Laptop pastes the link"; B nodes add "$LINK"
step "each node's list"; B nodes; A nodes
step "who uses Studio"; A devices
step "from Laptop: what Studio says of itself"
curl -s -H "authorization: Bearer $(cat "$S/b/state/local-token")" -H "x-agentswitch-nodes: $(cat "$S/b/state/nodes/key")" "http://127.0.0.1:4941/nodes/Studio/node"; echo
step "from Laptop: Studio's own service answers, and lists its profiles"; B --on Studio health; B --on Studio profiles 2>&1 | tail -3
if [ -n "${MESH_SMOKE_THEN:-}" ]; then
  step "then: $MESH_SMOKE_THEN"
  env -i PATH="$NODE_BIN:/usr/bin:/bin:/usr/sbin:/sbin" HOME="$HOME" TMPDIR="${TMPDIR:-/tmp}" LANG=en_US.UTF-8 \
    A_HOME="$S/a/state" A_PORT=4931 B_HOME="$S/b/state" B_PORT=4941 /bin/zsh -c "$MESH_SMOKE_THEN"
fi
step "the local token without the nodes key does not act on a node (403)"
curl -s -o /dev/null -w '%{http_code}\n' -H "authorization: Bearer $(cat "$S/b/state/local-token")" "http://127.0.0.1:4941/nodes/Studio/profiles"
step "Laptop removes Studio, both ways"; B nodes remove Studio --both
echo "-- Laptop:"; B nodes; B devices
echo "-- Studio:"; A nodes; A devices
step "what Laptop keeps of other nodes"; ls -la "$S/b/state/nodes" | awk 'NR>1 {print $1, $NF}'
