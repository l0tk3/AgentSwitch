#!/usr/bin/env bash
# Installs (or updates) AgentSwitch on this Linux machine for the current user, no root needed (docs/mesh-v0.md §4.1–4.2):
#
#   ~/.local/share/agentswitch/runtime/<stamp>/   a runtime built by build-runtime.sh; `current` points at the one in use
#   ~/.local/bin/agentswitch                      the command, through `current`
#   ~/.config/systemd/user/agentswitch.service    the keeper, started at boot (agentswitch service install)
#
# State stays where the services keep it: ~/.agentswitch (the daemon) and ~/.secret-gate (the gate's keys).
# An update builds the new runtime beside the old one, switches `current`, restarts the service and waits for the
# daemon to answer; when it does not, `current` goes back and the old one is started again. The two newest runtimes
# are kept, and any older one a terminal still runs on (its holder).
#
# The terminals outlive the restart (docs/terminal-v0.md §10: each program is held outside the service), so the
# update does not wait for them. Dispatch's tasks do not outlive it: while one is in progress the restart waits, up to
# 30 minutes (AGENTSWITCH_UPDATE_WAIT seconds), saying what it waits for; still busy then, `current` goes back and
# nothing is restarted.
#
#   scripts/install.sh               build, switch, (re)start
#   scripts/install.sh --now         the same, without waiting for Dispatch's tasks
#   scripts/install.sh --no-service  build and switch only
#
# Run from a terminal that is not held (one opened before terminals were, or with node.json "holdTerminals": false),
# the script is in the service's cgroup: restarting the service would end it with that terminal, before it checked the
# new runtime or went back. Then the restart and what follows run as a unit of their own, AGENTSWITCH_UPDATE_DELAY
# seconds later (default 10), and that terminal ends with the restart.
set -euo pipefail

HERE="$(cd "$(dirname "$0")/.." && pwd)"
REPO="$(cd "$HERE/../.." && pwd)"
SHARE="${XDG_DATA_HOME:-$HOME/.local/share}/agentswitch"
RUNTIMES="$SHARE/runtime"
BIN="$HOME/.local/bin"
SERVICE=1
NOW=0
case "${1:-}" in
  --no-service) SERVICE=0 ;;
  --now) NOW=1 ;;
esac

log() { printf '\n==> %s\n' "$*"; }
die() { printf 'error: %s\n' "$*" >&2; exit 1; }
switch() { ln -sfn "$1" "$RUNTIMES/current.new" && mv -T "$RUNTIMES/current.new" "$RUNTIMES/current"; }

# The local port the daemon answers on (node.json may move it).
port() {
  "$RUNTIMES/current/node/bin/node" -e 'try { const s = JSON.parse(require("fs").readFileSync(process.argv[1], "utf8")); console.log(s.ports?.local ?? 4711) } catch { console.log(4711) }' \
    "${AGENTSWITCH_HOME:-$HOME/.agentswitch}/node.json"
}
healthy() {
  local p; p="$(port)"; p="${p:-4711}"
  for _ in $(seq 1 60); do
    curl -fsS -m 2 --noproxy "*" "http://127.0.0.1:$p/healthz" 2>/dev/null | grep -q '"ok":true' && return 0
    sleep 1
  done
  return 1
}

# Dispatch's tasks in progress, a line each (none: the daemon does not answer, or nothing is in progress).
busy_tasks() {
  "$BIN/agentswitch" tasks --json 2>/dev/null | "$RUNTIMES/current/node/bin/node" -e '
    let s = ""; process.stdin.on("data", (d) => { s += d; }).on("end", () => {
      try { for (const t of JSON.parse(s)) if (["queued", "routing", "running", "waiting_approval"].includes(t.status)) console.log(`  task ${t.id} ${t.status}: ${String(t.task).replace(/\s+/g, " ").slice(0, 60)}`); } catch {}
    });' || true
}

# Waits while Dispatch has tasks in progress (they end with the service); false when still busy at the deadline.
wait_for_tasks() {
  [ "$NOW" = 1 ] && return 0
  local deadline=$(( $(date +%s) + ${AGENTSWITCH_UPDATE_WAIT:-1800} )) said=0 list
  while list="$(busy_tasks)"; [ -n "$list" ]; do
    [ "$(date +%s)" -ge "$deadline" ] && { printf '%s\n' "$list"; return 1; }
    if [ $(( said % 6 )) = 0 ]; then log "waiting for Dispatch's tasks to end before restarting (--now does not wait):"; printf '%s\n' "$list"; fi
    said=$(( said + 1 ))
    sleep 10
  done
  return 0
}

