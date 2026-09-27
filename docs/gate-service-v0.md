# gate-service-v0：凭据网关以独立服务账户运行

2026-09-27 用户要求：“改一下密钥生成的逻辑，当时说要新建一个用户，这样更保险”，并问 Mac 上有没有不用登录的轻量用户。这是 design-v0 §3“私钥隔离”一行、design-v0 M0 前置和 gate-next-v0 §3“未做”里一直欠着的一步。本文是 secret-gate、daemon、Mac 应用三边的共同约定。

用户当场定下的三件事：旧密钥**迁入服务并新建当前密钥**；浏览器**仍以用户身份运行**；**先改文档再实现**，装到本机（建账户、装系统服务）前先停下来问。

## 1. 边界

**做到的**：以登录用户身份运行的一切（daemon、三个执行器和它们的 shell、用户自己的程序）在文件系统层面读不到这些东西——凭据网关的私钥、mitmproxy CA 私钥、短引用库、审计日志、网关的可信配置（exec 模板、上游证书例外、截图遮挡）。解密只在服务进程里发生：

| 用途 | 在哪里用明文 | 明文会不会到登录用户的进程 |
|---|---|---|
| http（代理替换、`secret_http`） | 服务内 | 不会 |
| exec（`secret_exec`） | 服务内以服务账户跑模板命令 | 不会（命令行参数对本机所有用户可见，这一点和现在一样） |
| otp（`secret_otp`） | 服务内算出验证码 | 只返回 6 位验证码，和现在一样 |
| fill（浏览器填表） | 服务把明文交给以用户身份运行的浏览器组件，由它输进页面 | **会**——见下 |

**剩下的缺口**（写进 BOUNDARY.md）：

- 浏览器仍以用户身份运行（用户决定，服务账户没有图形界面，Chrome 只能无头）。所以用途含 fill 的密文，同用户的进程可以冒充浏览器组件，对它声称的、在白名单里的站点取到明文。服务按“用途含 fill 且站点在允许列表内”放行，并逐次记审计；但它无法核实调用方真的是浏览器组件、页面真的在那个站点。只用于 http / exec / otp 的密文不受影响。
- 由此，**新密文要分清两类用途**（2026-09-27 实现时补）：网页表单里要填的值（网站密码、种子导入）用 `http` + `fill`；只由工具放进请求头或请求体的接口密钥只用 `http`，浏览器那条路拿不到它。调度模型加密、手机加密（默认 `http` + `fill`，可去掉 `fill`）、种子重新签发（`fill` + `http`）都按这个来。以前“`http` 就能填表”的规则只留给用迁入的旧密钥封的密文：那把私钥本来就对登录用户可读过，放宽不增加暴露。
- 执行范围（scope）照旧可被同用户进程伪造：范围防误用和串值，不防窥探（BOUNDARY §3 已写）。
- 不防 root / 管理员；不防安装或更新那一刻 App 包已被篡改——用户输入管理员密码时信任的是当时的 App 包。
- 本机回环地址上的目标（`127.0.0.1:<port>`）谁先占端口谁拿明文，与账户无关（app-v0 已记）。

做完以后，三家执行器的路径禁读规则（`protected.ts`）对网关目录退为锦上添花（design-v0 §3 原话）。

## 2. 账户、目录、服务

**账户**：`_agentswitchgate`，用 `sysadminctl -addUser _agentswitchgate -fullName "AgentSwitch Gate" -UID <n> -GID <n> -shell /usr/bin/false -home /var/empty -roleAccount` 创建，同名组用 `dseditgroup` 建在 450–499 里第一个空号上。无密码、不能登录（shell 为 `/usr/bin/false`）、登录界面不显示。

2026-09-27 本机（macOS 27）实装时发现：`sysadminctl` 不理会 `-UID`，把账户建成了 502（普通用户号段，也因此自动进了 staff 组）；而事后用 `dscl` 改 UniqueID、PrimaryGroupID，连 root 都被拒（`eDSPermissionError`）。所以安装器**不依赖 UID 数值**：已有账户原样沿用，只校验它不能登录（`UserShell: /usr/bin/false`）；文件一律按名字 `chown _agentswitchgate:_agentswitchgate`，LaunchDaemon 按名字运行。隔离靠文件属主和权限，与 UID 落在哪个号段无关。

**目录**（`/Library/Application Support/AgentSwitch/`，下称 `<root>`；`<root>` 本身 root:wheel 0755）：

