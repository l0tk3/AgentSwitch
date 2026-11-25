# ios-app

iPhone client for AgentSwitch (`docs/app-v0.md` §3, §5): pair with the Mac by QR code, then its terminals, the
dispatch desk and the other Chat Rooms, its browser, and the settings. SwiftUI, iOS 17+, Swift 6.

## Layout

| path | what |
|---|---|
| `Package.swift`, `Sources/AgentSwitchKit/` | pure logic, `swift test` on the Mac (macOS 14 + iOS 17 platforms) |
| `Tests/AgentSwitchKitTests/` | unit tests, fixtures, a real-TLS pinning test |
| `App/` | SwiftUI app target: sources, `Info.plist`, asset catalog (placeholder icon) |
| `project.yml` | xcodegen spec; `AgentSwitch.xcodeproj` is generated and git-ignored |
| `scripts/build-sim.sh` | xcodegen + xcodebuild for the iOS Simulator |

AgentSwitchKit, by folder:

- `Pairing/` — `agentswitch://pair?p=<base64url JSON>` parsing and validation (v1, fingerprint, Crockford code,
  addresses; a `gate` key a Mac may still send is not read), `ServerProfile`, `PairingService` (find an address,
  `POST /pair`).
- `API/` — models (`Me`, `MacAddresses`…), `AgentSwitchAPI` (async/await), `SSEParser`, `ReconnectPolicy` and the
  idle guard of the event streams, `CertificatePin` and `PinnedSessionTransport` (URLSession accepting only the
  paired leaf-certificate SHA-256), `ToolDisplay` (a tool as people say it). control-v0: `ControlModels` (default
  folder), `SessionModels` (the Mac's Claude Code / Codex / OpenCode sessions, grouped by folder), `ControlRoutes`
  (`/settings/workdir`, `/sessions`); an event stream drops a connection that has sent no byte for 30 s (the daemon
  pings every 10 s) and connects again.
  Terminals and what goes with them: `TerminalModels` / `TerminalRoutes` (terminals and their events;
  the profiles to choose between and the one a terminal runs under, `ProfileChoice`, `TerminalProfile`).
  Proxies (docs/clash-v0.md §9, profiles-v0 §4.2, browser-v0 §7.6): `ClashModels` (the Mac's Clash page, the same
  models as the Mac app's), `ProxyModels` (`ProxySetting`, `ProxyExit`, `ProxyDraft` — the form's rules, a proxy
  written whole in one field taken apart, and a typed password for the Mac to seal — `BrowserProxyState`),
  `ProxyRoutes` (`/vault/seal`, `/clash…`, `/profiles/:agent/:id/proxy` and `/check`, `/browser/identity`; a Mac from before these were a phone's answers 403 or 404, read as nothing to
  show). The Mac's files (docs/files-v0.md §7): `FileModels` (a level, an entry's details, a text preview, the Mac's
  refusals and what the phone says for each, `MacPath`, the orders of `Sort By`, short sizes and times, a pick and the
  question before one that may hold a password) and `FileRoutes` (`/files` sent with the version the page has — a 304
  is nothing new —, `/files/stat`, `/files/preview`, `/files/thumbnail`, `/files/content` written to a file as it
  comes, with its progress); a reply's attachment names a Mac file by its `path`.
- `Connection/` — `EndpointSelector` (Bonjour with matching `fp` prefix → LAN addresses → Tailscale; probe `/healthz`
  then `/me`), `ConnectionManager` (actor; re-selects on failure and on `NWPathMonitor` changes, checks the address
  in use with `/healthz` on returning to the foreground, retries on its own while unreachable — 2 s doubling to
  30 s, no cap; the Mac's current addresses are fetched when a connection is made, on returning to the foreground and
  every 5 minutes while connected, and `ServerProfile.updated(with:)` keeps the LAN addresses the Mac had before
  behind the current ones, up to 8, so a Mac that moves between networks is found on each), `ConnectionProgress` (连接中 → 重连中 → 无法连接（第 N 次）→ 未找到 Mac after 6 minutes → 配对已失效),
  `Troubleshooting` (设置 › Mac › 排障), Bonjour and path monitor adapters behind protocols.
