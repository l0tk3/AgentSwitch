# mac-app

AgentSwitch for macOS (docs/app-v0.md §4): a menu-bar app (`LSUIElement`, SwiftUI `MenuBarExtra`) that ships its
own Node, Python, daemon and secret-gate, supervises `secret-gate proxy` and `agentswitchd`, pairs iPhones by QR
code and advertises itself over Bonjour. Claude Code / Codex / OpenCode stay the user's own installs; the app
detects them and says how to install or log in.

```
menu bar ── 守护进程 · 凭据网关 · 远程监听 · 局域网 · Tailscale · 已配对设备      [配对新设备…] [设置…] [网页控制台] [重启服务] [退出]
设置窗口 ── 配对 (QR + code + countdown) · 设备 (revoke) · 模型 · 密钥 · 环境 · 通用
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
| gate | `runtime/python/bin/secret-gate proxy --port <gate>` | `SECRET_GATE_HOME`, minimal PATH | SIGTERM |
| daemon | `runtime/node/bin/node --no-warnings=ExperimentalWarning runtime/daemon/dist/cli.js serve` | below | SIGINT |

Daemon env: `AGENTSWITCH_HOME=~/Library/Application Support/AgentSwitch`, `AGENTSWITCH_PORT`, `AGENTSWITCH_REMOTE=1`
with `AGENTSWITCH_REMOTE_PORT` and `AGENTSWITCH_REMOTE_NAME=<Mac name>` (or `AGENTSWITCH_REMOTE=0` and neither while
通用 › 允许 iPhone 连接 is off), `AGENTSWITCH_OPENCODE_PORT`, `AGENTSWITCH_EXECUTORS=real`,
`SECRET_GATE_HOME=~/.secret-gate`, `SECRET_GATE_BIN=<bundled wrapper>`, `SECRET_GATE_PROXY=http://127.0.0.1:<gate>`,
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
  gate that disappears is replaced by our own. Quit (menu, SIGTERM, logout) stops the daemon then the gate.
- **First run**: a `default` keypair when `~/.secret-gate` has none; `~/.secret-gate/ca.pem` copied from
  `~/.mitmproxy/mitmproxy-ca-cert.pem` once the proxy has created it. The login-keychain trust step of
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

No App Sandbox: the app has to spawn user-installed CLIs through the daemon, read `~/.secret-gate` and
`~/.mitmproxy`, and let its children bind ports; a sandboxed parent would pass its sandbox on to all of them.
Hardened runtime is off and the bundle is ad-hoc signed; release signing and notarization are out of scope (§7).

## Overrides (smoke tests, development)

Environment: `AGENTSWITCH_HOME`, `SECRET_GATE_HOME`, `AGENTSWITCH_APP_LOGS`; `AGENTSWITCH_APP_RUNTIME` in Debug
builds only.
User defaults (settable as launch arguments, which do not persist): `-localPort -remotePort -gatePort -opencodePort`,
`-executors echo -router echo`, `-remoteAccess NO`, `-openSettings <tab>`, `-onboarded YES`, `-snapshotDir <dir>`
(renders the menu and every settings tab to PNG, then quits); `-runtimeRoot <dir>` in Debug builds only. A Release
build runs only the runtime inside its own bundle: a user default persists and any process of the user can write it.

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
| `Sources/AgentSwitchMacCore` | pure logic: paths, ports, child env, login PATH, supervision machine + process supervisor, leftovers + instance lock, probes, daemon client + models, pairing link + QR, sensitive clipboard, harness/Tailscale detection, gate CLI + CA, Bonjour TXT, status text |
| `Sources/AgentSwitchMac` | SwiftUI app: `AppModel`, menu panel, settings window (AppKit-hosted), Bonjour advertiser, snapshot runner |
| `Tests/AgentSwitchMacCoreTests` | `swift test` |
| `project.yml` | xcodegen spec (bundle id `com.agentswitch.mac`); the generated `.xcodeproj` is git-ignored |
| `scripts/` | `build-app.sh`, `runtime-pins.sh` (Node/Python pins), `lock-python.sh` + `python-constraints.txt` → `python-requirements.txt`, `python-build-requirements.txt`, `smoke.mjs`, `fake-daemon.mjs`, `make-icons.swift` |
