# mac-app

AgentSwitch for macOS (docs/app-v0.md §4): a menu-bar app (`LSUIElement`, SwiftUI `MenuBarExtra`) that ships its
own Node, Python, daemon and secret-gate, supervises `secret-gate proxy` and `agentswitchd`, pairs iPhones by QR
code and advertises itself over Bonjour. With the credential gate installed as a system service
(docs/gate-service-v0.md, [below](#credential-gate-as-a-system-service)) the app no longer runs the gate itself. Claude Code / Codex / OpenCode stay the user's own installs; the app
detects them and says how to install or log in.

```
menu bar ── 服务 · 凭据网关 · iPhone · Tailscale · 用量 (5h / 7d bars, OpenCode balance)      [配对新设备…] [打开网页控制台] [重启服务] [设置…] [退出]
设置窗口 ── 配对 (QR + code + countdown) · 设备 (revoke) · 模型 (用量 on top) · 权限 · 密钥 · 环境 (设置清单 on top) · 通用
首次运行 ── 设置窗口上的引导：执行器 → 配对手机 → 权限与启动 → 完成
```

## Build

```bash
cd packages/mac-app
swift test                      # Core unit + integration tests (dev secret-gate venv and node are used when present)
scripts/build-app.sh            # → build/AgentSwitch.app, ad-hoc signed
APP_OUT=build/next/AgentSwitch.app scripts/build-app.sh   # same, elsewhere (the script refuses to replace a running app)
swift run AgentSwitchMac        # UI development without a bundle; point it at a runtime with -runtimeRoot <dir>
```

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
| gate (no service installed) | `runtime/python/bin/secret-gate proxy --port <gate>` | `SECRET_GATE_HOME`, minimal PATH | SIGTERM |
| daemon | `runtime/node/bin/node --no-warnings=ExperimentalWarning runtime/daemon/dist/cli.js serve` | below | SIGINT |

Daemon env: `AGENTSWITCH_HOME=~/Library/Application Support/AgentSwitch`, `AGENTSWITCH_PORT`, `AGENTSWITCH_REMOTE=1`
with `AGENTSWITCH_REMOTE_PORT` and `AGENTSWITCH_REMOTE_NAME=<Mac name>` (or `AGENTSWITCH_REMOTE=0` and neither while
通用 › 允许 iPhone 连接 is off), `AGENTSWITCH_OPENCODE_PORT`, `AGENTSWITCH_EXECUTORS=real`,
`SECRET_GATE_HOME=~/.secret-gate`, `SECRET_GATE_BIN=<bundled wrapper>`, `SECRET_GATE_PROXY=http://127.0.0.1:<gate>`
(in service mode also `SECRET_GATE_PUBLIC=<root>/gate-public` and `SECRET_GATE_CA=<root>/gate-public/ca.pem`),
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
  lies in this bundle's runtime (real paths), so a reused pid or another copy's child is never signalled. A busy
  gate port is reused only when it answers the `secret-gate bootstrap` probe with `403 X-Secret-Gate: denied`;
  anything else is an error for the user. Health is
  polled every 3 s (gate probe, daemon `/healthz`); a child failing its check for long is restarted; an adopted
  gate that disappears is replaced by our own, except while the gate service is installed: the gate preflight refuses
  to launch `secret-gate proxy` whenever `gate-service.json` or `gate.sock` exists, whatever asked for it. Quit (menu, SIGTERM, logout) stops the daemon then the gate.
- **First run** (no service installed): a `default` keypair when `~/.secret-gate` has none; `~/.secret-gate/ca.pem`
  copied from `~/.mitmproxy/mitmproxy-ca-cert.pem` once the proxy has created it. The login-keychain trust step of
  `secret-gate install-ca` runs only from the 环境 tab's button.
- **Logs**: `~/Library/Logs/AgentSwitch/{daemon,gate}.log` (0600, rotated at 10 MB on start).
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
- **权限** (docs/control-v0.md §1): `GET|PUT /approvals/policy` — 逐项确认 (manual) · 自动 (scoped; the categories that
  still ask are checkboxes) · 全部自动 (auto) · 跳过权限 (skip, only after a confirmation listing what still holds).
  Saved at once; the daemon applies it to approvals from then on.
- **默认工作目录** (§2, 通用): `GET|PUT /settings/workdir`; 选择… is an open panel (folders, new ones allowed), 恢复默认
  sends the daemon's default; a 400 is shown in the daemon's words. Read again every minute by the poll.
- **设置清单** (§6, top of 环境; count in the menu panel as N 项设置未完成): each harness installed and logged in, the
  credential gate service installed, answering and current (after its install also the keychain rows), a paired
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

## Credential gate as a system service

docs/gate-service-v0.md §4 (Mac 应用). The gate runs as two LaunchDaemons under the role account `_agentswitchgate`
from a root-owned copy of the runtime in `/Library/Application Support/AgentSwitch/` (`<root>`); this user reaches it
only through `<root>/gate-public/` (`gate.sock`, `keys.json`, `ca.pem`). Core: `GateService.swift` (paths, status,
state, update check, health), `GateServiceAdmin.swift` (root commands), `GateServiceText.swift` (checklist rows,
status words); app: `AppModel+GateService.swift`, `GateServiceViews.swift`.

- **Detection** (launch, before any child starts): `secret-gate system status --json` (no root) →
  `{installed, running, proxyPort, runtimeVersion, ownerUid, publicDir}`, plus `<root>/gate-service.json` and
  `gate-public/gate.sock` read from disk. Service mode as soon as any of the three says installed (the record and the
  socket are owned by root / the service account, so no process of this user can make them vanish). An older bundled
  secret-gate without `system` (argparse `invalid choice`) and nothing on disk: no service row at all.
- **Service mode**: no gate child, no `ensureKeypair`, no CA copy from `~/.mitmproxy`; the gate port is the
  service's `proxyPort`; the daemon and every CLI call get `SECRET_GATE_PUBLIC` and `SECRET_GATE_CA`; the CA shown and
  trusted is `gate-public/ca.pem`. Health every 3 s: `gate.sock` present and the proxy passing the bootstrap probe,
  `system status` every 30 s (9 s while unhealthy). Two misses in a row: 凭据网关服务无响应 (red, menu and 环境) with
  修复 (= `system update`); the app never falls back to a gate of its own. In user mode every poll also looks for
  the record / socket, so a service installed outside the app is picked up (own gate stopped, daemon restarted).
- **Operations** (环境 › 凭据网关服务, the checklist row 凭据网关服务, the wizard's 权限与启动 step, 通用 › 端口, the
  menu's 凭据网关有更新 › 更新… which opens 环境 with the sheet): a sheet says what will happen, then one
  administrator prompt runs the bundled CLI as root:

  ```text
  install:   <gate> system install --owner-uid <getuid()> --port <gate port> --runtime <runtime> --migrate-from ~/.secret-gate
  update:    <gate> system update --runtime <runtime>                (修复 is the same)
  port:      <gate> system update --runtime <runtime> --port <N>
  uninstall: <gate> system uninstall [--delete-keys]
  ```

  `<gate>` is `<runtime>/python/bin/secret-gate`, `<runtime>` is `AgentSwitch.app/Contents/Resources/runtime`. Every
  word goes through `ShellQuote` and the line is `/usr/bin/env -i PATH=/usr/bin:/bin:/usr/sbin:/sbin LANG=en_US.UTF-8
  <argv…> 2>&1; echo "__AGENTSWITCH_EXIT__=$?"` (the command's output survives a failure, its exit status is the last
  line). It reaches AppleScript as `argv`, never in the script text:
  `osascript -e 'on run argv' -e 'do shell script (item 1 of argv) with prompt (item 2 of argv) with administrator
  privileges without altering line endings' -e 'end run' <line> <prompt>`. Error -128 (prompt closed) is a quiet
  已取消; otherwise the sheet shows the result line and the command's output. Install first stops the daemon and the
  gate child (the keys move, the port changes hands) and refuses when the gate port is still taken by a gate the app
  did not start; uninstall stops the daemon. Afterwards the app detects again and switches mode (install → service,
  uninstall → own gate with a new `default` keypair), then restarts the daemon.
- **Updates**: `runtimeVersion` is `<secret-gate>+<built>` from the installed runtime's VERSIONS. The status
  command's own `updateAvailable` (it compares with the runtime it runs from, the bundle's) decides; without it (the
  record read directly) the bundle's `built=` must be contained in `runtimeVersion`. Different: 凭据网关有更新 in the
  menu and in 环境. The status command's `error` shows under 环境 › 凭据网关服务.
- **Keychain**: before installing, a copy of the CA this user trusted (if any) goes to
  `$AGENTSWITCH_HOME/gate-previous-ca.pem`. In service mode, while that copy exists, the checklist offers 旧网关证书 ›
  移除 (`security remove-trusted-cert <copy>`, then `security delete-certificate -Z <SHA-1> login.keychain-db`) and
  网关证书 › 加入 (the existing `add-trusted-cert` on `gate-public/ca.pem`); both only on click. Once the old one is out
  and the new one in, the copy is deleted.
- **密钥**: `keys --json` rows carry `legacy`; legacy keys show 已停用（仅解密）, no 设为当前, and 删除 after a
  confirmation (`keys --json retire <name>`). 新建 / 设为当前 as before (the CLI talks to the socket).
- **Logs**: 通用 › gate.log opens a sheet with `secret-gate logs tail --name proxy|rpc --lines 300`.
- **Development**: `AGENTSWITCH_GATE_SERVICE_ROOT=<prefix>` (Debug builds only) points the app at a service installed
  with `system install --root <prefix>`.

No App Sandbox: the app has to spawn user-installed CLIs through the daemon, read `~/.secret-gate` and
`~/.mitmproxy`, and let its children bind ports; a sandboxed parent would pass its sandbox on to all of them.
Hardened runtime is off and the bundle is ad-hoc signed; release signing and notarization are out of scope (§7).

## Overrides (smoke tests, development)

Environment: `AGENTSWITCH_HOME`, `SECRET_GATE_HOME`, `AGENTSWITCH_APP_LOGS`; `AGENTSWITCH_APP_RUNTIME` in Debug
builds only.
User defaults (settable as launch arguments, which do not persist): `-localPort -remotePort -gatePort -opencodePort`,
`-executors echo -router echo`, `-remoteAccess NO`, `-openSettings <tab>`, `-onboarded YES` (no first-run wizard on
that launch), `-snapshotDir <dir>`
(renders the menu and every settings tab to PNG, then quits); `-runtimeRoot <dir>` in Debug builds only. A Release
build runs only the runtime inside its own bundle: a user default persists and any process of the user can write it.

Dispatch probe (Debug builds): `AGENTSWITCH_HOME=<home of a running service> .build/debug/AgentSwitchMac -dispatchProbe <dir> -localPort <port> [-probeTask <id>] [-probeCalls YES]` opens the main window's Dispatch page behind the other windows against that service, writes `record.png` (and `task.png`), and with `-probeCalls` runs every `DispatchService` call once (reads, a message sent, a question answered, an approval allowed) into `calls.txt`. Use a throw-away service: `AGENTSWITCH_ROUTER=echo AGENTSWITCH_EXECUTORS=echo` with its own `AGENTSWITCH_HOME` and port (clear inherited `AGENTSWITCH_*` variables first, e.g. with `env -i`).

Browser probe (Debug builds, docs/browser-v0.md §1 Mac): `AGENTSWITCH_HOME=<home of a running service> .build/debug/AgentSwitchMac -browserProbe <dir> -localPort <port>` opens the main window's Browser page behind the other windows, writes a test page into `<dir>` and opens it in a new tab (`browser.png`), clicks its field and types into it through the screen (keys, Chinese committed as an input method commits, Return; `browser-typed.png`), zooms the page with the window's keys (⌘= twice to 125 %, a click on the field and a letter typed at that zoom, `browser-zoom.png`; ⌘− to 110 %; two more to 90 %; then back to 100 %), takes the tab over (`browser-held.png`, the tab at the screen's size), hands it back, runs the remaining `BrowserService` calls (a refused path among them) into `probe.txt`, closes the tab and quits. In `probe.txt` every line of a size (`claimed`, the four `zoom …`, `list closed`, `list open`, `after the drag`, `after the reset`) reads `yes` on a healthy run: the frame came at the display's pixels times the zoom, and each is drawn on one of the display's. 110 % is the step at a scale between quarters (2.2 frame pixels to a CSS pixel on a 2x display), which the daemon draws as asked since 2026-10-03; `no` on that line alone, its frame at the quarter below (`scale 2.0`), is a service that still draws in quarter steps (the page in the same place, enlarged from fewer pixels). The daemon's Chrome runs on that throw-away home's profile; `<dir>` must lie outside it.

Perf probe (Debug builds, docs/app-v0.md §4 省电): `.build/debug/AgentSwitchMac -perfProbe <dir> [-perfPhases terminals:15,dispatch:15,back:15,mini:15,hide:15] [-perfAlpha 0.05]` plays the main window through phases, a number of seconds each — a page shown in front of every other window (nearly transparent and letting clicks through, so it stays out of the way), `back` behind the other windows, `mini` minimised, `hide` the app hidden (put those last: the probe does not bring the window back) — writing each phase's start to `<dir>/phases.txt` for `ps -o time= -p <pid>` or `sample <pid> 3` from outside (`-perfShots YES` with `-perfAlpha 1` also writes the window as the window server has it at the end of each phase), then quits. With `-probeTerminal <id> -localPort <port>` and `AGENTSWITCH_HOME` of a running service (as the Dispatch probe's) it is the real window on that terminal, its size taken; without, the design preview's window from made-up work (Dispatch's tasks busy and waiting). Measure an optimized build: `swift build -c release -Xswiftc -DDEBUG` (the probes exist in Debug builds only).

Design preview (Debug builds, docs/ui-v0.md §5): `swift build && .build/debug/AgentSwitchMac -designPreview <dir>`
loads sample data (DemoData.swift; DemoTransport answers the daemon routes in-process, PUTs included), draws the menu
panel and every settings page off-screen to PNG in light and dark, plus `settings-permissions-skip`,
`settings-general-workdir-problem`, a fresh Mac (`menu-fresh`, `settings-environment-fresh`), each wizard step
(`wizard-1-executors` … `wizard-4-done`) and the gate service (`menu-gate-*` and `settings-environment-gate-*` for
not-installed / installing / installed / not-responding / update, `settings-keys-user-process`, `sheet-gate-*` for
install, installing, installed, install-failed, install-cancelled, update, port, uninstall, uninstall-delete-keys,
log), the menu bar's Live Activity (`live-*`) and the main window (MainWindowPreview.swift: `main-dispatch`,
`main-dispatch-task`, `main-terminals` in both looks, the terminal page replaced by a stand-in; `main-refresh-2/6/10`
and `main-refresh-dispatch-2/6/10`, steps of the refresh that draws a page in; `main-browser*` from a made-up browser,
BrowserDemo.swift, and `main-refresh-browser-6`; `main-rail-hidden`, `main-rail-hidden-dispatch`, `main-rail-quiet` and
`main-rail-out`, the rail put away — its bars on the window's edge — and out again under the pointer), then quits. The default sample runs the gate as the installed service (密钥 shows the legacy keys). It takes no lock, starts nothing and opens no socket, so it runs next to the installed app;
`-designPreviewTall YES` adds each page at 1500 pt to see it whole. `-designPreviewOnly dispatch` renders only the settings window's Dispatch group (about 20 s); `-designPreviewOnly browser` only the Browser page; `-designPreviewOnly item` only a terminal's own window (`item-plain`, `item-approval`, `item-question`, `item-seal`, `item-away`, `item-notice`, in the look given by `-appearance pixel|classic`); `-designPreviewOnly window` only the main window's pictures and the Live Activity's; `-designPreviewOnly rail` only the rail put away. An off-screen window belongs to an inactive app, so

The Terminals page is native (docs/terminal-v0.md §1 “Terminals 页全原生”, 2026-10-05): `Sources/AgentSwitchMac/Terminals/` — the list, the panes, the new-terminal panel, the questions — over rules without AppKit in `AgentSwitchMacCore/Terminals/` (`TerminalPanes`, `TerminalTree`, `TerminalSearch`, `TerminalsPageRules`; `TerminalPanesTests`, `TerminalTreeTests`, `TerminalsPageRulesTests`). `-designPreviewOnly terminals` draws it from made-up work; `-terminalProbe <dir> -probeTerminal <id> -probeTerminals <another id>` uses the real page against a throw-away service and writes `probe.txt` and `page-*.png`. The daemon's page in a web view stays behind `defaults write com.agentswitch.mac terminalsPageWeb -bool YES` for now.

A terminal in a window of its own (docs/dispatch-v0.md §1 单独的窗口): `Sources/AgentSwitchMac/ItemWindow/` — all native, no web view; the rules that need no AppKit are in `AgentSwitchMacCore/TerminalWindow.swift` (`TerminalWindowTests`). `-terminalProbe <dir> -probeTerminal <id> -probeDetach YES` (against a throw-away service) puts the terminal out through the page's own message, uses the new window — typing, a request's card, a question, the sealed reply, the placeholder, ⌘W — and takes it back, writing what it saw to `probe.txt` and pictures `item-*.png` beside it.
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
  -gatePort 8290 -executors echo -router echo -onboarded YES -remoteAccess NO &
```

## Layout

| path | what |
|---|---|
| `Sources/AgentSwitchMacCore` | pure logic: paths, ports, child env, login PATH, supervision machine + process supervisor, leftovers + instance lock, probes, daemon client + models, approval policy + work dir models, usage rows, pairing link + QR, sensitive clipboard, harness/Tailscale detection, login commands + shell quoting, setup checklist, first-run wizard state, gate CLI + CA, gate service (state, root commands, texts), Bonjour TXT, status text, main window (pages, shortcuts, refresh), Dispatch (`Dispatch/`), the shared browser's client, stream, geometry, page zoom, input and keys (`Browser/`) |
| `Sources/AgentSwitchMac` | SwiftUI app: `AppModel` (+ `AppModel+GateService`) + `ControlSettings` (policy, work dir), menu panel, settings window (AppKit-hosted) and its pages, first-run wizard, Bonjour advertiser, snapshot runner, design preview, main window (`MainWindow/`) with its Dispatch (`Dispatch/`), Terminals and Browser (`Browser/`) pages |
| `Tests/AgentSwitchMacCoreTests` | `swift test` |
| `project.yml` | xcodegen spec (bundle id `com.agentswitch.mac`); the generated `.xcodeproj` is git-ignored |
| `scripts/` | `build-app.sh`, `runtime-pins.sh` (Node/Python pins), `lock-python.sh` + `python-constraints.txt` → `python-requirements.txt`, `python-build-requirements.txt`, `smoke.mjs`, `fake-daemon.mjs`, `make-icons.swift` |
