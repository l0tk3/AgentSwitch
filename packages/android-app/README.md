# android-app

Android client for AgentSwitch (`docs/app-v0.md` §5b): the iPhone app (`../ios-app`), on Android. Pair with the Mac
by QR code, then the same five places — `Terminals`, `Dispatch`, `Files`, `Browser`, `Settings` — drawn by the same
rules (`docs/ui-v0.md` §7 and §8). Kotlin, Jetpack Compose, Android 10 (API 29) and later.

The two phones are one design. A screen here is the iPhone's screen drawn with Android's means: the same layout, the
same words, the same colours and sizes (a point there is a dp or an sp here). The logic is the iPhone's too, file for
file.

## Layout

| path | what |
|---|---|
| `kit/` | the logic with no Android in it: a Kotlin port of the iPhone's `AgentSwitchKit`, one file per Swift file, same type and member names, packages `com.agentswitch.kit.<folder>`; its tests are the Swift tests ported, and run on the Mac |
| `app/` | the Compose interface (`com.agentswitch.android`) and what only a phone has (the Keystore, the camera, service discovery, notifications) |
| `scripts/e2e-service.sh` | a throw-away service to try the app against |
| `app/licenses/` | the licences of what is bundled (the interface's monospace font) |

`kit`, by folder — as `../ios-app/README.md` describes `AgentSwitchKit`, with these differences:

- `api/HTTPTransport.kt`: `PinnedSessionTransport` is OkHttp with a trust manager of its own. Trust in the Mac is one
  fact learned at pairing, the SHA-256 of its certificate: no CA, no host name check, every overload of the trust
  manager ends in the same comparison. No cache, no cookies, no redirects, no retry that would send a write twice.
  The Mac's service closes a connection after 5 idle seconds, so an idle one is kept for 4, the kept ones are dropped
  after a longer silence (the phone slept, the app was frozen), and a read that fails on its connection is asked once
  more on a new one — never a write (`docs/app-v0.md` §5b, "Mac 关掉的连接").
  All of it runs off the caller's thread: on Android the main thread may not touch the network, and closing a
  response does.
- `connection/DirectRoute.kt`: the way to the Mac's LAN address around a VPN on the phone. A proxy client (Clash and
  its kind) takes every app's traffic and would send a connection for the Mac to a proxy that cannot reach it; where
  the app names the network under the VPN (`platform/AndroidDirectRoute.kt`), the transport tries it first — a
  connection and the pinned handshake — and uses it when the Mac answers there (`docs/app-v0.md` §5b, "手机上的 VPN").
- `secrets/`: `crypto_box_seal` is libsodium's and nothing cryptographic is written here. The kit has the interface
  `BoxSealer`; the tests give it libsodium through lazysodium-java (and `CrossLanguageTests`, opt-in, has the Python
  gate open what Kotlin sealed).
- `connection/`: `ServiceDiscovery` and `PathMonitoring` are interfaces; the app implements them
  (`platform/NsdDiscovery.kt` over Android's own service discovery, `platform/AndroidPathMonitor.kt`).
- `storage/`: `TokenVault` is an interface; the app's is `platform/KeystoreTokenVault.kt` (each token sealed with an
  AES-256-GCM key that the Android Keystore made and keeps). `LocalStore` writes JSON into a folder handed to it.
- `feed/Markdown.kt`: the inline part (bold, italic, code, links) is a small parser of the kit's own — the iPhone hands
  that to Foundation — which gives runs with flags for the interface to draw.
- `support/UnicodePattern.kt`: regular expressions whose `\s \d \w` must be Unicode's are made through
  `unicodePattern`. The desktop JVM needs a flag for that and Android refuses the same flag; a pattern written with
  the flag directly passes every test on the Mac and crashes on the phone.
- Times are `Long` milliseconds since 1970; a Swift `async` function is a `suspend` one, a stream a `Flow`.