# (Re)start the service on the runtime `current` points at; back to $1 (the one before) when it does not answer.
# Then keep the two newest runtimes, and any other a terminal's holder still runs on.
finish() {
  local previous="$1"
  if ! wait_for_tasks; then
    log "Dispatch still has tasks in progress; nothing restarted. Run again with --now to restart anyway"
    [ -n "$previous" ] && switch "$previous" && echo "current is $previous again"
    exit 1
  fi
  if systemctl --user cat agentswitch.service >/dev/null 2>&1; then
    # The unit is written again first: a newer runtime may write it differently (OOMPolicy, 2026-10-14).
    "$BIN/agentswitch" service install >/dev/null
    log "restarting the service"
    systemctl --user restart agentswitch.service
  else
    log "installing the service"
    "$BIN/agentswitch" service install
  fi
  if healthy; then
    log "the daemon answers"
  elif [ -n "$previous" ]; then
    log "the new runtime did not answer within a minute; back to $previous"
    switch "$previous"
    systemctl --user restart agentswitch.service
    healthy && echo "the previous runtime answers again" || echo "the previous runtime does not answer either: agentswitch service logs"
    exit 1
  else
    die "the daemon does not answer: agentswitch service logs"
  fi
  # Only the stamped folders (not `current`, not an unfinished `.partial`); oldest first.
  find "$RUNTIMES" -mindepth 1 -maxdepth 1 -type d -regex '.*/[0-9]\{8\}-[0-9]\{6\}-[^/.]*' | sort | head -n -2 | while read -r old; do
    [ "$(basename "$old")" = "$(readlink "$RUNTIMES/current")" ] && continue
    # A terminal opened on it is still held by its holder there (docs/terminal-v0.md §10).
    if pgrep -f -- "$old/" >/dev/null 2>&1; then echo "kept old runtime $(basename "$old"): a terminal still runs on it"; continue; fi
    rm -rf "$old" && echo "removed old runtime $(basename "$old")"
  done
  log "done. Next: agentswitch doctor; agentswitch pair"
}

# The second half, as its own unit (see the top).
if [ "${1:-}" = "--finish" ]; then NOW="${3:-0}"; finish "${2:-}"; exit 0; fi

STAMP="$(date -u +%Y%m%d-%H%M%S)-$(git -C "$REPO" rev-parse --short HEAD 2>/dev/null || echo local)"
mkdir -p "$RUNTIMES" "$BIN"
# One install at a time; then what an earlier one left unfinished (a build that was stopped) can go, about a gigabyte
# each. A build that fails now takes its own unfinished folder with it.
exec 9>"$RUNTIMES/.install.lock"
flock -n 9 || die "another install.sh is building in $RUNTIMES"
for left in "$RUNTIMES"/*.partial; do
  [ -e "$left" ] || continue
  rm -rf "$left" && echo "removed an unfinished runtime: $(basename "$left")"
done
trap 'rm -rf "$RUNTIMES/$STAMP.partial"' EXIT
"$HERE/scripts/build-runtime.sh" "$RUNTIMES/$STAMP.partial"
mv "$RUNTIMES/$STAMP.partial" "$RUNTIMES/$STAMP"
trap - EXIT

PREVIOUS="$(readlink "$RUNTIMES/current" 2>/dev/null || true)"
switch "$STAMP"
log "runtime $RUNTIMES/$STAMP is current${PREVIOUS:+ (was $PREVIOUS)}"

cat > "$BIN/agentswitch.new" <<'SH'
#!/bin/sh
# AgentSwitch's command (packages/linux/scripts/install.sh): the runtime in use.
R="${AGENTSWITCH_RUNTIME:-${XDG_DATA_HOME:-$HOME/.local/share}/agentswitch/runtime/current}"
exec "$R/node/bin/node" --no-warnings=ExperimentalWarning "$R/daemon/dist/cli.js" "$@"
SH
chmod 755 "$BIN/agentswitch.new"
mv "$BIN/agentswitch.new" "$BIN/agentswitch"
echo "command: $BIN/agentswitch"
case ":$PATH:" in *":$BIN:"*) ;; *) echo "note: $BIN is not on your PATH" ;; esac

[ "$SERVICE" = 1 ] || { log "done (the service was not restarted)"; exit 0; }
if grep -q '/agentswitch\.service$' /proc/self/cgroup 2>/dev/null; then
  delay="${AGENTSWITCH_UPDATE_DELAY:-10}"
  unit="agentswitch-update-$STAMP"
  systemd-run --user --quiet --collect --unit "$unit" --on-active="${delay}s" \
    ${AGENTSWITCH_HOME:+--setenv=AGENTSWITCH_HOME="$AGENTSWITCH_HOME"} ${XDG_DATA_HOME:+--setenv=XDG_DATA_HOME="$XDG_DATA_HOME"} \
    "$HERE/scripts/install.sh" --finish "$PREVIOUS" "$NOW"
  log "run from one of this node's terminals: in ${delay}s the service restarts as $unit, and this terminal ends"
  echo "afterwards: journalctl --user -u $unit; resume the agent's conversation from the Sessions list"
  exit 0
fi
finish "$PREVIOUS"
