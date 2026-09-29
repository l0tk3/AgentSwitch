#!/usr/bin/env bash
# The showcase's media (docs/showcase/index.html): every screen of the Mac and iPhone apps drawn from their own demo
# data, the Live Activity, and screen recordings of the phone's effects. Nothing real is shown: the Mac app's
# `-designPreview` and the phone app's `-uiDemo` screens use made-up names, addresses and keys.
#
#   docs/showcase/build.sh capture   # draw and record everything into $SRC (Mac app, iOS Simulator, swift test)
#   docs/showcase/build.sh media     # $SRC → docs/showcase/media (web sizes: JPEG screens, mp4 clips)
#   docs/showcase/build.sh zip       # docs/showcase + docs/design/visual-v1 → ~/Desktop/AgentSwitch-showcase.zip
#
# Needs Xcode with an iPhone 17 simulator (SIM=<udid> to pick another). media/ and .src/ are not in git.
set -euo pipefail
HERE="$(cd "$(dirname "$0")" && pwd)"
ROOT="$(cd "$HERE/../.." && pwd)"
SRC="${SRC:-$HERE/.src}"
MEDIA="$HERE/media"
SIM="${SIM:-$(xcrun simctl list devices available | awk -F '[()]' '/iPhone 17 \(/ {print $2; exit}')}"
BUNDLE=com.agentswitch.ios

# Phone demo screens (uiDemoScreen) and how long each takes to settle, in seconds.
PHONE_SCREENS="home:5 onboarding:5 offline:5 settings:5 mac:5 tasks:5 search:5 sessions:5 transcript:6 task:5 done:5 running:5 stale:5 interrupted:5 terminals:5 terminalmenu:6 terminaldelete:6 terminal:6 terminalsealed:7 terminalslash:6 terminalclose:6 newterminal:5 newterminalbypass:6"
# Screens whose effects play by themselves, recorded for this long after launch.
CLIPS="home:6 terminals:5 terminal:6 terminalsealed:7 newterminal:5 terminalclose:5 running:6"
# The Mac app's pages kept for the showcase (each in light and dark).
MAC_PAGES="menu menu-fresh settings-pairing settings-devices settings-models settings-permissions settings-keys settings-environment settings-general wizard-1-executors wizard-2-pairing wizard-3-permissions wizard-4-done sheet-gate-install sheet-gate-installing sheet-gate-installed"

capture_mac() {
  mkdir -p "$SRC/mac"
  (cd "$ROOT/packages/mac-app" && swift build >/dev/null && .build/debug/AgentSwitchMac -designPreview "$SRC/mac")
}

capture_live() {
  mkdir -p "$SRC/live"
  (cd "$ROOT/packages/ios-app" && AGENTSWITCH_RENDER_DIR="$SRC/live" swift test --filter LiveRenderTests >/dev/null)
}

phone_app() {
  (cd "$ROOT/packages/ios-app" && scripts/build-sim.sh >/dev/null)
  xcrun simctl boot "$SIM" 2>/dev/null || true
  xcrun simctl install "$SIM" "$ROOT/packages/ios-app/build/DerivedData/Build/Products/Debug-iphonesimulator/AgentSwitch.app"
  xcrun simctl status_bar "$SIM" override --time 9:41 --batteryState charged --batteryLevel 100 --cellularMode active --cellularBars 4 --wifiBars 3 --operatorName ""
}

capture_phone() {
  for look in light dark; do
    mkdir -p "$SRC/phone/$look"
    xcrun simctl ui "$SIM" appearance "$look"
    for spec in $PHONE_SCREENS; do
      local screen=${spec%%:*} wait=${spec##*:}
      xcrun simctl terminate "$SIM" "$BUNDLE" 2>/dev/null || true
      xcrun simctl launch "$SIM" "$BUNDLE" -uiDemo YES -uiDemoScreen "$screen" >/dev/null
      sleep "$wait"
      xcrun simctl io "$SIM" screenshot "$SRC/phone/$look/$screen.png" >/dev/null 2>&1
    done
  done
}

capture_clips() {
  mkdir -p "$SRC/video"
  xcrun simctl ui "$SIM" appearance dark
  for spec in $CLIPS; do
    local screen=${spec%%:*} secs=${spec##*:}
    xcrun simctl terminate "$SIM" "$BUNDLE" 2>/dev/null || true
    sleep 1
    xcrun simctl io "$SIM" recordVideo --codec=h264 --force "$SRC/video/$screen.mov" >/dev/null 2>&1 &
    local rec=$!
    sleep 1.2
    xcrun simctl launch "$SIM" "$BUNDLE" -uiDemo YES -uiDemoScreen "$screen" >/dev/null
    sleep "$secs"
    kill -INT "$rec"; wait "$rec" 2>/dev/null || true
  done
  xcrun simctl terminate "$SIM" "$BUNDLE" 2>/dev/null || true
  xcrun simctl status_bar "$SIM" clear
}

media() {
  rm -rf "$MEDIA"; mkdir -p "$MEDIA/phone/light" "$MEDIA/phone/dark" "$MEDIA/mac" "$MEDIA/live" "$MEDIA/video"
  for look in light dark; do
    for f in "$SRC/phone/$look"/*.png; do
      sips -s format jpeg -s formatOptions 80 --resampleWidth 600 "$f" --out "$MEDIA/phone/$look/$(basename "${f%.png}").jpg" >/dev/null
    done
  done
  for page in $MAC_PAGES; do
    for suffix in "" "-dark"; do
      local f="$SRC/mac/$page$suffix.png"
      [ -f "$f" ] || continue
      local w; w=$(sips -g pixelWidth "$f" | awk '/pixelWidth/ {print $2}')
      if [ "$w" -gt 1200 ]; then
        sips -s format jpeg -s formatOptions 85 --resampleWidth 1200 "$f" --out "$MEDIA/mac/$page$suffix.jpg" >/dev/null
      else
        sips -s format jpeg -s formatOptions 85 "$f" --out "$MEDIA/mac/$page$suffix.jpg" >/dev/null
      fi
    done
  done
  for f in "$SRC/live"/*.png; do   # rendered at 3×; 2× is enough on a page
    local w; w=$(sips -g pixelWidth "$f" | awk '/pixelWidth/ {print $2}')
    sips --resampleWidth $((w * 2 / 3)) "$f" --out "$MEDIA/live/$(basename "$f")" >/dev/null
  done
  # The recording starts on the home screen and the app's launch screen: the clip starts just before the app draws
  # (≈ 3 s in: launched 1.2 s after the recorder, then the launch animation and screen).
  for f in "$SRC/video"/*.mov; do
    avconvert -s "$f" -p Preset960x540 -o "$MEDIA/video/$(basename "${f%.mov}").mp4" --start "${CLIP_START:-2.3}" --replace >/dev/null 2>&1
  done
  du -sh "$MEDIA"
}

zip_it() {
  local out="$HOME/Desktop/AgentSwitch-showcase.zip"
  rm -f "$out"
  (cd "$ROOT/docs" && zip -qr "$out" showcase/index.html showcase/media design/visual-v1 -x '*.DS_Store')
  echo "$out ($(du -h "$out" | cut -f1)); unzip and open showcase/index.html"
}

case "${1:-}" in
  capture) capture_mac; capture_live; phone_app; capture_phone; capture_clips ;;
  media) media ;;
  zip) zip_it ;;
  *) echo "usage: $0 capture | media | zip" >&2; exit 2 ;;
esac
