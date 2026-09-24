#!/usr/bin/env bash
# Generate the Xcode project and build the app for the iOS Simulator (no signing team needed).
#   scripts/build-sim.sh                      # generic simulator destination
#   DESTINATION='platform=iOS Simulator,name=iPhone 16' scripts/build-sim.sh
# The .app lands in build/DerivedData/Build/Products/Debug-iphonesimulator/AgentSwitch.app; the full log in
# build/xcodebuild.log.
set -euo pipefail
cd "$(dirname "$0")/.."

command -v xcodegen >/dev/null || { echo "xcodegen not found (brew install xcodegen)" >&2; exit 1; }
DESTINATION="${DESTINATION:-generic/platform=iOS Simulator}"
DERIVED="${DERIVED_DATA:-build/DerivedData}"
LOG="build/xcodebuild.log"
mkdir -p build

xcodegen generate --quiet
echo "xcodebuild -destination '$DESTINATION'"
set +e
xcodebuild \
  -project AgentSwitch.xcodeproj \
  -scheme AgentSwitch \
  -configuration Debug \
  -destination "$DESTINATION" \
  -derivedDataPath "$DERIVED" \
  build >"$LOG" 2>&1
status=$?
set -e

grep -E "error:|warning: .*/App/|\*\* BUILD" "$LOG" || true
if [[ $status -ne 0 ]]; then
  echo "build failed (exit $status); see $LOG" >&2
  exit "$status"
fi
echo "app: $DERIVED/Build/Products/Debug-iphonesimulator/AgentSwitch.app"