| 路径 | 属主 / 权限 | 内容 |
|---|---|---|
| `<root>/gate/` | `_agentswitchgate` 0700 | 服务的 `SECRET_GATE_HOME` 和 `HOME`：`keys/`（含 `keys/legacy/`）、`current`、`refs.sqlite3`、`logs/`、`mitmproxy/`（CA 与私钥，mitmdump 的 `confdir`）、`exec_templates.json`、`upstream-insecure.txt`、`screenshot-mask.json`。目录 0700、文件 0600 |
| `<root>/gate-public/` | `_agentswitchgate` 0755 | `ca.pem`（CA 证书，0644）、`keys.json`（0644，见 §3.3）、`gate.sock`（0666，靠对端 uid 放行，§3.1） |
| `<root>/runtime/` | root:wheel，目录 0755、文件 0644/0755 | 服务运行的程序：内置 Python 3.12 + secret-gate + mitmproxy 的副本。安装、更新时从 App 包复制；服务只从这里运行，登录用户改不了 |
| `<root>/gate-service.json` | root:wheel 0644 | `{ownerUid, proxyPort, runtimeVersion, installedAt}`：放行名单里的用户、代理端口、已装程序版本 |

App 包在登录用户可写的位置（现在是 `~/Desktop/…/build/AgentSwitch.app`），所以服务**不能**直接跑 App 包里的程序——agent 改一下包里的 Python 就等于拿到服务账户。

**服务**（`/Library/LaunchDaemons/`，root:wheel 0644）：

- `com.agentswitch.gate.proxy`：`<root>/runtime/bin/secret-gate proxy --port <proxyPort>`（只监听 127.0.0.1）。
- `com.agentswitch.gate.rpc`：`<root>/runtime/bin/secret-gate rpc`（§3）。
- 两个都 `UserName`/`GroupName` = `_agentswitchgate`，环境只有 `SECRET_GATE_HOME=HOME=<root>/gate`、`SECRET_GATE_PUBLIC=<root>/gate-public` 和最小 `PATH`，`Umask 077`，`RunAtLoad`、`KeepAlive`，输出到 `<root>/gate/logs/`。
- 代理收到 SIGHUP 时重新加载上游证书例外（已有）**和密钥**；rpc 在密钥变化后给代理发 SIGHUP（同一账户，可以发）。

## 3. 本机接口 `gate.sock`

### 3.1 连接与放行

- Unix socket，每行一个 JSON 请求，回一行 JSON：`{"id", "method", "params"}` → `{"id", "ok": true, "result"}` 或 `{"id", "ok": false, "error": "<中文原因>"}`。单个请求最大 1 MiB。
- 连接建立时用 `LOCAL_PEERCRED` 取对端 uid，只放行 root 和 `gate-service.json` 里的 `ownerUid`；其他本机用户直接断开。
- 同一 uid 下 daemon 和 agent 分不出来，所以**每个方法都按“调用方可能是 agent”来设计**：没有哪个方法返回私钥，只有 `browser.resolve` 返回明文（§1 的缺口）。
- 每次调用写服务侧审计 `logs/rpc-audit.jsonl`：时间、方法、scope、密文标签、结果；不写值。

### 3.2 方法

| 方法 | 参数 → 结果 | 说明 |
|---|---|---|
| `status` | → `{version, proxyPort, keys: <keys.json 内容>}` | Mac 应用健康检查 |
| `keys.list` | → `keys.json` 的内容 | |
| `keys.new` | `{name, use?}` → 新的一行 | 在服务里生成；名字规则同现在 |
| `keys.use` | `{name}` | `legacy` 的密钥不能设为当前 |
| `keys.retire` | `{name}` | 删掉一个 legacy 密钥（用它加密的密文从此解不开）；当前密钥不能删 |
| `refs.register` | `{scope, tokens: [{token, label}]}` → 同 `refs register` 现在的输出 | 回的是短引用和描述，不含值 |
| `refs.release` | `{scope}` → `{released}` | |
| `credential.info` / `credential.reissue` | 同两条 CLI 现在的输入输出 | reissue 仍受密文里封好的 `seed_import_hosts` 约束 |
| `mcp.describe` / `mcp.http` / `mcp.exec` / `mcp.otp` / `mcp.repair` | `{scope, ...工具参数}` → 同 MCP 工具现在的返回 | 在服务里用 `gate_ops` 执行；http / exec 的结果照旧先打码 |
| `browser.resolve` | `{scope, token, host}` → `{value, label}` | 只在密文用途含 fill（或用旧密钥封的、用途含 http）、`host`（`host:port`）在允许列表内时返回；其余一律拒绝 |
| `browser.register` | `{scope, token}` → `{ref}` | 浏览器组件用公钥封好的密文（transfer），登记成短引用 |
| `browser.config` | → `{screenshotMask}` | 截图遮挡配置，改由服务持有 |
| `logs.tail` | `{name: "proxy" \| "rpc", lines ≤ 500}` → `{text}` | Mac 应用的“gate.log”按钮 |

### 3.3 公开文件

