#!/usr/bin/env bash
# Swift-minted enc:v1: tokens opened by the real Python gate (app-v0 §3, §7).
# Runs CrossLanguageTests against packages/secret-gate/.venv with a throw-away SECRET_GATE_HOME created by the test;
# ~/.secret-gate is never read or written, and no secret value is printed.
set -euo pipefail
cd "$(dirname "$0")/.."

GATE_BIN="${SECRET_GATE_BIN:-../secret-gate/.venv/bin/secret-gate}"
if [[ ! -x "$GATE_BIN" ]]; then
  echo "secret-gate CLI not found at $GATE_BIN (build packages/secret-gate/.venv first)" >&2
  exit 1
fi
GATE_BIN="$(cd "$(dirname "$GATE_BIN")" && pwd)/$(basename "$GATE_BIN")"

# Whatever the caller exported, the test only ever uses its own temporary home.
unset SECRET_GATE_HOME
set +e
out="$(AGENTSWITCH_GATE_CROSSCHECK=1 SECRET_GATE_BIN="$GATE_BIN" swift test --filter CrossLanguageTests 2>&1)"
status=$?
set -e
grep -E "error:|skipped|Test Case .*(passed|failed)|Executed" <<<"$out" || true

if [[ $status -ne 0 ]]; then
  echo "crypto cross-check: FAILED" >&2
  exit "$status"
fi
if grep -q "Test skipped" <<<"$out"; then
  echo "crypto cross-check: tests were skipped" >&2
  exit 1
fi
echo "crypto cross-check: OK"
