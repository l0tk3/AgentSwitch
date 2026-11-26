# AgentSwitch

Run and watch your AI coding agents — **Claude Code, Codex, OpenCode, pi, Grok, Antigravity** — from one Mac app, an
iPhone app and an Android app. Sessions stay the agents' own: stop using AgentSwitch and carry on in the CLI.

<p align="center">
  <img src="docs/readme/mac-terminals.jpg" width="100%" alt="Terminals on the Mac">
</p>
<p align="center">
  <img src="docs/readme/phone-terminals.jpg" width="19%" alt="iPhone: Terminals">
  <img src="docs/readme/phone-simple.jpg" width="19%" alt="iPhone: a session in the simple view">
  <img src="docs/readme/phone-rooms.jpg" width="19%" alt="iPhone: Rooms">
  <img src="docs/readme/phone-room.jpg" width="19%" alt="iPhone: a chat room">
  <img src="docs/readme/phone-browser.jpg" width="19%" alt="iPhone: the shared browser">
</p>

## Features

| | what it does | Mac | iPhone | Android |
|---|---|---|---|---|
| **Terminals** | The six agents' CLIs in terminals the service holds, open on every device at once. Split panes, folder tree, Files. | `Terminals` | tab | tab |
| **Simple view** | A session as a conversation: answers, folded tool calls, changes, approval cards; context and 5h / 7d use; a side pane with tasks and the agent's browser tab. | `Terminals` | tab | tab |
| **Chat Room** | Sessions of any agent, on any machine, in one channel: `@` each other, share tasks and files, ask you when needed. | `Chat Room` | `Rooms` | `Rooms` |
| **Dispatch** | A standing session that takes a request, opens rooms and starts the sessions it needs. | `Dispatch` | tab | tab |
| **Browser** | One shared browser (Camoufox) for you and the agents; take a tab over, hand it back. | `Browser` | tab | tab |
| **Redaction** | Your words (plain or regex) become placeholders before model traffic leaves the Mac, and words again on the way back. | Settings | — | — |
| **Profiles** | Several sign-ins per agent, each with its own proxy and browser. | Settings | ✓ | ✓ |
| **Clash** | Separate node groups for Claude, OpenAI, Grok and Antigravity on top of your subscription. | `Clash` | Settings | Settings |
| **Passwords** | A password book behind Touch ID. | ⌘⇧L | — | — |
| **Agents, Add-Ons** | Install and update the CLIs; manage their MCP servers, skills and plugins. | Settings | — | — |
| **Nodes** | Macs and Linux machines paired with each other; phones reach any of them. | Settings | ✓ | ✓ |

Also: a Live Activity on the iPhone, a menu bar card and full menus on the Mac, and two looks — `Pixel` and `Classic`.

<p align="center">
  <img src="docs/readme/mac-rooms.jpg" width="100%" alt="Chat Room on the Mac">
</p>
<p align="center">
  <img src="docs/readme/mac-simple.jpg" width="100%" alt="The simple view with its side pane">
</p>
<p align="center">
  <img src="docs/readme/mac-browser.jpg" width="100%" alt="The shared browser">
</p>
<p align="center">
  <img src="docs/readme/mac-redaction.jpg" width="49%" alt="Settings › Redaction">
  <img src="docs/readme/mac-addons.jpg" width="49%" alt="Settings › Add-Ons">
</p>
<p align="center">
  <img src="docs/readme/mac-clash.jpg" width="100%" alt="Clash">
</p>

## Two looks

`Pixel` (above) and `Classic` (below), switched in Settings on each device. Same screens, same controls.

<p align="center">
  <img src="docs/readme/mac-terminals-classic.jpg" width="100%" alt="Terminals, Classic">
</p>
<p align="center">
  <img src="docs/readme/mac-rooms-classic.jpg" width="49%" alt="Chat Room, Classic">
  <img src="docs/readme/mac-simple-classic.jpg" width="49%" alt="Simple view, Classic">
</p>
<p align="center">
  <img src="docs/readme/phone-terminals-classic.jpg" width="19%" alt="iPhone, Classic: Terminals">
  <img src="docs/readme/phone-simple-classic.jpg" width="19%" alt="iPhone, Classic: simple view">
  <img src="docs/readme/phone-rooms-classic.jpg" width="19%" alt="iPhone, Classic: Rooms">
  <img src="docs/readme/phone-room-classic.jpg" width="19%" alt="iPhone, Classic: a chat room">
  <img src="docs/readme/phone-browser-classic.jpg" width="19%" alt="iPhone, Classic: browser">
</p>

## How it fits together

```
iPhone · Android ──HTTPS, pinned certificate──▶ ┐
Mac app ──────────HTTP, 127.0.0.1─────────────▶ agentswitchd ──▶ the six agents
other Macs, Linux nodes ◀──── paired ─────────▶ ┘   ├─ terminals, chat rooms, Dispatch
                                                    ├─ the shared browser
                                                    └─ model gateway, password vault
```

Phones pair once by QR code and reach only a fixed list of routes (`packages/daemon/src/remote/routes.ts`).

## Packages

| package | what |
|---|---|
| `packages/daemon` | TypeScript service and CLI `bin/agentswitch` |
| `packages/mac-app` | macOS app (SwiftUI); bundles Node, Python, the service and secret-gate |
| `packages/ios-app` | iPhone app (SwiftUI, iOS 17+) |
| `packages/android-app` | Android app (Kotlin, Compose, Android 10+) |
| `packages/secret-gate` | Python: the model traffic gateway and the browser fill gate |
| `packages/linux` | headless Linux node: the same runtime, a systemd user service |

## Build

Apple Silicon Mac, macOS 14+, Xcode, [xcodegen](https://github.com/yonaskolb/XcodeGen); for Android, JDK 17 and the
Android SDK. The agents are your own installs; the app can install them.

```bash
cd packages/mac-app && scripts/build-app.sh                  # → build/AgentSwitch.app
cd packages/ios-app && scripts/build-sim.sh                  # simulator
cd packages/ios-app && TEAM=<team ID> scripts/install-device.sh
cd packages/android-app && ./gradlew :app:assembleRelease    # → app/build/outputs/apk/release/
packages/linux/scripts/install.sh                            # Linux node
```

Open the Mac app, follow its first-run steps, scan the pairing code with the phone.

## Test

```bash
cd packages/daemon      && npm install && npm test
cd packages/mac-app     && swift test
cd packages/ios-app     && swift test
cd packages/android-app && ./gradlew :kit:test :app:testDebugUnitTest
cd packages/secret-gate && .venv/bin/pytest
```

No test calls a real model. Screens can be drawn from demo data: Mac `-designPreview <dir>`, iPhone
`-uiDemo YES -uiDemoScreen <name>`, Android `--ez uiDemo true --es uiDemoScreen <name>`.

## Release

The version is in `VERSION` (1.0.0); `node packages/daemon/scripts/check-version.mjs` checks every package against it.
CI (`.github/workflows/ci.yml`) runs all tests and builds on every push. A tag such as `v1.0.0` publishes a GitHub
Release (`-beta.N` makes a prerelease) with the Apple Silicon Mac app ZIP, Linux x86_64 and aarch64 runtimes, and
`SHA256SUMS.txt`. The Mac app is ad-hoc signed, not notarized; no IPA or APK is published.

## Docs

Design notes are in `docs/` (Chinese); `CLAUDE.md` indexes them. Start with `docs/design-v0.md`.