- `keys.json`：`[{name, publicKey, current, legacy, createdAt}]`，rpc 启动时和每次密钥变化后原子写入（写临时文件再改名）。手机配对、`/gate/pubkey`、调度模型加密（`enc --batch`）、secret-gate-ui 只需要这个。
- `ca.pem`：mitmproxy CA 证书（不含私钥），执行器的 `SSL_CERT_FILE` / `REQUESTS_CA_BUNDLE` / `NODE_EXTRA_CA_CERTS` 指向它。

## 4. 登录用户这边

**secret-gate CLI**：`SECRET_GATE_PUBLIC` 指向的目录（默认 `<root>/gate-public`）里有 `gate.sock` 时进入**服务模式**：

- `keys [--json]`、`pubkey`、`enc` 读 `keys.json`；`keys new/use` 走 socket。
- `refs register/release`、`credential-info/reissue` 走 socket，输出格式不变——daemon 调 CLI 的代码不用改。
- `mcp` 变成转发器：工具定义不变，每次调用带上本进程的 `SECRET_GATE_SCOPE` 转给 `mcp.*`。修复桥（`SECRET_GATE_REPAIR_URL/KEY`）随 `mcp.repair` 一起传给服务，由服务去调 daemon 的回环桥。
- `browser` 仍在用户侧运行 Playwright MCP 和有界面的 Chrome，解密改用 `browser.resolve`，登记改用 `browser.register`，遮挡配置取 `browser.config`，`browser-out` 放用户侧临时目录，审计由服务记。
- `keygen`、`check`、`proxy`、`service install|uninstall|reload`、`install-ca` 在服务模式下拒绝，提示“凭据网关由系统服务管理，请在 Mac 应用里操作”。
- 没有 `gate.sock` 时一切照旧（开发环境、未安装服务的机器）。

**daemon**：CA 路径改为 `SECRET_GATE_CA`（Mac 应用在服务模式下给 `<root>/gate-public/ca.pem`，没给时回退到 `$SECRET_GATE_HOME/ca.pem`）；其余经 CLI，行为不变。禁区（`protected.ts`）加上 `<root>/gate-public/gate.sock`，挡住执行器 shell 里最直白的 `nc -U`（只是锦上添花，同 uid 挡不住有意绕过）。

**Mac 应用**：

- **状态**：`secret-gate system status --json`（不需要 root）→ `{installed, running, proxyPort, runtimeVersion, ownerUid, publicDir}`：读 `gate-service.json`，再对 `gate.sock` 调 `status`。
- **安装**：「环境」和首次运行向导里的“凭据网关服务”一项；点“安装”弹一次管理员授权（`osascript … with administrator privileges`），以 root 运行 App 包里的 `secret-gate system install --owner-uid <当前 uid> --port <网关端口> --runtime <App 包 runtime> --migrate-from ~/.secret-gate`。
- **服务模式**（`gate.sock` 存在）：不再自己起网关子进程；不再本地 `ensureKeypair`；网关丢失时**不再**以用户身份另起一个（Supervision 的兜底会悄悄撤销隔离），只报告“凭据网关服务无响应”；「密钥」页经 CLI（即 socket）列出、新建、切换、停用旧密钥；“gate.log”按钮用 `logs.tail`。
- **程序更新**：App 包里的 runtime 版本和 `gate-service.json` 的 `runtimeVersion` 不同时，菜单和「环境」提示“凭据网关有更新”，确认后再要一次管理员授权，运行 `secret-gate system update`（换 `runtime/`、重启两个服务，数据不动）。改网关端口同样走这一步。
- **卸载**：`secret-gate system uninstall`（管理员）：停服务、删两个 LaunchDaemon 和 `runtime/`；`gate/` 里的密钥和数据默认保留，账户保留。“一并删除密钥”要二次确认，写明已有密文将全部无法解开。

## 5. 迁移（安装时一次，`system install` 以 root 执行）

1. 建账户和目录（§2），复制 `runtime/`，写 `gate-service.json`。
2. `~/.secret-gate/keys/<name>/` 和顶层 `key.priv`/`key.pub`（旧的“default”）移到 `<root>/gate/keys/legacy/<name>/`，属主改为服务账户；**只解密，不能再设为当前**。之后删掉用户目录里的私钥文件。它们一直对登录用户可读（`~/.secret-gate` 和 `keys/` 当时是 0755），按已暴露处理。
3. 在服务里新建密钥对 `main` 并设为当前。之后手机和调度模型加密都用它；旧密文照常能解。「密钥」页标出旧密钥“已停用（仅解密）”，可在确认后删除。
4. `refs.sqlite3`、`exec_templates.json`、`upstream-insecure.txt`、`screenshot-mask.json`（有就搬）移进 `<root>/gate/`，属主改为服务账户。从此改这些要管理员权限。
5. mitmproxy CA：服务账户在 `<root>/gate/mitmproxy/` 生成新 CA，公布 `<root>/gate-public/ca.pem`；删掉 `~/.mitmproxy/` 里的旧 CA 私钥（`mitmproxy-ca.pem` 等）。登录钥匙串里如果信任过旧证书，安装后提示用户移除旧的、信任新的（钥匙串操作留给用户点按钮，不在 root 脚本里做）。
6. `~/.secret-gate/` 只留一个 `MOVED.txt` 说明搬到了哪里。
7. 写 LaunchDaemon，`launchctl bootstrap system …` 启动，等 `status` 回应后结束；任何一步失败就停在那一步，打印已做和未做的步骤，不做半截回滚（密钥文件只在确认新位置写好后才删旧的）。

