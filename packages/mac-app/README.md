# mac-app

AgentSwitch for macOS (docs/app-v0.md §4): a menu-bar app (`LSUIElement`, SwiftUI `MenuBarExtra`) that ships its
own Node, Python, daemon and secret-gate, supervises `agentswitchd`, pairs iPhones by QR
code and advertises itself over Bonjour. The old credential gate (`secret-gate proxy`, its keys, its ciphertexts, its
system service) is no longer run or shown: the bundled secret-gate program only runs the daemon's model traffic
gateway. Claude Code / Codex / OpenCode stay the user's own installs; the app
detects them and says how to install or log in.

```
menu bar ── 服务 · iPhone · Tailscale · 用量 (5h / 7d bars, OpenCode balance)      [配对新设备…] [打开网页控制台] [重启服务] [设置…] [退出]
设置窗口 ── 配对 (QR + code + countdown) · 设备 (revoke) · 模型 (用量) · Redaction · Agents · Profiles · Add-Ons · 环境 (设置清单 on top) · 通用 · Dispatch (调度台)
首次运行 ── 设置窗口上的引导：执行器 → 配对手机 → 启动 → 完成
```

## Build

```bash
cd packages/mac-app
swift test                      # Core unit + integration tests (dev secret-gate venv and node are used when present)
scripts/build-app.sh            # → build/AgentSwitch.app, ad-hoc signed
APP_OUT=build/next/AgentSwitch.app scripts/build-app.sh   # same, elsewhere (the script refuses to replace a running app)
swift run AgentSwitchMac        # UI development without a bundle; point it at a runtime with -runtimeRoot <dir>
```