`app`, by folder: `design/` (the look: `Theme`, the pixel and classic palettes, sprites, the app's mark, buttons,
forms, the floating boxes, glitch and the other effects), `components/` (Markdown, code blocks), `onboarding/`
(pairing: the scanner, the confirmation), `terminals/` (the tab, a terminal's page and its models), `terminal/` (a
terminal's screen: a display only, as on the iPhone), `dispatch/` (the Dispatch tab, a task's page, approvals),
`files/` (the Mac's files: the browser, previews, changes), `browser/` (the Mac's shared browser and the pages of
tapped links), `settings/` (with the proxies and Clash), `platform/` (what the phone gives; `FollowService.kt` keeps the app
following the Mac from behind while something is in progress), `demo/` (the sample
screens' data, the self-check).

## Dependencies

- Kotlin coroutines and serialization, OkHttp 5 (`kit`).
- Compose (BOM), Activity, Lifecycle; CameraX for the scanner's camera and [ZXing](https://github.com/zxing/zxing)
  core to read the code — no Google Play services anywhere, so the app runs on a phone without them.
- [Termux](https://github.com/termux/termux-app)'s `terminal-emulator` and `terminal-view` libraries (Apache 2.0),
  from JitPack, for a terminal's screen: `docs/terminal-v0.md` §0 says no terminal core of our own, on any platform.
- JetBrains Mono (SIL Open Font License, `app/licenses/JetBrainsMono-OFL.txt`) as the interface's monospace. It has the
  box-drawing and block characters; it has no braille, so the busy spinner is drawn as the dots of a braille cell.

## Build and test

Needs a JDK 17 somewhere on the machine and the Android SDK (platform 36). The wrapper finds the JDK itself
(`gradle/gradle-daemon-jvm.properties`), whatever `java` the shell has; where the SDK is goes in `local.properties`
(`sdk.dir=…`, not checked in) or `ANDROID_HOME`.

```bash
cd packages/android-app
./gradlew :kit:test                    # the logic's tests, on this machine
./gradlew :app:testDebugUnitTest       # the app's own JVM tests (the QR decoder)
./gradlew :app:assembleDebug           # app/build/outputs/apk/debug/app-debug.apk
./gradlew :app:assembleRelease         # app/build/outputs/apk/release/app-release.apk — the one for a phone
```

`CrossLanguageTests` needs the Python gate and is skipped unless asked for:
`AGENTSWITCH_GATE_CROSSCHECK=1 AGENTSWITCH_PACKAGES=<repo>/packages ./gradlew :kit:test`.

## Run

On an emulator (any Android 10+ image; `adb` from the SDK's `platform-tools`):

```bash
adb install -r app/build/outputs/apk/debug/app-debug.apk
adb shell am start -n com.agentswitch.android/.MainActivity
```

Sample screens, with made-up data and no Mac (debug builds; the iPhone's `-uiDemo YES -uiDemoScreen <name>`, the
same names):

```bash
adb shell am start -n com.agentswitch.android/.MainActivity --ez uiDemo true --es uiDemoScreen terminals
adb shell am start -n com.agentswitch.android/.MainActivity --es uiDemoScreen design       # every shared part
adb shell am start -n com.agentswitch.android/.MainActivity --ez uiDemo true --es appearance classic
adb shell cmd uimode night yes|no                                                           # dark, light
```

Against a throw-away service (the runtime bundled in `../mac-app/build/AgentSwitch.app`, a home folder of its own,
non-default ports; nothing of yours is read or written):

```bash
FAKE_AGENT=1 scripts/e2e-service.sh        # prints a pairing link and runs until it is stopped (SIGTERM, or ⌃C)
adb shell am start -n com.agentswitch.android/.MainActivity --es pairLink '<the link>'
```

`FAKE_AGENT=1` makes `claude` the daemon tests' stand-in, so a terminal can be opened and asked for a permission
without an agent or a model. The emulator reaches the service at the Mac's own address, as a phone on the same
network would.

### On a phone

1. On the phone: Settings › About phone › Software information, tap `Build number` seven times; then Settings ›
   Developer options › `USB debugging` (or `Wireless debugging`).
2. Connect it, accept the prompt on the phone, and `adb install -r app/build/outputs/apk/release/app-release.apk`.
   Without `adb`: copy the APK to the phone and open it there (the phone asks once to allow installing from that app;
   a Samsung phone refuses until Auto Blocker is off: Settings › Security and privacy › Auto Blocker).
3. Pair: on the Mac, AgentSwitch › 配对新设备…; on the phone, `[ Scan QR Code ]` (same Wi-Fi as the Mac, or
   Tailscale on the phone signed in to the same tailnet).

**Which build.** `release` for a phone: not debuggable, so the interface runs at its real speed; the sample screens
and the self-check are in `debug` only. Neither is shrunk.

**Signing.** A `release` build is signed with the release key where the machine has one, else with the machine's
debug key (`~/.android/debug.keystore`), so anyone can build one. The key is told to the build by
`keystore.properties` beside `settings.gradle.kts` (never checked in):

```properties
storeFile=/absolute/path/to/release.jks
storePassword=…
keyAlias=…
keyPassword=…
```

or by the same four values in the environment: `AGENTSWITCH_ANDROID_KEYSTORE`,
`AGENTSWITCH_ANDROID_KEYSTORE_PASSWORD`, `AGENTSWITCH_ANDROID_KEY_ALIAS`, `AGENTSWITCH_ANDROID_KEY_PASSWORD`. Making
one: `keytool -genkeypair -keystore release.jks -storetype PKCS12 -alias agentswitch -keyalg RSA -keysize 4096
-validity 10000`. Keep the key outside the repository and keep a copy: without it no update can be installed over the
app. An update installs only over a build signed with the same key, so a build from another machine, or one from
before the key, needs the app removed first — and removing it removes the pairing.
`apksigner verify --print-certs app/build/outputs/apk/release/app-release.apk` says which key signed a package.

## Not yet

What the iPhone app has and this one does not is listed, with dates, in `docs/app-v0.md` §5b.