`system install --dry-run` 只打印要执行的步骤和命令，不改系统；`--root <前缀>` 把所有系统路径挪到一个临时目录下，测试用。

## 6. 测试

- 服务端（rpc 各方法、对端 uid 放行、legacy 规则、`keys.json` 原子发布、SIGHUP 重载密钥）、客户端服务模式（CLI、`mcp` 转发、浏览器解析）、迁移都在临时目录里测，用 `--root` 和假的 uid，不需要 root，不碰 `~/.secret-gate`。
- 建账户、`launchctl`、`chown` 这几步在测试里以“计划”（命令列表）断言，不执行。
- 真机安装由用户确认后做（见文首）。

## 7. 落地

- **2026-09-27 代码完成，未装到本机**（按文首约定，装之前先问用户）。
- secret-gate：`rpc_server` / `rpc_methods` / `rpc_client` / `rpc_protocol`（socket 服务与客户端）、`service_paths`、`publish`（`keys.json`、`ca.pem`）、`proxy_pid`、`service_cli`（服务模式的命令路由）、`mcp_backend`（本地或转发）、`remote_resolver`（浏览器组件经服务取值）、`system_plan` / `system_ops` / `system_exec` / `system_cli`（先算计划再执行，`--dry-run`、`--root`）、`migrate` / `user_dir`（迁移时对用户目录一律不跟随符号链接）。legacy 密钥只解密；代理收到 SIGHUP 时重新加载全部私钥。569 项测试，覆盖率 94%。
- `browser.resolve` 的规则见 §1 末条：新密文要有 `fill` 才会交给浏览器；用迁入的旧密钥封的、用途含 `http` 的照旧。为此调度模型加密网站表单要填的值时写 `http` + `fill`（接口密钥只写 `http`），种子重新签发写 `fill` + `http`（secret-gate 与 daemon 两边的修复校验一起改），手机新建密文默认 `http` + `fill`。
- daemon：执行器信任 `SECRET_GATE_CA`（服务公开的 `ca.pem`）；禁区加上 `gate.sock`。1076 项测试。
- Mac 应用：`GateService*`（状态、管理员命令、清单文案）；服务模式下不起网关子进程、不在本地建密钥、网关丢失时不以用户身份兜底；「环境」有安装 / 更新 / 修复 / 卸载，「密钥」页标出已停用的旧密钥，钥匙串里的旧证书可移除、新证书可加入。170 项测试。
- 本机空跑（`system install --dry-run --root <临时目录>`）列出 17 步，未改动任何文件。
- **2026-09-27 本机安装**（用户同意后，经 `osascript … with administrator privileges`，输了三次密码）：第一次停在第 1 步（`sysadminctl` 把账户建成 UID 502，校验 UID 450 不过），第二次也停在第 1 步（`dscl -change UniqueID` 被拒，`eDSPermissionError`）；改成不依赖 UID 后第三次 17 步全部完成：`demo01` 迁入 `keys/legacy/`，新建当前密钥 `main`，新 CA，两个服务以 `_agentswitchgate`（uid 502 / gid 450）运行，`~/.secret-gate` 只剩 `MOVED.txt`，`~/.mitmproxy` 里的 CA 私钥已删。安装前停掉了一个 9 月 24 日从仓库 venv 手动起的 mitmdump（App 一直在“复用”它，占着 8080）。
- **验证**：以登录用户读 `gate/`、`key.priv`、legacy 私钥、CA 私钥全部 `Permission denied`；经 AgentSwitch 派给三个执行器的读取任务，模型都按执行器指令拒绝执行；不经 AgentSwitch、直接让 Claude Code（`--add-dir` 放开该目录）、Codex（`-s read-only`）、OpenCode（bash 放行）去打开私钥（`wc -c`、`shasum`、Python `read_bytes`、`find`），全部 `Permission denied`；经 `gate.sock` 对只有 `http` 用途的密文调 `browser.resolve` 被拒。代理用新 CA 访问 HTTPS 正常，密文替换正常（回显被打码）。