A build in `build/next` is offered for install (the menu bar, the phone's settings, `POST /update/install`). The copy
that installs writes down the windows it has open on other nodes and the terminals out in windows of their own
(`update-windows.json` in the app's home); the copy it starts opens them again once its service answers — the main
window opens at every start anyway (`UpdateWindows`, `AgentSwitchApp.reopenAfterUpdate`).

`build-app.sh` downloads Node 24 darwin-arm64 and a python-build-standalone CPython 3.12 (cached in `.build-cache/`,
SHA-256 pinned in `scripts/runtime-pins.sh`, re-hashed on every build and extracted afresh each time: an extracted
tree is never reused), installs secret-gate's dependencies into that Python from `scripts/python-requirements.txt`
(`pip install --require-hashes --only-binary=:all:`), builds `packages/secret-gate` offline into a wheel with the
hash-pinned setuptools of `scripts/python-build-requirements.txt` (kept out of the bundle) and installs it by name
from that wheel, builds `packages/daemon` from a staging copy (`npm ci` against package-lock integrity hashes,
`npm run build`, `npm prune --omit=dev`), builds the app with xcodegen + xcodebuild and assembles
`Contents/Resources/runtime/{node,daemon,python,secret-gate}`. Console-script shebangs are rewritten to a relative
sh trampoline and `bin/secret-gate` is a wrapper running `python3.12 -I -B -m secret_gate.cli`, so the bundle can
move and a task directory can never shadow the gate's modules. No absolute path of the build machine is left in the
bundle (no `direct_url.json`, `.pyc` source paths start at `runtime/`, the executable's debug map is stripped); the
script's last check fails the build otherwise.

Python pins: `scripts/python-constraints.txt` holds the versions (the tested set of `packages/secret-gate/.venv`);
`scripts/lock-python.sh` resolves secret-gate's requirements against them on the bundled interpreter and writes the
two hash-pinned files, then downloads every file to prove they install. After changing a version, secret-gate's
dependencies or the Python pin:

```bash
packages/secret-gate/.venv/bin/pip freeze --exclude-editable > packages/mac-app/scripts/python-constraints.txt
packages/mac-app/scripts/lock-python.sh      # rewrites python-requirements.txt and python-build-requirements.txt; commit them
```

## Runtime

| child | command | env | stop |
|---|---|---|---|
| daemon | `runtime/node/bin/node --no-warnings=ExperimentalWarning runtime/daemon/dist/cli.js serve` | below | SIGINT |

Daemon env: `AGENTSWITCH_HOME=~/Library/Application Support/AgentSwitch`, `AGENTSWITCH_PORT`, `AGENTSWITCH_REMOTE=1`
with `AGENTSWITCH_REMOTE_PORT` and `AGENTSWITCH_REMOTE_NAME=<Mac name>` (or `AGENTSWITCH_REMOTE=0` and neither while
通用 › 允许 iPhone 连接 is off), `AGENTSWITCH_OPENCODE_PORT`, `AGENTSWITCH_EXECUTORS=real`,
`SECRET_GATE_HOME=~/.secret-gate`, `SECRET_GATE_BIN=<bundled wrapper>` (the model traffic gateway's program; the old gate's home is read once to move
what it held),
`OPENCODE_BIN` when found, `TAILSCALE_BE_CLI=1` (Tailscale.app's binary only acts as the CLI with it or a TERM,
which a Finder-launched app lacks), and `PATH` = the login shell's (`$SHELL -lic`, 5 s timeout, plus /opt/homebrew/bin,
/usr/local/bin, ~/.local/bin, ~/.opencode/bin). Only HOME, USER, LOGNAME, SHELL, TMPDIR, LANG/LC_*, SSH_AUTH_SOCK
pass through from the app; proxy variables never do. SSH_AUTH_SOCK is deliberate: `git push` from a task needs the
user's ssh agent, so a task from a paired phone can use the loaded keys; `git push` is its own approval category in
the daemon, and keys added with `ssh-add -c` ask on every use.

- **One copy per data directory**: the app takes an exclusive `flock` on `$AGENTSWITCH_HOME/run/app.lock` before it
  touches pid files, ports or children, and keeps it until it exits (the kernel drops it on a crash). A second copy
  (another bundle, `open -n`) finds it taken, wakes the first (which opens its settings window and explains) and
  quits.
- **Supervision** (`SupervisorMachine`, pure): restart with exponential backoff (1 s doubling to 60 s, reset after
  30 s of uptime); a preflight before every launch (runtime present, our own leftovers from a crash stopped via
  pid files in `$AGENTSWITCH_HOME/run/`, ports free). A pid file holds the pid and its start time
  (`<pid> <sec>.<usec>`); a leftover is stopped only when that pid still has that start time and its executable
  lies in this bundle's runtime (real paths), so a reused pid or another copy's child is never signalled. Health is
  polled every 3 s (daemon `/healthz`); a daemon failing its check for long is restarted. Quit (menu, SIGTERM,
  logout) stops the daemon.
- **Logs**: `~/Library/Logs/AgentSwitch/daemon.log` (0600, rotated at 10 MB on start).
- **iPhone access** (通用 › 允许 iPhone 连接（远程接口与 Bonjour）, user default `remoteAccess`, on by default): off
  restarts the daemon with `AGENTSWITCH_REMOTE=0` (no remote listener, no pairing) and stops the Bonjour
  advertisement; the menu shows 远程已关闭. Paired devices stay paired.
- **Pairing link**: 复制链接 writes it with `prepareForNewContents(with: .currentHostOnly)` (no Universal Clipboard),
  marks it `org.nspasteboard.TransientType` / `ConcealedType`, and clears the clipboard when the code expires unless
  something else was copied since (change count).
- **Bonjour**: `NetService` `_agentswitch._tcp` on the remote port, name from `GET /remote/info` (`AgentSwitch on
  <Mac name>`), TXT `v=1`, `fp=<first 16 hex of the certificate SHA-256>`. macOS 15+ gates this behind Local
  Network privacy (`NSLocalNetworkUsageDescription`, `NSBonjourServices`); a registration still pending after 10 s
  turns the menu's Bonjour line into a hint to allow AgentSwitch under 系统设置 › 隐私与安全性 › 本地网络.
- **Login item**: `SMAppService.mainApp`.
- **默认工作目录** (§2, 通用): `GET|PUT /settings/workdir`; 选择… is an open panel (folders, new ones allowed), 恢复默认
  sends the daemon's default; a 400 is shown in the daemon's words. Read again every minute by the poll.
- **设置清单** (§6, top of 环境; count in the menu panel as N 项设置未完成): each harness installed and logged in, a paired
  phone, Tailscale connected, the work dir usable (`SetupChecklist`, Core). 「文件和文件夹」 is not on it: macOS
  cannot report that grant without prompting for it. 登录 runs `claude auth login` / `codex login` /
  `opencode auth login` in a new Terminal window (`osascript`, the command passed as `argv`, the detected binary under
  the login-shell PATH; `NSAppleEventsUsageDescription` for the one-time Automation prompt). Coming back to the app
  checks the environment again while a login is open (15 min) or something is missing (at most every 30 s).
- **用量** (docs/ui-v0.md §4.2): `GET /quota` read when the menu panel opens and when 模型 appears (the daemon's
  cached readings, re-read by it after a minute); 模型 › 用量 › 刷新 sends `?refresh=1`. `Usage` (Core) turns the readings
  into rows: Claude Code and Codex always get a 5h and a 7d slot (no reading, or a window whose `resetsAt` has passed:
  empty bar and —), Codex carries its plan, OpenCode shows the DeepSeek balance. A daemon that is not running or has no
  route shows no usage block; errors stay quiet.
- **First-run wizard** (§6): a sheet over the settings window, 4 skippable steps; Esc (跳过引导) asks first. Progress
  is saved after each step as `setupWizard = {flowVersion, lastCompletedStep, closedAt, outcome}` in the app's user
  defaults. On launch it waits up to 30 s for the device list: a paired phone records `outcome = alreadySetUp` and
  nothing shows; otherwise it opens (resuming a wizard left open). Once closed it never opens by itself;
  通用 › 首次运行引导 › 重新运行 opens it again.

## Agents: the four agent CLIs

设置 › Agents (docs/agents-v0.md, `docs/design/concepts/agents.html`) installs, updates, switches and removes Claude Code,
Codex, OpenCode and pi. All of it is the app's: the daemon only takes the four paths (`CLAUDE_BIN`, `CODEX_BIN`,
`OPENCODE_BIN`, `PI_BIN`) at its next start. The rules are in `Sources/AgentSwitchMacCore/Agents/`, the page in
`AgentsView.swift`, the model's part in `AppModel+Agents.swift`.

- **Stable** is the vendor's own install in the vendor's own place, made by the vendor's own installer and updated by
  its own updater (`AgentNative`): Claude Code's program downloaded, checked and asked to `install stable`; Codex's,
  OpenCode's and pi's published scripts fetched and run with the PATH a terminal of the user's has, so they do what
  they do by hand. Nothing of AgentSwitch is between the shell and the CLI; with the app gone it is an ordinary install.
  Uninstalling removes the program files in the few places `AgentNative.uninstallPaths` lists, never a login, a
  setting or a session, and not while a program of it runs.
- **Beta** and **Pinned** live in the app's own store, `~/.local/share/agentswitch/cli/<agent>/<beta|pinned>/<version>/`
  (`AgentStore`): downloaded from the vendor, checked against the published digest, the signing team and what
  `--version` says, then moved into place with a `launch` script that starts that copy with its own updater off. The
  beta is on the command line as `claude-beta` / `codex-beta` / `opencode-beta` (links in `~/.local/bin`; a name that is
  somebody else's is left alone). pi has neither.
- The vendors are asked what is newest at launch, when the page opens, on `Check Now`, and whenever the last answer has
  aged twelve hours (`AgentReleaseInfo.isDue`; a vendor that did not answer is asked again after one). Nothing is ever
  installed by that: the row, the sidebar's number and a line in the setup checklist say what is newer. A missing
  executor's row in the checklist and the first-run guide has `Install`, which starts its Stable install on this page.
- Every operation is one job per agent (`AgentJob`) with its phases on the row and its log in
  `~/Library/Logs/AgentSwitch/agent-<agent>.log`, started over by the next. Downloads live in the store's `downloads/`
  for the length of the job; the store is swept at launch, and its empty folders are not kept.
- Tests use made-up vendors and a home of their own (`AgentsTests`, `AgentStoreTests`, `AgentNativeTests`); nothing is
  downloaded and the real home is never read. Three live runs are skipped unless asked for, each in a temporary home:
  `AGENTSWITCH_AGENTS_LIVE=1 swift test --filter AgentsTests/testLive` (scan this Mac, ask the vendors),
  `AGENTSWITCH_AGENTS_LIVE=store swift test --filter AgentStoreTests/testLiveStore` (the three betas, some 450 MB) and
  `AGENTSWITCH_AGENTS_LIVE=native swift test --filter AgentNativeTests/testLiveNative` (the four vendors' installers:
  install, update, uninstall; some 600 MB; `AGENTSWITCH_AGENTS_ONLY=opencode,pi` for some of them).

## Profiles, proxies and Clash

docs/profiles-v0.md, docs/clash-v0.md. All of it is the service's (`packages/daemon`); the app is the screens.

- **Profiles** (Settings › Agents, a `Profiles` part under each agent; Claude Code first): `New Profile…`, `Delete…`,
  a colour from six, and `Proxy…` — `Server`, `User Name`, `Password` (sealed by this Mac's gate before it is sent;
  `Kept` when one is stored), the exit, `Apply & Check`, `No Proxy`. A whole `http://user:pass@host:port` pasted into
  `Server` is taken apart.
- **Where a profile is chosen**: the new-terminal panel has a `Profile` row when the agent has more than one (the one
  last used is offered); a conversation's context menu has `Resume As`. A plain resume goes back under the profile
  the conversation last ran under. A running terminal under a profile carries its colour as a lit dot — in the list
  and in the status bar — round in the classic look, square in the pixel one.
- **A profile's browser**: every profile but `Default` has its own Camoufox window. The Browser page has a short list
  of browsers above the tabs (`Shared`, then one a profile); picking one makes the page that browser's; a sign-in page opened from a terminal lands there and the window is brought forward, as `Show Window`
  does (`Browser/BrowserFront.swift` looks for the browser itself, not one of its helper programs).
- **Clash** (the rail's fourth page, a cat's head): what was found of Clash Verge, the routing check, the
  subscription AgentSwitch works from, a separate proxy for Claude and for OpenAI (nodes in their order, what each
  group uses now, delays), rule templates and DNS, the addresses that go direct. Until Clash Verge runs
  AgentSwitch's subscription the page says what is still to do, with `Add to Clash Verge…`.
- The same proxies are a paired iPhone's to manage (Settings › Proxies there); the fingerprint, and making or
  removing a profile, are not.

Design previews: `-designPreview <dir> -designPreviewOnly clash|profiles|browsers|terminals|window|rail`
(`-appearance classic` for the other look).

## Nodes: using another Mac

Two Macs that both run AgentSwitch pair once and each can use the other's Dispatch, Terminals and Browser
(`docs/mesh-v0.md`; demo `docs/design/concepts/mesh.html`).

- **Settings › Nodes** (it took the place of Devices): this Mac (`Allow Pairing`, `Paired Nodes May Type`, `Paired Nodes May Read Files`), then every
  node and phone paired with it — a node with two switches, `This Mac Uses It` and `It Uses This Mac`; a phone with the
  second alone. `Pair With a Link…` takes the link another node's `Pairing` page gives (`Copy for Another Mac` lets
  Universal Clipboard carry it), reads it back, and pairs both ways unless told not.
- **The node menu** in the main window's bar, after the list's button, once this Mac uses a node: this Mac, or
  `@ <node>`. On another node the pages are that node's — a strip under the bar says so and has `[ Back to This Mac ]`;
  Clash is this Mac's own and leaves the rail.
- How: the window's pages are made anew for the node chosen, with a client whose every route is `/nodes/<id>/…` of
  this Mac's own service, which passes the requests on (`DaemonClient.onNode`, `MainWindowController.use(node:)`,
  `NodesStore`, `NodesView`). What a page assumed of "this Mac" is handled where it is: a reply's files are sent
  instead of named by path, the new terminal's folder is typed, the browser is always a picture.
