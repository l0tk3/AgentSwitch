# ios-app

iPhone client for AgentSwitch (`docs/app-v0.md` §3, §5): pair with the Mac by QR code, then one input box and the log
of what the agents do. Threads are filed by the router, never chosen on the phone; approvals and questions are answered
inside the log. SwiftUI, iOS 17+, Swift 6.

```
┌ Mac mini ───────────── ⚙ ┐ ┌ 设置 ────────────────────┐
│        整理 docs 的表格 ▐ │ │ 环境说明（CONTEXT.md）  › │
│ ✓ 已完成 claude/sonnet-5  │ │ 密文                   › │
│   表格已按日期排好…       │ │ 高级                      │
│   登录 fin 用 🔒密文 查 ▐ │ │   会话（左滑删除）      › │
│ ● 执行中 codex/gpt-6-astra│ │   任务日志（左滑删除）  › │
│   工具 shell: curl …      │ │   模型                  › │
│ 需要审批 [拒绝] [允许]    │ │ Mac · 连接 · Face ID      │
│ (+) 让 Mac 上的 agent…  ↑ │ │ 移除此 Mac（可配多台）    │
└──────────────────────────┘ └──────────────────────────┘
```

## Layout

| path | what |
|---|---|
| `Package.swift`, `Sources/AgentSwitchKit/` | pure logic, `swift test` on the Mac (macOS 14 + iOS 17 platforms) |
| `Tests/AgentSwitchKitTests/` | unit tests, fixtures, a real-TLS pinning test, the opt-in Python gate cross-check |
| `App/` | SwiftUI app target: sources, `Info.plist`, asset catalog (placeholder icon) |
| `project.yml` | xcodegen spec; `AgentSwitch.xcodeproj` is generated and git-ignored |
| `scripts/build-sim.sh` | xcodegen + xcodebuild for the iOS Simulator |
| `scripts/crypto-crosscheck.sh` | Swift-minted tokens opened by `packages/secret-gate` |

AgentSwitchKit, by folder:

- `Pairing/` — `agentswitch://pair?p=<base64url JSON>` parsing and validation (v1, fingerprint, Crockford code,
  addresses, optional gate key), `ServerProfile`, `PairingService` (find an address, `POST /pair`, fetch the gate key if
  the QR code had none).
- `Secrets/` — `GatePolicy` (label, host with port and `*.` wildcard, TOTP base32, uses; mirrors `policy.py`),
  `SecretPayload` (byte-identical to Python's `to_json()`), `TokenMinter` (libsodium `crypto_box_seal` →
  `enc:v1:` + base64url), `SecretDraft` (the mint form).