- `Feed/` — `MessageDisplay` (the sealer's legend cut off, ciphertexts shown as 🔒密文), `Markdown` (model output
  split into blocks — headings, lists, quotes, code, tables — with Foundation's inline parser inside; images are
  never loaded), `LiveSummary` (the terminals at work or waiting, as the Live Activity's state), the terminals' and
  the records' display (`RecordDisplay`, `TerminalTree`, `TerminalAttention`, `TerminalLinks`…), `Speech`, `Cues`.
- `Files/` — `UploadFile` / `Multipart` (the `POST /uploads` body), `ImagePrep` (images shrunk to 2048 px, re-encoded
  without metadata, JPEG unless PNG).
- `Storage/` — `KeychainTokenVault` (`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`), `LocalStore` (the paired Macs
  as JSON).

## Dependencies

AgentSwitchKit has none. The app adds SwiftTerm (below). CryptoKit only hashes (SHA-256 of the certificate); a
secret that has to be sealed (a proxy's password) is sealed by the Mac, `POST /vault/seal`.

## Test

```bash
cd packages/ios-app
swift test                          # AgentSwitchKit unit tests (+ real TLS pinning against a local Python HTTPS server)
```

## Build and run

Requires Xcode 26.4 or newer with its iOS platform installed (Xcode › Settings › Components, or
`xcodebuild -downloadPlatform iOS`; without it Xcode offers no simulator destination at all) and
[xcodegen](https://github.com/yonaskolb/XcodeGen). The deployment target is iOS 17, so a build made with the iOS 26.4
SDK runs on current iOS 27 phones; building against the iOS 27 SDK or running an iOS 27 simulator needs Xcode 27.
The terminals tab draws with [SwiftTerm](https://github.com/migueldeicaza/SwiftTerm) (pinned to 1.18.x: from 1.19 it
runs a build-tool plugin of its own), whose Metal shaders need Xcode's Metal Toolchain
(`xcodebuild -downloadComponent MetalToolchain`, once). `Package.resolved` is shared by the app project and the
package: `swift test` rewrites it without the app's pins (SwiftTerm), so commit the version the Xcode build writes.

```bash
cd packages/ios-app
scripts/build-sim.sh                                               # generic/platform=iOS Simulator
DESTINATION='platform=iOS Simulator,name=iPhone 17' scripts/build-sim.sh
open AgentSwitch.xcodeproj                                         # or work in Xcode
```

To run on a simulator from the command line:

```bash
xcrun simctl boot "iPhone 17"
xcrun simctl install booted build/DerivedData/Build/Products/Debug-iphonesimulator/AgentSwitch.app
xcrun simctl launch booted com.agentswitch.ios
xcrun simctl openurl booted 'agentswitch://pair?p=…'               # the Mac app's link opens the pairing sheet
xcrun simctl launch booted com.agentswitch.ios -pairLink 'agentswitch://pair?p=…'   # Debug builds: same, no prompt
xcrun simctl launch booted com.agentswitch.ios -uiDemo YES -openLink agentswitch://terminal/a1b2c3d4   # a Live Activity's link, no prompt
```

The simulator has no camera; use "粘贴配对链接".

### On an iPhone

1. Xcode › Settings › Accounts: add your Apple ID. A free account (Personal Team) works; its installs expire after
   7 days (just run the script again). A paid account gives one-year profiles and TestFlight.
2. Plug the iPhone in once, unlock it, tap "Trust". On the iPhone turn on Settings › Privacy & Security ›
   Developer Mode (it restarts). After this first time, the same Wi-Fi is enough.
3. Install and launch:

   ```sh
   TEAM=<your team ID> scripts/install-device.sh
   # bundle id taken? TEAM=... BUNDLE_ID=com.<yourname>.agentswitch scripts/install-device.sh
   # several iPhones? add DEVICE=<udid or name>
   ```

   The team ID is the 10-character ID shown for your team in Xcode › Settings › Accounts. Signing goes in on the
   command line only, so project.yml and the generated project stay team-free.

   **An iPhone that is away.** Xcode only reaches an iPhone on the cable or on the Mac's own network: its pairing
   service wants the iPhone as a neighbour on the same link, and a Tailscale address alone is refused. With
   [RoamRun](https://github.com/mh-mobile/RoamRun) installed (`brew install --cask mh-mobile/tap/roamrun`) and the
   iPhone saved in it once while it is on the Mac's Wi-Fi, the script starts RoamRun's bridge when it finds no
   iPhone and stops it at the end. What the iPhone needs then: joined to some Wi-Fi (on cellular alone its pairing
   service does not listen), unlocked, and the Tailscale app as its VPN — a proxy app's built-in Tailscale node
   (Stash's `type: tailscale`) only carries traffic out of the iPhone, not in to it. `roamrun doctor <name>` says
   which step fails. After the iPhone restarts it may want the cable once.
4. First launch: if iOS says the developer is not trusted, open Settings › General › VPN & Device Management and
   trust your Apple ID. Allow Local Network and Camera when asked.
5. Pair: on the Mac, AgentSwitch › 配对新设备…; on the iPhone, scan the code (same Wi-Fi as the Mac, or the Tailscale
   app on the iPhone logged in to the same tailnet).

Alternatively open the generated project (`xcodegen generate && open AgentSwitch.xcodeproj`), pick your team under
Signing & Capabilities and press Run — but `xcodegen generate` (also run by the scripts) discards that change.

## Screens

- **配对** — scan the Mac's QR code (AVFoundation) or paste / tap the link; shows the Mac name, certificate fingerprint
  and addresses before anything is sent; pairs over TLS pinned to that fingerprint; token → Keychain.
- **Dispatch** (tab) — the dispatch desk: the Chat Room the Mac flags as the desk (`desk: true` in `GET /rooms`), its
  page as the tab's own. No desk: the dispatch is turned on on the Mac (its Settings › Dispatch).
- **Settings** (tab) — the Mac, its connection and the other paired Macs; Appearance (the look, the text size);
  Proxies; Alerts & Voice (sound, haptics, read aloud, the voice, the Live Activity); the Mac app's new version; the
  Face ID lock; removing the Mac. Mac › Troubleshooting and the default work folder.
  Proxies (2026-10-09): a section with one row for `Clash` (its state in a word), one for the shared `Browser` and
  one for each profile that is not the Mac's own (its colour, and where it leaves from). `Clash` is the Mac's Clash
  page: status, the subscription (a link pasted in, one of Clash Verge's own, a file; update, replace, remove), the
  nodes for Claude and for OpenAI with what each group uses now (a tap changes it; `Nodes` chooses and orders them,
  `Test` times them), rule templates and DNS with their text, the addresses that go direct, the routing check. A
  proxy's form is one for both: `Server`, `User Name`, `Password`, its exit; a typed password is sealed by the
  Mac under its own key (`POST /vault/seal`, over the pinned connection) and the proxy is set with the token. Adding AgentSwitch's subscription to Clash
  Verge, a browser's fingerprint, and making or removing a profile stay on the Mac.
- **Files** (tab, docs/files-v0.md §5) — the Mac's files, one level a page: the folder in the bar with the Mac under
  it, its whole path under the bar (every level a button; the middle folds into `…`, a menu of those levels), iOS
  Files' list in the classic look and tree lines in the pixel look (a folder's `▸` opens it in place), `Select` and `⋯`
  (hidden files, the order, home). It opens where it was last on that Mac (first, the Mac's home folder), or at a
  terminal's folder from the row's `Show in Files`. A file opens its preview: a text file's first 64 KB, a picture's
  small copy, `Open Preview` for Quick Look (fetched first; over 25 MB it is not). `Add to Reply…` asks which terminal,
  then opens it with the files in its reply box as `[File #n]` marked `on Mac` — their paths go with the reply, nothing
  is copied. A file the Mac thinks may hold a password is asked about first (`Add to Reply?`) and marked with an amber
  `!`. The same browser is a terminal's `+` › `Files on Mac`, over its page at its folder. Locked places, a level
  narrowed to this phone's scope and the Mac's refusals say why (`FileRefusal`).
- **Terminals** and **Browser** (tabs) — docs/terminal-v0.md, docs/simple-view-v0.md, docs/browser-v0.md. A terminal
  under a profile carries its colour as a lit dot; the new-terminal sheet has a `Profile` row when the agent has more
  than one, and a conversation's menu has `Resume As <name>` (profiles-v0 §3.2, §3.3). The Browser tab lists the
  shared browser and each profile's own (§5.4).

Demo screens (Debug, `-uiDemo YES -uiDemoScreen <name>`): `terminals`, `terminal` (a terminal waiting for a
permission), `terminalsealed` (the sealed box opens 3 s in, with its glitch), `terminalslash` (`/co` and its
suggestions), the same terminal's simple view (docs/simple-view-v0.md) as `simple` (a permission card at the end of
the record), `simplebusy` (at work: what it is doing, its sub-agents, a queued message, the stop key),
`simplecompact` (while it compacts its context: `Compact` and the clock, an earlier one a line in the record),
`simpledaybreak` (a Codex terminal with its Daybreak switch on; `simpledaybreakclash`: on a model Codex lists without it),
`simpleidle` (at rest: the model under the reply box opens the menu that changes it), `simplequestion`,
`simpleprompt` (waiting on a screen of its own: the keys come out) and `simplechanges` (what the last turn
changed), `newterminal`, `settings`, `onboarding`, `mac`, `offline` (the Mac unreachable), `offlinemac`, `sessions`,
`transcript`; profiles as `terminalprofiles` (a terminal's dot), `newterminalprofile` and `terminalmenuprofile`
(`Resume As`); proxies as `proxies` (Settings scrolled to the section), `clash`, `clashservice`, `clashrules`,
`clashcheck` (parts of the Clash page), `clashnodes`, `clashtext`, `clashsource` (the pages behind it),
`proxybrowser` and `proxyprofile` (the form); the Files tab on a made-up disk (`DemoFiles`) as `files`, `fileshome`, `filesopen`
(`src` opened in place), `filespreview`, `filesimage`, `filesselect`, `fileschoose` (`Add to Reply…`'s terminals),
`filessensitive` (the question), `filesscoped` (the levels above a scope), `filessheet` (`+` › Files on Mac) and
`filesreply` (the Mac's files in a reply box); the Browser tab's `browser` (the list), `browserpage` (watching codex, its last action outlined),
`browsertook` (taken over, the keyboard and key bar up), `browserfile`, `browserlocal`, `browserdenied`, `browsernew`,
`browserclose`, `browserzoom` (your dev server's page at 50%, the zoom row open; its `−` `+` draw the mock page
again) and `browserzoomwatch` (watching codex, the row stepping the picture on the phone, at 150%) — mock pages drawn
on the phone; `-uiDemoOpenTools YES` opens every step of a record; `-uiDemoScroll route` (with `mac` or
`offlinemac`) opens the Mac page scrolled to the end of 排障 with 常见原因 open.

## Not in v0

Push notifications (the phone posts local ones while it runs: a terminal that waits or whose turn ended, something
in a room waiting for you), release signing.
