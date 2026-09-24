#!/usr/bin/env bash
# Build AgentSwitch for a connected iPhone, install it and launch it (docs/app-v0.md §5).
#
#   TEAM=ABCDE12345 scripts/install-device.sh
#   TEAM=ABCDE12345 BUNDLE_ID=com.yourname.agentswitch DEVICE=<udid or name> scripts/install-device.sh
#
# Needs: an Apple ID in Xcode › Settings › Accounts (a free Personal Team works; its builds expire after 7 days),
# the iPhone connected once by cable and trusted, Developer Mode on (iPhone Settings › Privacy & Security).
# TEAM is the 10-character team ID shown in Xcode › Settings › Accounts › (your team). Signing is passed on the
# xcodebuild command line, so the generated project and project.yml stay team-free and nothing personal is committed.
set -euo pipefail
cd "$(dirname "$0")/.."

: "${TEAM:?set TEAM to your Apple developer team ID (Xcode › Settings › Accounts)}"
BUNDLE_ID="${BUNDLE_ID:-com.agentswitch.ios}"
DERIVED="${DERIVED_DATA:-build/DerivedDevice}"
LOG="build/xcodebuild-device.log"
mkdir -p build

# The first reachable iPhone unless DEVICE names one (UDID or device name). Prints "<udid> <developer mode status>".
list_iphones() {
  local devices_json
  devices_json="$(mktemp)"
  xcrun devicectl list devices --json-output "$devices_json" >/dev/null 2>&1 || true
  /usr/bin/python3 - "$devices_json" "${DEVICE:-}" <<'PY'
import json, sys
path, wanted = sys.argv[1], sys.argv[2]
try:
    devices = json.load(open(path)).get("result", {}).get("devices", [])
except Exception:
    devices = []
for d in devices:
    props, hw, conn = d.get("deviceProperties", {}), d.get("hardwareProperties", {}), d.get("connectionProperties", {})
    if hw.get("platform") != "iOS" or hw.get("deviceType") != "iPhone":
        continue
    udid, name = hw.get("udid", ""), props.get("name", "")
    if wanted and wanted not in (udid, name, d.get("identifier")):
        continue
    # "disconnected" is a paired device on cable or Wi-Fi whose tunnel comes up on the first request; only
    # "unavailable" (out of reach) cannot take an install.
    if conn.get("pairingState") == "paired" and conn.get("tunnelState") in ("connected", "disconnected"):
        print(udid, props.get("developerModeStatus", "unknown"))
        break
PY
  rm -f "$devices_json"
}

# `list devices` can report a stale Developer Mode status (still "disabled" after the user turned it on and
# restarted); `device info details` asks the iPhone itself.
live_dev_mode() {
  local details_json
  details_json="$(mktemp)"
  xcrun devicectl device info details --device "$1" --json-output "$details_json" >/dev/null 2>&1 || true
  /usr/bin/python3 - "$details_json" <<'PY'
import json, sys
try:
    print(json.load(open(sys.argv[1])).get("result", {}).get("deviceProperties", {}).get("developerModeStatus", "unknown"))
except Exception:
    print("unknown")
PY
  rm -f "$details_json"
}

read -r UDID DEV_MODE <<<"$(list_iphones)" || true
[ -n "${UDID:-}" ] || { echo "no reachable iPhone found (plug it in, unlock it, trust this Mac; or set DEVICE=<udid|name>)" >&2; xcrun devicectl list devices >&2 || true; exit 1; }
[[ "$DEV_MODE" != "disabled" ]] || DEV_MODE="$(live_dev_mode "$UDID")"
echo "device: $UDID  team: $TEAM  bundle id: $BUNDLE_ID  developer mode: $DEV_MODE"
DEV_MODE_HINT="Developer Mode is off: iPhone Settings › Privacy & Security › Developer Mode › on, restart the iPhone, confirm \"Turn On\" after it boots, then rerun this script."
# xcodebuild will not even build for a device with Developer Mode off ("Timed out waiting for all destinations").
[[ "$DEV_MODE" != "disabled" ]] || { echo "$DEV_MODE_HINT" >&2; exit 2; }

xcodegen generate --quiet
set +e
xcodebuild -project AgentSwitch.xcodeproj -scheme AgentSwitch -configuration Debug \
  -destination "platform=iOS,id=$UDID" -derivedDataPath "$DERIVED" -allowProvisioningUpdates \
  DEVELOPMENT_TEAM="$TEAM" CODE_SIGN_STYLE=Automatic CODE_SIGN_IDENTITY="Apple Development" PROVISIONING_PROFILE_SPECIFIER= \
  PRODUCT_BUNDLE_IDENTIFIER="$BUNDLE_ID" build >"$LOG" 2>&1
status=$?
set -e
grep -E "error:|\*\* BUILD" "$LOG" || true
if [[ $status -ne 0 ]]; then
  echo "build failed; full log: $LOG" >&2
  grep -q "No Account for Team\|No accounts" "$LOG" && echo "→ add your Apple ID in Xcode › Settings › Accounts first" >&2
  grep -q "Unable to log in with account\|were rejected" "$LOG" && echo "→ Xcode's Apple ID session expired: Xcode › Settings › Accounts › select it and sign in again" >&2
  grep -q "is not available\|cannot be registered" "$LOG" && echo "→ the bundle id is taken; rerun with BUNDLE_ID=com.<yourname>.agentswitch" >&2
  exit $status
fi

APP="$DERIVED/Build/Products/Debug-iphoneos/AgentSwitch.app"
xcrun devicectl device install app --device "$UDID" "$APP"
xcrun devicectl device process launch --device "$UDID" "$BUNDLE_ID" || \
  echo "installed. If iOS says the developer is not trusted: iPhone Settings › General › VPN & Device Management › trust your Apple ID, then open AgentSwitch."