- `API/` — models (`AgentTask`, `TaskEvent`, `Approval`, `AgentThread`, `QuotaReading`, `Targets`, `Me`, `GatePubkey`),
  `AgentSwitchAPI` (async/await), `SSEParser` and the reconnecting event stream (`?after=<seq>`), `CertificatePin` and
  `PinnedSessionTransport` (URLSession accepting only the paired leaf-certificate SHA-256), `EventDescriber` (one line
  per event, like the web console). control-v0: `ControlModels` (permission mode, default folder, search hits),
  `SessionModels` (the Mac's Claude Code / Codex / OpenCode sessions, grouped by folder), `ControlRoutes`
  (`/approvals/policy`, `/settings/workdir`, `/sessions`, `/tasks/:id/ack`, `/search`); the event stream drops a
  connection that has sent no byte for 30 s (the daemon pings every 10 s) and resumes from the last seq.
- `Connection/` — `EndpointSelector` (Bonjour with matching `fp` prefix → LAN addresses → Tailscale; probe `/healthz`
  then `/me`), `ConnectionManager` (actor; re-selects on failure and on `NWPathMonitor` changes, checks the address
  in use with `/healthz` on returning to the foreground, retries on its own while unreachable — 2 s doubling to
  30 s, no cap), `ConnectionProgress` (连接中 → 重连中 → 无法连接（第 N 次）→ 未找到 Mac after 6 minutes → 配对已失效),
  `Troubleshooting` (设置 › Mac › 排障), Bonjour and path monitor adapters behind protocols.
- `Feed/` — the home log's pure parts: `ActivityFeed` (oldest-first timeline, which active tasks get one of the 3 live
  streams, approvals outside the log), `EventTail` (the last lines under a running task), `MessageDisplay` (the
  sealer's legend cut off, ciphertexts shown as 🔒密文), `Markdown` (model output split into blocks — headings, lists,
  quotes, code, tables — with Foundation's inline parser inside; images are never loaded). control-v0: `Attention`
  (read marks, who-needs-you order, `Staleness` for a running task quiet for 10 minutes), `ProcessFolding` (tool
  calls in a row as one line, `TaskDuration`), `SearchSnippet` (⟦⟧ hits, and a local search for a Mac without
  `/search`). ui-v0 §4.2: `Usage` (`GET /quota` as 设置 › 用量 rows — Claude Code and Codex with fixed 5h / 7d slots,
  a window past its reset reads as none; OpenCode with its balance).
- `Files/` — `UploadFile` / `Multipart` (the `POST /uploads` body), `TaskFile` (a task's `in/` and `out/`), `ImagePrep`
  (images shrunk to 2048 px, re-encoded without metadata, JPEG unless PNG).
- `Storage/` — `KeychainTokenVault` (`kSecAttrAccessibleWhenUnlockedThisDeviceOnly`), `LocalStore` (profile and saved
  ciphertexts as JSON, ciphertext + note only), `NotificationSink` (placeholder, no push in v0).

## Dependencies

- [`jedisct1/swift-sodium`](https://github.com/jedisct1/swift-sodium) ≥ 0.11.0 (libsodium 1.0.22, prebuilt
  xcframework with iOS, simulator and macOS slices), for `crypto_box_seal`. It is libsodium itself, the same primitive
  PyNaCl's `SealedBox` uses in the gate; nothing cryptographic is hand-written here. CryptoKit only hashes (SHA-256 of
  the certificate).

## Test

```bash
cd packages/ios-app
swift test                          # AgentSwitchKit unit tests (+ real TLS pinning against a local Python HTTPS server)
scripts/crypto-crosscheck.sh        # needs packages/secret-gate/.venv; throw-away SECRET_GATE_HOME, never ~/.secret-gate
```

The cross-check mints tokens in Swift for a keypair made by the Python gate, then asserts that `secret-gate check`
reports the right label, kind, hosts and uses, that the decrypted payload bytes equal Swift's and Python's canonical
`to_json()` (compared by SHA-256, no value printed), that tampered and foreign tokens are rejected, and that host,
label and base32 validation agree with `policy.py` case by case.

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
4. First launch: if iOS says the developer is not trusted, open Settings › General › VPN & Device Management and
   trust your Apple ID. Allow Local Network and Camera when asked.
5. Pair: on the Mac, AgentSwitch › 配对新设备…; on the iPhone, scan the code (same Wi-Fi as the Mac, or the Tailscale
   app on the iPhone logged in to the same tailnet).

Alternatively open the generated project (`xcodegen generate && open AgentSwitch.xcodeproj`), pick your team under
Signing & Capabilities and press Run — but `xcodegen generate` (also run by the scripts) discards that change.

## Screens

- **配对** — scan the Mac's QR code (AVFoundation) or paste / tap the link; shows the Mac name, certificate fingerprint,
  addresses and gate keypair before anything is sent; pairs over TLS pinned to that fingerprint; token → Keychain.
- **首页** — the only main screen: the log of the last 30 tasks, oldest first (what you said, state and executor, the
  live tail of up to 3 running tasks over SSE, result or error), this task's approvals and questions answered in
  place; a 6 s refresh while visible. The input box sends with no thread (the router files it); its "+" adds
  attachments (camera, photos, files, a pasted image; shown as removable thumbnails, uploaded on send), inserts a
  saved ciphertext, mints a new one, or pins the next task to an executor. Long press on an entry: 朗读 (the task's
  spoken script, offline system voice, heard with the silent switch on), delete. "还有 N 项待处理" gathers approvals of
  tasks no longer in the log.
- **任务详情** — tap a log entry: 文件 (what the executor handed back and what you sent; a tap downloads and opens
  the system preview, which shares or saves), 朗读 in the toolbar, the full live event stream (resumes from the last seq), approvals and questions
  (options, free text, ciphertext for `secret` questions), result, cancel, hand off (router's choice or a pinned
  target).
- **设置** (gear) — 环境说明: edit the Mac's CONTEXT.md (`PUT /context`, the Mac's lint strips plaintext credential
  lines and the warnings are shown; insert a ciphertext; load the example when empty). 密文: mint from label, sites,
  kind, uses and value with the gate key from pairing (refreshed from `/gate/pubkey`); the value field is cleared after
  minting; saved list (ciphertext + note), copy (local-only clipboard, 2-minute expiry), insert into the input box.
  用量 (docs/ui-v0.md §4.2): right under the Mac, one row per executor with thin 5h / 7d bars (OpenCode: its
  balance) and when they were read; pull to refresh re-reads (`POST /quota/refresh`). 管理: 会话 and 任务记录 (swipe
  to delete, confirmed; a running one is refused with the reason), 模型 (the scheduling model and each executor's
  models). Then Mac info and fingerprint, the path in use (Bonjour / LAN / Tailscale) and re-selection, Face ID lock,
  re-pair.
  control-v0: 任务记录 sorted by who needs you, with search; 编码会话 (the Mac's coding sessions by folder, a read-only
  transcript each, refreshed every 10 s while one runs); 权限 (the mode, changed on the Mac); Mac › 排障 and the
  default work folder. Opening a task marks it read; unread tasks carry an accent dot; the process folds tool calls
  in a row and ends with how long the task took.

Demo screens (Debug, `-uiDemo YES -uiDemoScreen <name>`): `terminals`, `terminal` (a terminal waiting for a
permission), `terminalsealed` (the sealed box opens 3 s in, with its glitch), `terminalslash` (`/co` and its
suggestions), `newterminal`, `settings`, `task`, `done`, `running`, `stale`,
`interrupted`, `onboarding`, `mac`, `offline` (home, Mac unreachable), `offlinemac`, `tasks`, `search`, `sessions`,
`transcript`; the Browser tab's `browser` (the list), `browserpage` (watching codex, its last action outlined),
`browsertook` (taken over, the keyboard and key bar up), `browserfile`, `browserlocal`, `browserdenied`, `browsernew`,
`browserclose`, `browserzoom` (your dev server's page at 50%, the zoom row open; its `−` `+` draw the mock page
again) and `browserzoomwatch` (watching codex, the row stepping the picture on the phone, at 150%) — mock pages drawn
on the phone; `-uiDemoOpenTools YES` opens every tool call and fold; `-uiDemoScroll route` (with `mac` or
`offlinemac`) opens the Mac page scrolled to the end of 排障 with 常见原因 open.

## Not in v0

Push notifications (`NotificationSink` is the seam; also what automatic read-aloud waits for), choosing or renaming
threads (the router files them; the phone only deletes), multiple Macs, release signing. Your own attachments of a
task in a temporary work dir are gone once it ends (only its `out/` is kept).