- `-designPreview <dir> -designPreviewOnly nodes` draws the pane, the link sheet and the window on another node from
  sample data. `-nodesProbe <dir>` (debug builds, with `-localPort` and `AGENTSWITCH_HOME` of a service paired with
  another) drives the real window to the other node and back and writes its pictures and `calls.txt`; start the two
  services with `packages/daemon/scripts/mesh_smoke.sh` and its `MESH_SMOKE_THEN`. It also changes page once on this
  node's own pages: `page-change.png` is the window a tenth of a second in, and `calls.txt` says whether the page was
  being drawn in (the pixel look) or there at once (`-appearance classic`: no scan-line refresh, `ScanRefresh.plays`). Then it opens the other node in a window of its own (`window-node.png`), asks for that node again from the main window (the other window comes forward, the main one stays on this Mac), clicks the strip's `×` (`window-node-strip-hidden.png`) and closes that window, each with a line in `calls.txt` (`MainWindows`: a node is in one window at most; docs/mesh-v0.md §9 B 2).

## Files: the column on the right

The main window's own column on its right, above every page (`docs/files-v0.md`; demo
`docs/design/concepts/files.html`): the bar's folder icon, ⇧⌘F, a pane's icon among several and the list's
`Show in Files` open it — at the folder of the pane in focus, or where it was; home the first time. Beside the page,
or over it (`⋯` › `Float Over Page`; a window too narrow floats it by itself). The pixel look's tree, the classic look's
folders (Finder's last two columns from 460 points), the path every level of which is a button, the preview with
`Add to Reply` and `Open` (Quick Look's panel on space), the row's menu with the rest.

- What it lists is the service's (`/files…`, `DaemonClient+Files.swift`), on the node the window is on; this Mac's
  own credential places come as a name and a lock. Its state is kept by node (`files.<node>.*` in the defaults).
- `Add to Reply` gives the selection to the pane in focus (its record's reply as `[File #n]`, or typed at its
  terminal's cursor), or to Dispatch's input. A file that may hold a password is asked about first — over the reply
  box or the screen, the alert where there is neither — whether it came from the column or from Finder
  (`FilesSensitive.swift`, the service's table for this Mac's paths); its chip is marked.
- `Settings › Nodes`: `Paired Nodes May Read Files`, and each paired device's `Files` scope (`Home Folder`,
  `All Files`, `Selected Folders`, `None`).
- Code: `Sources/AgentSwitchMac/Files/` (`FilesColumn` the model, `FilesColumnView`, `FilesListViews`,
  `FilesPreviewViews`), the rules without AppKit in `Sources/AgentSwitchMacCore/Files/` (`FilesTests`).
- `-designPreview <dir> -designPreviewOnly files` draws the window with the column over a made-up disk (`files-*.png`,
  `-appearance pixel|classic`). `-filesProbe <dir> -probeFolder <path>` (debug builds, with `-localPort` and
  `AGENTSWITCH_HOME` of a throw-away service) drives the real column against it — the folder read, a folder opened, a
  file's details and text, the keys, the next look after a file is added, the service's locked places — into
  `files.txt` and `files-*.png`.

## Sandbox and signing

No App Sandbox: the app has to spawn user-installed CLIs through the daemon, and let its children bind ports; a sandboxed parent would pass its sandbox on to all of them.
Hardened runtime is off and the bundle is ad-hoc signed; release signing and notarization are out of scope (§7).

## Overrides (smoke tests, development)

Environment: `AGENTSWITCH_HOME`, `SECRET_GATE_HOME`, `AGENTSWITCH_APP_LOGS`; `AGENTSWITCH_APP_RUNTIME` in Debug
builds only.
User defaults (settable as launch arguments, which do not persist): `-localPort -remotePort -opencodePort`,
`-executors echo -router echo`, `-remoteAccess NO`, `-openSettings <tab>`, `-onboarded YES` (no first-run wizard on
that launch), `-snapshotDir <dir>`
(renders the menu and every settings tab to PNG, then quits); `-runtimeRoot <dir>` in Debug builds only. A Release
build runs only the runtime inside its own bundle: a user default persists and any process of the user can write it.

Browser probe (Debug builds, docs/browser-v0.md §1 Mac): `AGENTSWITCH_HOME=<home of a running service> .build/debug/AgentSwitchMac -browserProbe <dir> -localPort <port>` opens the main window's Browser page behind the other windows, writes a test page into `<dir>` and opens it in a new tab (`browser.png`), clicks its field and types into it through the screen (keys, Chinese committed as an input method commits, Return; `browser-typed.png`), zooms the page with the window's keys (⌘= twice to 125 %, a click on the field and a letter typed at that zoom, `browser-zoom.png`; ⌘− to 110 %; two more to 90 %; then back to 100 %), takes the tab over (`browser-held.png`, the tab at the screen's size), hands it back, runs the remaining `BrowserService` calls (a refused path among them) into `probe.txt`, closes the tab and quits. In `probe.txt` every line of a size (`claimed`, the four `zoom …`, `list closed`, `list open`, `after the drag`, `after the reset`) reads `yes` on a healthy run: the frame came at the display's pixels times the zoom, and each is drawn on one of the display's. 110 % is the step at a scale between quarters (2.2 frame pixels to a CSS pixel on a 2x display), which the daemon draws as asked since 2026-10-03; `no` on that line alone, its frame at the quarter below (`scale 2.0`), is a service that still draws in quarter steps (the page in the same place, enlarged from fewer pixels). The daemon's Chrome runs on that throw-away home's profile; `<dir>` must lie outside it.
Against a service whose browser has windows of its own (Camoufox installed, docs/browser-v0.md §7) the same probe takes another walk (`BrowserProbe+Windows.swift`; real Camoufox windows open): a tab opened by the service while another app is in front (the front goes back to that app, `BrowserFrontKeeper`), the detail pane and its still picture (`window.png`), `Show Window`, the identity box (`identity.png`), a proxy applied (`-browserProbeProxy <scheme://host:port>`: a stand-in on this Mac that answers every outside name and the exit lookup the service was started with, `AGENTSWITCH_BROWSER_EXIT_LOOKUP=http://exit.test/json`), a tab through it, `Restart Browser`, `Direct`, `New Fingerprint`, the tabs closed. `-browserProbeMode engine` on a service without Camoufox walks the engine's box instead: not installed, `Download` for ten seconds (a real download), `Cancel`. Every line of `probe.txt` reads `ok` on a healthy run.

The vendored SwiftTerm's patches have tests of their own (`Vendor/SwiftTerm/PATCHES.md`): `cd Vendor/SwiftTerm && swift test`
(which rows are sent to be drawn again, and that a screen drawn only where the view asks is the screen drawn whole).

Perf probe (Debug builds, docs/app-v0.md §4 省电): `.build/debug/AgentSwitchMac -perfProbe <dir> [-perfPhases terminals:15,dispatch:15,back:15,mini:15,hide:15] [-perfAlpha 0.05]` plays the main window through phases, a number of seconds each — a page shown in front of every other window (nearly transparent and letting clicks through, so it stays out of the way), `back` behind the other windows, `mini` minimised, `hide` the app hidden (put those last: the probe does not bring the window back) — writing each phase's start to `<dir>/phases.txt` for `ps -o time= -p <pid>` or `sample <pid> 3` from outside (`-perfShots YES` with `-perfAlpha 1` also writes the window as the window server has it at the end of each phase), then quits. With `-probeTerminal <id> -localPort <port>` and `AGENTSWITCH_HOME` of a running service (as the Dispatch probe's) it is the real window on that terminal, its size taken; without, the design preview's window from made-up work (Dispatch's tasks busy and waiting). Measure an optimized build: `swift build -c release -Xswiftc -DDEBUG` (the probes exist in Debug builds only).

Design preview (Debug builds, docs/ui-v0.md §5): `swift build && .build/debug/AgentSwitchMac -designPreview <dir>`
loads sample data (DemoData.swift; DemoTransport answers the daemon routes in-process, PUTs included), draws the menu
panel and every settings page off-screen to PNG in light and dark, plus
`settings-general-workdir-problem`, a fresh Mac (`menu-fresh`, `settings-environment-fresh`), each wizard step
(`wizard-1-executors` … `wizard-4-done`), the menu bar's Live Activity (`live-*`) and the main window (MainWindowPreview.swift: `main-dispatch`,
`main-terminals` in both looks, the terminal page replaced by a stand-in; `main-refresh-2/6/10`
and `main-refresh-dispatch-2/6/10`, steps of the refresh that draws a page in; `main-browser*` from a made-up browser,
BrowserDemo.swift, and `main-refresh-browser-6`; `main-rail-hidden`, `main-rail-hidden-dispatch`, `main-rail-quiet` and
`main-rail-out`, the rail put away — its bars on the window's edge — and out again under the pointer), then quits. It takes no lock, starts nothing and opens no socket, so it runs next to the installed app;
`-designPreviewTall YES` adds each page at 1500 pt to see it whole. `-designPreviewOnly agents` only 设置 › Agents (`settings-agents`, `-fresh`, `-full`, `-jobs`; docs/agents-v0.md); `-designPreviewOnly browser` only the Browser page; `-designPreviewOnly item` only a terminal's own window (`item-plain`, `item-approval`, `item-question`, `item-seal`, `item-away`, `item-notice`, in the look given by `-appearance pixel|classic`); `-designPreviewOnly window` only the main window's pictures and the Live Activity's; `-designPreviewOnly rail` only the rail put away. An off-screen window belongs to an inactive app, so

The Terminals page is native (docs/terminal-v0.md §1 “Terminals 页全原生”, 2026-10-05): `Sources/AgentSwitchMac/Terminals/` — the list, the panes, the new-terminal panel, the questions — over rules without AppKit in `AgentSwitchMacCore/Terminals/` (`TerminalPanes`, `TerminalTree`, `TerminalSearch`, `TerminalsPageRules`; `TerminalPanesTests`, `TerminalTreeTests`, `TerminalsPageRulesTests`). `-designPreviewOnly terminals` draws it from made-up work (the list's filter among it: `terminals-filter`, `-active`, `-recent`, `-none`; `TerminalListFilter`, 2026-10-11); `-terminalProbe <dir> -probeTerminal <id> -probeTerminals <another id>` uses the real page against a throw-away service and writes `probe.txt` and `page-*.png`. `-terminalProbe <dir> -probeTerminal <id> -probeBeside YES` (against a throw-away service with earlier sessions listed) goes on with a session beside what the page shows — the row's action, or with `-probeBesideAt x,y` a ⌘ click at that point of the window's picture — and with `-probePick x,y1,y2` picks sessions by clicks and deletes them together (docs/terminal-v0.md §5 批量删除); `probe.txt`, `beside-*.png`, `pick-*.png`. `-terminalProbe <dir> -probeTerminal <id> -probeKeys YES` types ↩, ⇧↩, ⌃↩ and the keypad's ⌃Enter into the native screen and writes what the program's screen held after each (run it on a stand-in that prints the bytes it gets): ⌃↩ is the program's key, not macOS 15's context-menu shortcut (docs/terminal-v0.md §1 Mac, 2026-10-11). The daemon's page in a web view stays behind `defaults write com.agentswitch.mac terminalsPageWeb -bool YES` for now. `-designPreview <dir> -designPreviewOnly record-turn` plays what a session does to a long record in a pane's simple view — a turn ending, the record read again, the reader scrolled back, `Earlier`, a part opened, a long reply, a reply taken back to one line (`shrinks`, which says `MOVING` when the box keeps changing on its own), the agent's suggestion taken with Tab and the box made again (`tab`, which says `PUT IN AGAIN` when the box puts it in a second time), another session's messages (`peer`), what it is writing at the record's end (`writing`) — and writes `turn.txt` (where the scroller stands, how much of the pane is drawn on, how many items are shown) and `turn-<scene>-<step>.png`; `-probeOnScreen YES` puts the window on screen behind the others (the clicks need it, and the blank pane of 2026-10-13 showed only there), `-probeScene <name>` plays one scene, `-probeReal YES` uses a session with the sizes a real one has, `-probePerf YES` says what a record costs to lay out (`RecordTurnProbe`; docs/simple-view-v0.md §5.2). A simple view lays out the latest 60 items of its record, all of them (no lazy stack: `SessionRecord.shownFrom`, `RecordEnd`; `SessionRecordTests`). An answer's prose — paragraphs, headings, lists, quotes, rules next to each other — is one AppKit text (`ProseText`), so a drag selects across it; code and tables stay views of their own. `-designPreview <dir> -designPreviewOnly prose-select` checks that the pointer meets one text over a paragraph and a list, what a selection between them holds, and that the wheel over the text reaches the column's scroller (`select.txt`, `select.png`); `-proseApart YES` (debug) draws every block as its own view again, for comparing. `-designPreview <dir> -designPreviewOnly room -roomData <dir>` draws a room's two terminals on the Terminals page from what a real trial left (`packages/daemon/scripts/room_trial.ts`): each session's record in a simple view, the list holding those two alone (`RoomPreview`; docs/talk-v0.md §9). A screen fed by a preview has no service to ask for its colours: `TerminalScreenController.probeStyle` gives it the user's.

A terminal in a window of its own (docs/dispatch-v0.md §1 单独的窗口): `Sources/AgentSwitchMac/ItemWindow/` — all native, no web view; the rules that need no AppKit are in `AgentSwitchMacCore/TerminalWindow.swift` (`TerminalWindowTests`). `-terminalProbe <dir> -probeTerminal <id> -probeSimple YES` (against a throw-away service) switches the pane to the simple view (docs/simple-view-v0.md §5.2) and back — what the record holds, the request waiting, how the window is dressed, a reply sent from its box and found on the terminal's screen — with pictures `simple-record.png` and `simple-terminal.png`. `-terminalProbe <dir> -probeTerminal <id> -probeDetach YES` (against a throw-away service) puts the terminal out through the page's own message, uses the new window — typing, a request's card, a question, the sealed reply, the placeholder, ⌘W — and takes it back, writing what it saw to `probe.txt` and pictures `item-*.png` beside it.
prominent buttons, toggles and the sidebar selection are drawn in their inactive grey there.

```bash
node scripts/smoke.mjs --app build/AgentSwitch.app --work /tmp/as-smoke       # bundled gate + daemon, phone simulated
node scripts/smoke.mjs --app build/AgentSwitch.app --work <dir> --attach      # against an app already running them
node scripts/fake-daemon.mjs --port 4811                                      # stand-in for the management routes
```

The app itself against throw-away homes (its data directory has its own instance lock, so this runs next to the
user's copy; `-remoteAccess NO` keeps it off the network and out of Bonjour):

```bash
W=$(mktemp -d)
AGENTSWITCH_HOME=$W/as SECRET_GATE_HOME=$W/sg AGENTSWITCH_APP_LOGS=$W/logs \
  build/next/AgentSwitch.app/Contents/MacOS/AgentSwitch -localPort 5211 -remotePort 5213 -opencodePort 5214 \
  -executors echo -router echo -onboarded YES -remoteAccess NO &
```

## Layout

| path | what |
|---|---|
| `Sources/AgentSwitchMacCore` | pure logic: paths, ports, child env, login PATH, supervision machine + process supervisor, leftovers + instance lock, probes, daemon client + models, work dir models, usage rows, pairing link + QR, sensitive clipboard, harness/Tailscale detection, login commands + shell quoting, setup checklist, first-run wizard state, Bonjour TXT, status text, main window (pages, shortcuts, refresh), what the pages share (`Shared/`: Markdown, uploads, the streams' transport), the shared browser's client, stream, geometry, page zoom, input and keys (`Browser/`) |
| `Sources/AgentSwitchMac` | SwiftUI app: `AppModel` + `ControlSettings` (the work dir), menu panel, settings window (AppKit-hosted) and its pages, first-run wizard, Bonjour advertiser, snapshot runner, design preview, main window (`MainWindow/`) with its Terminals (`Terminals/`), Dispatch and Chat Room (`Rooms/`) and Browser (`Browser/`) pages, and the views they share (`Shared/`) |
| `Tests/AgentSwitchMacCoreTests` | `swift test` |
| `project.yml` | xcodegen spec (bundle id `com.agentswitch.mac`); the generated `.xcodeproj` is git-ignored |
| `scripts/` | `build-app.sh`, `runtime-pins.sh` (Node/Python pins), `lock-python.sh` + `python-constraints.txt` → `python-requirements.txt`, `python-build-requirements.txt`, `smoke.mjs`, `fake-daemon.mjs`, `make-icons.swift` |
