# 应用化 v0：Mac 服务端应用 + iPhone 客户端（2026-09-24）

> 实现状态（2026-09-24 同日）：daemon 远程接口、Mac 菜单栏应用及打包、iPhone 应用骨架都已实现，并用 iPhone 应用自己的客户端代码对打包后的运行时跑通端到端（§8）。未做：推送、发布签名与公证、上架。iPhone 可配对多台 Mac（2026-09-27，§5）。

目标：普通用户在 Mac 上装一个应用、在 iPhone 上装一个应用，扫一次码就能用。补充并部分替换 `design-v0.md` §2（网络）、§3（手机端）和 M3；与设计稿不一致处以本文为准。

**已定（2026-09-24 用户拍板）**
- iPhone ↔ Mac：**局域网和 Tailscale 都支持**。同一网络走局域网（Bonjour 发现），在外走 Tailscale。
- Mac 端：**自包含的菜单栏应用**，内置 Node 与 Python 运行时、daemon 和 secret-gate，双击即用、可登录自启。Claude Code / Codex / OpenCode 仍由用户自己安装并登录，应用负责检测和指引。
- 推送：**先不做**。App 打开时实时刷新（SSE），接口位置留好。
- 公钥：**配对时自动带到手机**。手机本地用 gate 公钥把密码加密成 `enc:v1:`，明文不离开手机。

**已定（2026-09-24 用户拍板，第二轮）**
- 手机的设计哲学：**进来只有一个输入框**，下面能看到日志；会话、线程全部自动管理（线程由路由器在路由时分配，`threads-v0.md` §6 与 §10 第 4 步），手机不让用户选线程。高级选项里可以删除会话（线程）或单条任务日志。
- 手机上可以编辑 `CONTEXT.md`；保存时和任务一样过 sealer，账号密码可以直接写（`router-v0.md` §9）。

## 1. 组成

```
iPhone: AgentSwitch (SwiftUI)                        Mac: AgentSwitch.app (菜单栏, SwiftUI)
  配对(扫码) · 任务 · 审批 · 造密文 · 设置               ├─ 启停并看护子进程：secret-gate proxy、agentswitchd
        │                                              ├─ Bonjour 广播 _agentswitch._tcp
        │  HTTPS(自签证书, 配对时钉住指纹) + 设备令牌       ├─ 配对二维码 · 设备 · 模型 · 密钥 · 环境检测
        ├── 局域网: <LAN IP>:4713  (Bonjour 发现)          └─ Resources/runtime/{node, daemon, python}
        └── Tailscale: 100.x.y.z / <mac>.ts.net:4713
                                                        agentswitchd
                                                          ├─ 本地 127.0.0.1:4711  HTTP  (网页 UI、CLI、Mac 应用；只认本机 Host/Origin)
                                                          └─ 远程 0.0.0.0:4713    HTTPS (只给配对设备)
```

## 2. daemon 远程接口

**开关与端口。** `AGENTSWITCH_REMOTE=1` 时启用（Mac 应用设置；开发用的 daemon 默认不开），端口 `AGENTSWITCH_REMOTE_PORT`（默认 4713）。本地 4711 的路由不变，但入口多了一层检查（`src/api/localGuard.ts`）：Host 只接受本端口的 `127.0.0.1`、`localhost`、`[::1]`；带 Origin 的请求只接受网页 UI 自己的源；有请求体的 POST/PUT/PATCH/DELETE 必须是 `application/json`（上传接口除外）。挡的是网页跨站提交任务和 DNS 重绑定读配对码。

**来源地址。** 监听 0.0.0.0/::，只接受来自以下网段的连接，其他连接立即断开：127.0.0.0/8、::1、10/8、172.16/12、192.168/16、169.254/16、100.64/10（Tailscale）、fc00::/7（含 Tailscale 的 fd7a:115c:a1e0::/48）、fe80::/10。不做端口转发，没有公网可达面。

**TLS。** 首次启动用 `/usr/bin/openssl` 生成自签证书（EC P-256，CN=AgentSwitch，10 年，带 CA:FALSE、digitalSignature、serverAuth）到 `$AGENTSWITCH_HOME/remote/{cert.pem,key.pem}`（目录 0700、私钥 0600）。指纹 = 证书 DER 的 SHA-256（小写十六进制）。手机只信任配对时拿到的指纹，不依赖任何 CA；局域网和 Tailscale 走同一张证书。10 年有效期超过 Apple 对 TLS 证书 825 天的上限，所以手机端**不调用系统信任评估**，只比对叶证书 DER 的 SHA-256。远程只监听 `::`（双栈）。

**设备令牌。** 除 `GET /healthz`（只回 `{ok:true}`）和 `POST /pair` 外，每个远程请求都要 `Authorization: Bearer <token>`。令牌 32 字节随机数（base64url），库里只存 SHA-256；比较用定长比较；吊销后立即 401。表 `devices(id, name, platform, token_hash, created_at, last_seen_at, revoked_at)`。

**配对。**
- 本地 `POST /pairing`（只在 127.0.0.1 上）生成一次性配对码：8 位 Crockford base32（显示成 `XXXX-XXXX`，输入时 O→0、I/L→1 归一），5 分钟有效、只能用一次、错 5 次作废；同一时间只有一个码有效（新生成即作废旧码），码只在内存里（daemon 重启即作废）。返回 `{code, expiresAt（毫秒时间戳）, link, payload}`；远程未启用时 409。
- 二维码内容 `link = agentswitch://pair?p=<base64url(JSON)>`，JSON：
  ```json
  {"v":1,"name":"<Mac 名称>","port":4713,"fp":"<证书 SHA-256 hex>","code":"XXXX-XXXX",
   "lan":["192.168.1.5"],"tailnet":["100.101.102.103","mac.tail1234.ts.net"],
   "bonjour":"AgentSwitch on <Mac 名称>","gate":{"publicKey":"<base64url 32 字节>","keypair":"default"}}
  ```
  `lan` 取当前私有网段的 IPv4；`tailnet` 取 `tailscale ip -4` 与 `tailscale status --json` 的 `Self.DNSName`（没装或没登录就是空；调用时设 `TAILSCALE_BE_CLI=1`，否则从访达启动时 Tailscale.app 里的可执行文件会去开图形界面）。`name` 默认取 `scutil --get ComputerName`，可用 `AGENTSWITCH_REMOTE_NAME` 覆盖；`bonjour` 由 daemon 拼成 `AgentSwitch on <name>`。读不到 gate 公钥时 `gate` 为 `null`，手机之后再调 `/gate/pubkey`（此时 503）。
- 手机经钉住指纹的 TLS 调 `POST /pair {code, name, platform}` → `{deviceId, token}`。错码、过期、已用、请求体格式不对一律 401 `{"error":"pairing failed"}`；同一来源每分钟超过 10 次返回 429（`Retry-After: 60`，不计入错码次数）。`name` 1–64 字符、不含控制字符。
- 本地另有 `GET /devices`（`[{id, name, platform, createdAt, lastSeenAt, revokedAt, online}]`，含已吊销的）、`DELETE /devices/:id`（吊销，同时切断该设备开着的事件流）、`GET /remote/info`（`{enabled, port, fingerprint, name, bonjour, lan, tailnet, onlineDevices}`；“在线”= 有进行中的请求或 5 分钟内访问过）。
- 模型设置（本地）：`GET /settings/models` → `{router:{model, options}, default:{harness, model}, harnesses:{<名>:{models, default_model}}}`；`PUT /settings/models {router?:{model}, default?:{harness, model}}` 校验后写 `$AGENTSWITCH_HOME/models.json`（叠加在 targets.yaml 之上，启动时合并），返回 `{restartRequired:true}`，由 Mac 应用重启 daemon 生效。

**远程可用的路由**（其余一律 404，有没有令牌都一样）：`GET /healthz`（只回 `{ok:true}`）、`POST /pair`、`GET /me`（`{deviceId, name, platform}`）、`GET /addresses`（Mac 现在的 `{lan, tailnet}`：手机连上后拿来更新配对时存下的地址，某一类为空时保留旧的，2026-09-26）、`GET /gate/pubkey`、`GET|POST /tasks`、`GET /tasks/:id`、`GET /tasks/:id/events`（SSE，续传参数是 `?after=<seq>`，不认 `Last-Event-ID`；`done`/`partial`/`blocked`/`failed`/`cancelled` 之后流结束）、`POST /tasks/:id/{answer,approve,cancel,handoff,rate}`、`GET /tasks/:id/files`、`GET /tasks/:id/files/*`、`GET /approvals`、`GET /threads`、`GET /threads/:id`、`PATCH /threads/:id`、`POST /threads/:id/{archive,reopen}`、`DELETE /tasks/:id`、`DELETE /threads/:id`（语义同本地：级联删除，运行中 409，`threads-v0.md` 手动删除一节；级联会一并删掉这些任务的战绩行、路由日志行和来源指向它们的 `MEMORY.md` 行）、`GET /quota`、`POST /quota/refresh`、`GET /targets`、`POST /uploads`、`GET /context`、`PUT /context`（与本地同一条路：先过 sealer，凭据换成密文、给执行者的说明不留；sealer 不可用 503、看不出站点 400，都不写盘；再过 lint，凭据样的明文条目行被去掉并返回 `warnings`，超过 64 KiB 截断；旧版本存进 `context-history/`，留最近 20 份；返回 `{warnings, sealed:[{label, field, hosts, uses}]}`）、`GET /context/example`、`POST /assistant`、`GET /assistant`（助理对话，assistant-v0 §1.1）、`GET /approvals/policy`、`GET /settings/workdir`（权限模式与默认工作目录，只读；改只能在 Mac 上，control-v0 §1–2）、`GET /sessions`、`GET /sessions/:harness/:id`（Mac 上的编码会话，只读，control-v0 §3）、`POST /tasks/:id/ack`（记为已读）、`GET /search?q=`（任务全文搜索，control-v0 §4）、`GET /update`、`POST /update/install`（看有没有待装的新版本、确认安装；真正换版由 Mac 应用做，起不来自动退回上一版）。
远程的每个写请求（非 GET）在 daemon 日志里留一行 `remote: device <id> <方法> <路径> → <状态>`。
事件流每 10 秒发一行 SSE 注释（`: ping`），等待答复的安静任务不会被手机的空闲超时（45 秒）当成断线。
不对远程开放（不能读、不能直接改）：MCP 与 skill 注册表（其中可能有明文环境变量）、`MEMORY.md` 与平台经验、战绩、路由日志、审批策略修改、设备与配对管理、网页 UI。
远程请求的额外限制：`POST /tasks` 不接受 `approval`（审批策略只由 Mac 决定）、`ephemeral`（会在任务结束时删掉目录）；工作目录：2026-09-25 起手机可以带 `cwd` 指定 Mac 上任何目录规则允许的文件夹（用户决定：Mac 的文件夹对任务开放，像 Claude Code 一样；禁区、禁区的上级、整个主目录照旧拒绝）（2026-09-25 晚起没有登记的项目目录了，助理从之前任务用过的文件夹里填路径）；不带就用新的临时目录，追问沿用父任务目录；`PATCH /threads/:id` 只能改 `title`（过期时间只由 Mac 管；要删就用 `DELETE /threads/:id`，删除前界面确认）；任务文件接口只提供任务自己的 `in/`、`out/` 和保留的产物，不提供工作目录里的其他文件。

**gate 公钥。** `GET /gate/pubkey` → `{publicKey, keypair}`，取 secret-gate 的当前密钥对（`secret-gate keys --json`）。

## 3. 手机本地造密文

与 `secret-gate enc` 逐字节兼容：明文载荷是 JSON `{"v":<值>,"host":[...],"use":["http"],"label":"<label>","kind":"secret"|"totp","seed_import_hosts":[]}`，用 libsodium `crypto_box_seal` 加密到 gate 公钥，输出 `enc:v1:` + base64url（无填充）。客户端先按 gate 的规则校验（label 形如 `^[A-Za-z0-9][A-Za-z0-9._/-]{0,63}$`，host 小写、可带端口、可 `*.` 通配，`totp` 值须是 base32），最终仍以 gate 解密时的校验为准。测试用 Python gate 解开 Swift 造的密文来证明兼容。

手机保存的是密文和备注（不是秘密），明文输入框用完即清空，不进剪贴板历史、不进日志。

这是可选的第二条路，不替代 sealer：手机发来的 `POST /tasks` 和网页一样先过 sealer（`router-v0.md` §9），任务里直接写账号密码也会在入库前被标出、加密。两条路的差别只在明文到过哪里：直接写，明文经 TLS 到 Mac、给路由器模型看一眼；手机造密文，明文不离开手机，路由器模型也看不到。界面照此提示，不劝阻直接写。

## 4. Mac 应用

- **形态**：`LSUIElement` 菜单栏应用（SwiftUI `MenuBarExtra`）+ 设置窗口；登录自启用 `SMAppService.mainApp`。
- **子进程看护**：应用启动 `secret-gate proxy`（8080）和 daemon（本地 4711、远程 4713，端口可在设置里改），崩溃按退避重启，日志在 `~/Library/Logs/AgentSwitch/`。单实例：启动时对 `<AGENTSWITCH_HOME>/run/app.lock` 加独占锁，第二个副本把第一个带到前台后退出；pid 文件记录启动时间，遗留进程只在“pid + 启动时间 + 本副本 runtime 真实路径”都对得上时才清理。8080 已被占用时先探测是不是 gate（`secret-gate bootstrap` 的探测：解不开的密文必须得到 403），是就复用，否则报错。
- **环境**：`AGENTSWITCH_HOME=~/Library/Application Support/AgentSwitch`；gate 家目录沿用 `~/.secret-gate`（与 secret-gate-ui、已有密钥兼容）。子进程的 `PATH` 取用户登录 shell 的 `PATH`（从 Finder 启动的应用只有系统默认 PATH，找不到 codex/opencode）。
- **首次运行**：没有 gate 密钥对就建一个；生成 mitmproxy CA 并复制成 `~/.secret-gate/ca.pem`；检测 `claude` / `codex` / `opencode` 是否安装与登录，给出安装和登录指引；Tailscale 没装时提示“只能在同一局域网使用”。
- **界面**：状态（daemon、gate、远程监听、局域网与 Tailscale 地址）；配对（二维码 + 配对码 + 倒计时）；设备（列表、吊销）；模型（路由模型、默认执行目标，写 `$AGENTSWITCH_HOME` 下的覆盖配置）；密钥（当前公钥、切换/新建密钥对）；日志入口。
- **Bonjour**：应用用 `NetService` 发布 `_agentswitch._tcp`，端口为远程端口，TXT `v=1`、`fp=<指纹前 16 位>`；只在远程开启时广播。
- **远程开关**：通用页「允许 iPhone 连接（远程接口与 Bonjour）」，默认开；关闭时 daemon 以 `AGENTSWITCH_REMOTE=0` 启动、不广播 Bonjour，菜单显示“远程已关闭”。
- **Dock**：平时只在菜单栏；设置窗口打开时出现在程序坞，通用页可设为始终显示；点程序坞图标打开设置窗口。
- **复制配对链接**：只写本机剪贴板（不经通用剪贴板同步），标记 Transient/Concealed，配对码过期时若仍是这次写入就清掉。
- **调试覆盖**：runtime 路径覆盖只在 Debug 版生效；端口、执行器等覆盖保留给冒烟测试。
- **打包**：`packages/mac-app/scripts/build-app.sh` 下载并按固定 SHA-256 校验官方 Node 24（darwin-arm64；`node:sqlite` 需要 ≥ 22.13）和 python-build-standalone CPython 3.12，装入 daemon（`npm run build` 的 `dist/` + `config/` + `ui/` + `package.json` + 生产依赖）、secret-gate（装进内置 Python，`bin/secret-gate` 是 `python -I -B -m secret_gate.cli` 的包装，整包可搬移）和 `runtime/secret-gate/AGENTS.md`（执行者的 gate 指南），用 xcodegen + xcodebuild 构建，组装到 `AgentSwitch.app/Contents/Resources/runtime/{node,daemon,python,secret-gate}`；签名默认用钥匙串里的“Apple Development”证书，没有才 ad-hoc（`SIGN_IDENTITY` 可指定，2026-09-25 起）——macOS 的隐私授权（文件和文件夹、App 管理等）认的是签名身份，ad-hoc 签名按哈希认，每打一次包就成了“新 App”、授权全部作废，这就是反复弹授权框的原因；证书签名下换多少次版都算同一个 App，授权只给一次。每次构建都重新校验并解压 Node/Python 压缩包；Python 依赖用 `--require-hashes --only-binary=:all:` 按哈希安装（`scripts/python-requirements.txt`，`scripts/lock-python.sh` 刷新）；secret-gate 先离线构建成 wheel 再装；包内不留本机路径（构建最后检查，含用户名即失败）；`APP_OUT` 指定输出，目标正在运行时拒绝覆盖。约 557 MB，其中 208 MB 是 Claude Agent SDK 自带的 claude 可执行文件（以后可以改用用户自己装的 claude）。不开 App Sandbox（要启动用户安装的 CLI、读 `~/.secret-gate`），关闭 hardened runtime。发布签名与公证另议。
- **daemon 启动**：`runtime/node/bin/node --no-warnings=ExperimentalWarning runtime/daemon/dist/cli.js serve`，必须设 `SECRET_GATE_BIN`（否则回退到仓库 venv 路径，.app 里不存在）；另设 `AGENTSWITCH_REMOTE_NAME`、`OPENCODE_BIN`、`AGENTSWITCH_OPENCODE_PORT`（开发用 daemon 占着 4712 时要改）。SIGINT / SIGTERM 正常退出。
- **Claude Code CLI**：应用把用户自己装的 `claude` 路径交给 daemon（`CLAUDE_BIN`），模型探测、额度探测、Claude 执行器和 claude-code 规划模型都用它（规划模型起初漏了，每次都“服务调用失败”，2026-09-24 修）；
- **换新版（2026-09-25，assistant-v0 §5）**：新构建放在运行中 App 旁边的 `next/AgentSwitch.app`（`APP_OUT=build/next/AgentSwitch.app scripts/build-app.sh`），菜单栏出现“有新版本（构建于 …）· 安装并重启…”，手机「设置 › 新版本」也能确认（`POST /update/install`，daemon 只留一个请求文件，Mac 应用每 3 秒看一次）。安装全程由 App 自己做（事后留下的辅助脚本做文件操作会被 macOS 的隐私检查卡住，实测三次）：先在后台、限时 15 秒把涉及的每个 .app 改名再改回，确认 macOS 允许（“App 管理”，App 在桌面/文稿/下载里还有“文件和文件夹”）——不允许就什么都不停、原样运行，原因写进 `update-result.json`，daemon 下一次检查（≤ 30 秒）让助理在对话里说；允许则停掉 gate 与 daemon、放开单实例锁、把自己挪成 `prev-AgentSwitch.app`、新版挪进来（后台、有时限，超时即放弃并重新启动旧版，被卡住的那步事后放行也不会再挪），以新实例启动新版并隐藏菜单栏图标等待：150 秒内新 daemon 应答则旧实例退出，否则停掉新版（先正常退出、再强制、再清掉它的子进程），新版留作 `failed-AgentSwitch.app`，旧版挪回并重新启动。结果都写进 `update-result.json`，新起来的 daemon 在对话里报一句（“新版本已安装 / 未能启动，已恢复为上一版本 / 新版本安装失败。原因”）。**需要用户在 Mac 上一次性允许**：系统设置 › 隐私与安全性 › App 管理 › AgentSwitch。
- **网关 CA**：执行器环境除了代理，还带 `SSL_CERT_FILE` / `REQUESTS_CA_BUNDLE` / `NODE_EXTRA_CA_CERTS` 指向 `~/.secret-gate/ca.pem`（design-v0 §3）。开发用 daemon 从配过 `scripts/env.sh` 的终端启动，继承了这几个变量，所以一直没暴露；应用给 daemon 的是干净环境，执行器里的 Python / curl 经网关访问 HTTPS 全部“unable to get local issuer certificate”（2026-09-24 修，`gateEnv` 统一带上）。它已有用户钥匙串里登录凭据的授权，SDK 自带的那份签名不同，会被系统再问一次。
- **工作目录与“文件和文件夹”权限**：daemon 以数据目录为工作目录，模型探测和额度探测在临时目录里跑。原因是 Claude Code 会逐级向上找 `CLAUDE.md`，只要工作目录在“桌面/文稿/下载”下面，它就会卡在打开文件那一步，等 macOS 给发起它的应用（AgentSwitch）授权。任务本身若要在这些文件夹里的项目上运行，需要在「系统设置 › 隐私与安全性 › 文件和文件夹」（或完全磁盘访问权限）里给 AgentSwitch 授权；「环境」页有说明和跳转按钮。应用本身建议放在“应用程序”文件夹。启动宽限 120 秒；探测超时会中止 CLI，不留孤儿进程。
- **本地网络权限**：macOS 15 起，Mac 端发布 Bonjour 也要“本地网络”授权；没授权时应用 10 秒内发布不出去就在菜单里提示去“系统设置 › 隐私与安全性 › 本地网络”允许。
- **CA**：“复制 CA 到 `~/.secret-gate/ca.pem`”自动做；“加入登录钥匙串”只在用户点按钮时做（`secret-gate install-ca` 会两步一起做，所以应用没有直接调用它）。
- **执行器路径**：`targets.yaml` 里写死的 codex 路径（如 ChatGPT.app 内的）在别的 Mac 上不存在时，daemon 改用 PATH 上的 `codex`。

## 5. iPhone 应用（本轮做骨架）

- SwiftUI，iOS 17+，Swift 6，xcodegen 生成工程；纯逻辑放在可在 macOS 上 `swift test` 的 `AgentSwitchKit` 包里（接口模型、配对链接解析、造密文、地址选择、SSE 解析）。密文用 `jedisct1/swift-sodium`（libsodium 的 `crypto_box_seal`，与 gate 用的 PyNaCl 同一实现），不手写密码学。
- 构建环境：Xcode 26.4（iOS 26.4 SDK）；部署目标 iOS 17，可装到 iOS 27 的手机上。用 iOS 27 SDK 构建需要 Xcode 27。模拟器构建需要安装 iOS 模拟器运行时（约 8.5 GB）。
- **配对**：相机扫码或粘贴链接 → 钉住指纹调 `/pair` → 令牌存 Keychain（仅本机、解锁后可用），服务器信息存本地。
- **多台 Mac（2026-09-27）**：手机可以配对多台 Mac，同一时间只连“当前 Mac”，在设置顶部切换。
  - 存储：`macs.json` = `{active: <指纹>, servers: [ServerProfile…]}`，按证书指纹区分；令牌仍按指纹存 Keychain，每台一个。旧版的 `server.json` 在首次启动时迁移成只有一台的 `macs.json` 并删掉。
  - 配对：扫到已配对的指纹就更新那一台（新令牌、新地址），扫到新指纹就加一台，两种情况都切到它。配对成功前不动已有的配对。
  - 切换：停掉当前连接，清空从上一台取来的任务、会话、审批、对话、用量和“指定执行者”，再连新的那台；输入框里的文字和附件保留（附件在发送时才上传）。实时活动跟随当前 Mac。
  - 移除：“移除此 Mac”删掉当前这台的令牌和配置，切到剩下的第一台；一台都不剩时回到首次配对页。配对失效时的“重新配对”直接打开扫码。
  - 密文：新造的密文记下是给哪台 Mac 造的（`mac` = 指纹），因为密文只能被造它时那台 Mac 的 gate 解开。插入和管理只列出当前 Mac 的、旧版留下未标记的，以及标记的 Mac 已不在列表里的（重装后重新配对指纹会变，这些多半还是给这台的）。
  - 不做：同时连多台、在后台跟踪非当前 Mac 的任务和提问（要等推送）；Mac 端本来就支持多台设备，不用改。
- **连接**：优先 Bonjour 发现且指纹前缀匹配的局域网地址，其次二维码里的局域网地址，再次 Tailscale 地址；每次用 `/healthz` + 带令牌的 `/me` 探测；网络变化（`NWPathMonitor`）时重选。所有请求都经过钉住指纹的 `URLSession`。连上后 `GET /addresses` 取 Mac 现在的地址更新存档（2026-09-26）。设置 › Mac 列出上次选线路时每个地址的结果与原因。
  > 2026-09-27：Tailscale 地址一律“TLS 错误导致安全连接失败”（0.1 秒，`-1200`/`-9802`），Safari 却能打开。原因是 iOS 的 App Transport Security：它放过私有网段与回环地址，不放过 Tailscale 的 100.64.0.0/10 和 `*.ts.net`，自签证书在系统层就被拒，走不到我们的指纹校验；`NSAllowsLocalNetworking` 也不覆盖。改为 `NSAllowsArbitraryLoads`（模拟器验证：Tailscale IP 通、错指纹仍被我们的代理拒）。应用只有这一条出网路径（经钉指纹的 `URLSession`、只用 https），不加载网页和图片，所以放开 ATS 不增加面。调试版 `-tlsProbe host1,host2 -tlsProbePin <指纹>` 在 Documents/tlsprobe.txt 写出每个地址的底层错误。
- **页面（2026-09-24 改为单输入框）**：
  - **首页（2026-09-25 起是和助理的对话，见 assistant-v0 §1.1 与 §6 第 2 步；下面的日志部分照旧用于任务卡片）**是唯一的主界面：底部一个输入框（原为发送即 `POST /tasks`，现发给助理 `POST /assistant`；不带线程、不带父任务，归属交给路由器；等 Mac 最多 60 秒，因为 sealer 可能要 30 秒；连接断了就提示“结果未确认，先看日志再决定是否重发”，不自动重发；输入框不自动纠错）；上方是日志，按时间从旧到新排列最近的任务，每条显示你发的话、状态与执行者、进行中任务的实时事件尾巴（最多同时跟 3 条流，其余靠轮询）、结果或错误；这条任务待处理的审批和问题直接嵌在日志里作答。点一条日志进完整事件流（取消、交接在那里）。不属于日志里任务的待处理审批，顶部显示“还有 N 项待处理”，点开是全部待处理项的列表。实时流只在首页可见时跑，续传从收到的最后一条事件算起。
  - 输入框左侧的“+”只放三件事：插入已保存的密文、生成新密文、给下一条任务指定执行者（选了显示成输入框上方可移除的标签；默认是路由器自动选）。没有线程、目录、审批策略这类选项。
  - **删除（2026-09-24 用户要求加显式按钮）**：任务详情右上角菜单有“删除这条任务”“删除整个会话”；首页日志长按有同样两项；设置 › 高级 › 会话 / 任务日志每行有垃圾桶按钮（左滑也行）。都先确认，运行中的给出原因；删完回到上一页。
  - **设置**（右上角）：环境说明 `CONTEXT.md`（编辑、插入密文、保存后显示加密了哪些凭据和校验提醒；有未保存修改时不能下滑关掉；空文件时可载入示例）、密文（生成与管理）；**高级**：会话（线程列表，左滑删除，删除前确认，运行中的给出 409 的原因）、任务日志（任务列表，左滑删除）、执行目标与额度；Mac 与连接（多台时可切换、添加、移除）、Face ID 开关。
- **权限说明**：本地网络（`NSLocalNetworkUsageDescription`、`NSBonjourServices`）、相机、Face ID。
- **附件（2026-09-24）**：输入框的“+”里有拍照（相机）、照片（多选）、文件（“文件”应用）、粘贴图片（剪贴板有图时才出现）。选中的附件以缩略图排在输入框上方，可逐个移除；发送时先 `POST /uploads`（multipart，一次最多 20 个、每个 ≤ 50 MB，手机端再限总计 ≤ 100 MB），再带上 `attachments` 建任务，文件落在任务工作目录的 `in/`。照片、相机和粘贴的图片在手机上缩到长边 ≤ 2048 像素、摆正方向、转 JPEG（PNG 保持 PNG），重新编码时不带原图元数据（含位置）；GIF 与矢量图原样；从“文件”里选的按原文件发送（超过 50 MB 或读不出的会提示没加上）。附件还在处理时不能发送；只有附件没有文字也能发（任务文本为“请查看附件。”）。上传失败时任务还没建，提示重发。附件区常驻一行提醒：附件不过 sealer，里面的密码会原样给模型（router-v0 §9）。
- **任务的文件**：任务详情里有“文件”一栏（`GET /tasks/:id/files`），分“你发的”（`in/`）和“交回的”（`out/`）；点开先下载到应用缓存（开启数据保护，应用每次启动清空），再用系统预览（图片、PDF、文档）打开，预览里可分享、存到照片或文件；HTML、SVG、XML 只显示源码不渲染（本地渲染会去加载远程资源），可分享。首页日志上，结束的任务有交回文件时显示“📎 N 个文件”（每个结束的任务只查一次）。已知限制：临时工作目录在任务结束后删除，“你发的”随之消失，只剩交回的；同一线程共用工作目录的任务会看到彼此的 `out/`。
- **实时活动（2026-09-25，assistant-v0 §4 本地版）**：任务进行时锁屏和灵动岛上有一个汇总活动（最多三条，等你的在最前），应用在前台时更新，被挂起后停在最后状态、计时照走；点它或“去处理”打开那条任务（`agentswitch://task/<id>`，只认这一种任务链接，配对链接照旧）。小组件扩展只拿显示用的状态，不连 Mac、不存令牌。
- **朗读（2026-09-24，为以后的语音做准备）**：任务详情有“口播”一栏，显示朗读要念的原文（清洗后的口播稿，没有时是它的替代），旁边是播放 / 停止；口播稿生成中或旧任务没有时注明。首页日志上结束的任务有口播稿时，用喇叭图标显示（≤ 4 行，正在念时高亮），结果预览随之缩到 4 行、淡一档。任务详情和日志长按有“朗读”，念任务的口播稿 `speech`（没有就念 `spoken`，再没有就念状态加结果开头）。念之前手机端再清洗一次（去密文、链接、Markdown、长串编号）。用系统离线语音（`AVSpeechSynthesizer`，简体中文）：默认挑已装的最好的普通话声音（高音质 > 增强 > 基础），设置 › 朗读声音 可手动选、试听，并说明去 系统设置 › 辅助功能 › 朗读内容 › 声音 下载更自然的声音（基础声音很生硬；应用无法直接跳到那一页）；音频类别 `.playback`，静音开关打开也能听到。自动播报要等推送。
- **链接**：结果里只有 http/https 链接可点（解析时就去掉其他协议，全局的打开链接动作也只放行这两种），`agentswitch://pair` 之类的链接不会因为出现在模型输出里就被打开。
- **Markdown**：执行者和路由器写的是 Markdown。手机自己按块解析（标题、嵌套列表、有序列表、引用、代码块、表格、分隔线），块内的粗体、斜体、行内代码、链接用系统的 Markdown 解析；任务详情按块渲染，日志预览和事件行压平成带格式的一段。图片一律不加载，只显示替代文字（模型输出里的图片地址不会让手机发请求）；链接点了才用浏览器打开。daemon 自己写的事件行（工具命令、路由）不当 Markdown，免得命令里的 `*` 变成斜体。
- **锁**：Face ID 锁上时整个界面（含弹出的页面）从视图树里拿掉，只剩锁屏。
- 推送不做；留 `NotificationSink` 接口。

## 6. 威胁模型的变化

| 变化 | 风险 | 对策 |
|---|---|---|
| 远程端口开在局域网 | 同网段设备探测、嗅探 | TLS + 钉指纹；设备令牌；只收私有网段和 Tailscale 来源；配对码一次性、限次、限时 |
| 二维码泄露 | 5 分钟内被他人抢先配对 | 一次性；配对成功后 Mac 应用显示新设备并可一键吊销 |
| 手机丢失 | 用手机发任务 | Face ID 解锁开关（目前只是界面锁，令牌未与生物识别绑定）；Mac 上吊销令牌 |
| 本机网页 | 跨站提交任务、DNS 重绑定读配对码 | 本地监听只认本机 Host/Origin，写操作必须是 JSON |
| 本机其他程序（2026-09-25 加） | 同一用户下的程序（沙盒应用、执行器自己）调本机端口：改审批策略、配对新设备、建任务 | 本机端口要令牌（`$AGENTSWITCH_HOME/local-token`，0600，daemon 首次启动生成；Mac 应用与命令行读它带 `Authorization: Bearer`）；执行器禁读这个文件，自己没法调本机接口放宽约束；网页控制台由 Mac 应用要一个一次性、60 秒有效的登录链接，换成 HttpOnly + SameSite=Strict 的会话 cookie（链接里不带令牌，daemon 重启后要重新从菜单栏打开）；`/healthz` 与控制台静态页不需要令牌。**已知缺口**：同一用户下不受沙盒限制的程序能读这个文件，这层防不住有意为之的本机恶意程序 |
| 令牌被盗 | 用任务文件接口读 Mac 上的任意文件（gate 私钥） | 工作目录按真实路径拒绝禁区及其上级；文件接口只给 `in/`、`out/` |
| 令牌被盗（2026-09-25 起更要紧） | 用户决定把 Mac 的文件夹对任务开放（读写任何非禁区的目录、手机可指定工作目录），持令牌者能让执行器读改这些文件、把内容带给模型服务商 | 禁区（凭据、AgentSwitch 自己的数据与配置）照旧挡住；删除、git push、付款/发消息照旧要本人批；Mac 上吊销即止。**建议**：令牌绑定 Face ID（未做） |
| 令牌被盗（2026-09-24 起） | 改写 `CONTEXT.md`：在路由器提示词里长期埋指令，或把某个站点的网址改成别处，之后只写站点名的任务，其凭据会被 sealer 绑定到那个网址（比单发任务多一层：改的是以后的任务） | 远程写都进 daemon 日志（带设备号）；`CONTEXT.md` 每次保存前的版本留在 `context-history/`（20 份），在 Mac 上可比对、拷回；Mac 上吊销即止。**已知缺口**：网址被改时 Mac 不主动提醒 |
| 受保护目录在 shell 命令里没拦住（2026-09-24 发现并修） | 应用的数据目录带空格（`Application Support`）；执行器写 `Application\ Support/…` 或加引号时，Claude 的检查按空白切词、OpenCode 的规则按原样匹配，都认不出，执行器用 shell 读到了 `tasks/`、`CONTEXT.md` | 命令先按 shell 规则解析（引号、反斜杠转义、续行、`~` 与 `$HOME` 展开）再判断路径，同时在去掉引号和转义的整条命令里找禁区根目录，`sh -c "…"`、`python3 -c` 字符串、`--cacert=…` 里的路径也认得出；OpenCode 的拒绝规则加上转义、`~`、`$HOME`、`${HOME}` 写法和数据目录的尾部（`/.secret-gate`、`Support/AgentSwitch`，引号在斜杠哪边都算），`cd` 和 shell 的 `workdir` 由 `external_directory` 拒绝（工作目录、上传目录和技能目录仍是询问）；Claude 的 Grep 以包含凭据目录的上级为搜索范围时拒绝。**已知缺口**：这些都是字符串匹配，`cd` 之后的相对路径、通配（`Application*`）、变量（`D=~/.secret-gate; cat $D/…`）、`find ~ -exec` 拦不住；OpenCode 丢掉带 `$` 的 `cd` 参数，`cd "$HOME/.secret-gate" && cat keys/…` 过得去；Codex 没有按路径的限制 |
| 执行器读凭据文件（2026-09-24 发现并修） | Claude 的读工具（Read/Glob/Grep/LS）原来不受路径限制，能读 `~/.secret-gate` 的私钥（可解所有密文）和远程接口的 TLS 私钥 | 受保护路径新增 `readDenied`：gate 目录、浏览器会话槽位、`remote/`；Claude 读工具按真实路径拒绝，OpenCode 加读拒绝；Codex 无按路径读限制，仍是缺口 |
| 令牌被盗（2026-09-24 起） | 删掉任务与线程，连同其战绩、路由日志和来源于它们的记忆行，抹掉自己发过的任务 | 删除请求本身进 daemon 日志（设备号 + 任务或线程 id）；界面删除前确认 |
| 公钥在手机上 | 无（公钥可公开） | 密文仍只能在 Mac 的 gate 解开，且受 host 绑定 |
| 应用内置运行时 | 运行时过旧、供应链 | 构建脚本固定版本并每次校验 SHA-256；Python 依赖按哈希安装；升级即重新打包 |
| 同一应用开两份 | 互相杀对方的 daemon | 单实例锁；遗留进程按 pid + 启动时间 + runtime 真实路径识别 |
| 配对链接进剪贴板 | 经通用剪贴板同步到其他设备 | 只存本机、Transient/Concealed、过期清除 |
| 同用户进程 | 改写应用的 runtime 路径、冒充 8080 上的 gate | Release 版不认 runtime 路径覆盖；gate 复用仍只看探测结果（已知缺口） |
| 手机发来的任务 | 用到 ssh-agent 里的密钥 | 保留（`git push` 需要，且属于人工审批类别）；可用 `ssh-add -c` 要求每次确认 |

## 7. 分工与验证（计划）

- daemon 远程接口：单元与集成测试（真实 TLS 监听、错令牌 401、来源网段过滤、配对一次性、路由白名单）。
- iPhone：`AgentSwitchKit` 单元测试；Swift 造的密文由 Python gate 解开的跨语言测试；模拟器构建。
- Mac 应用：`swift test` 覆盖纯逻辑；构建出 `.app`，用临时 `AGENTSWITCH_HOME` 和非默认端口实际启动，用脚本模拟手机完成配对、钉指纹、建任务（echo 执行器）。
- 本轮不做：推送、发布签名与公证、App Store 上架。（多台 Mac 已于 2026-09-27 做了，见 §5。）

## 8. 实现与验证记录（2026-09-24）

| 部分 | 位置 | 验证 |
|---|---|---|
| daemon 远程接口 | `packages/daemon/src/remote/`，`src/api/models.ts`，`npm run build` | vitest 920 项全过：真实 HTTPS 监听、配对正常与重用/过期/错 5 次、限流、吊销立即 401 并断开事件流、路由白名单、TLS 上的 SSE、指纹与 `openssl` 一致、构建后按 .app 布局实际启动 |
| iPhone 应用骨架 | `packages/ios-app`（`AgentSwitchKit` + `App/`） | `swift test` 73 项（3 项为按需开启的跨语言检查）；`scripts/crypto-crosscheck.sh` 证明 Swift 造的密文由 Python gate 解开且载荷字节一致；iPhone 17（iOS 26.4）模拟器构建并启动 |
| Mac 应用与打包 | `packages/mac-app`（`AgentSwitchMacCore` + 应用），`scripts/build-app.sh` | `swift test` 71 项；打出 `AgentSwitch.app`；冒烟 26 项（内置 gate + daemon，echo 执行器）与直接启动 .app 的 24 项全过；SIGTERM 干净退出、崩溃后遗留子进程被清理 |
| 端到端 | `packages/ios-app/scripts/e2e-live.sh` | 用 iPhone 应用自己的客户端代码连打包后的运行时（临时目录、非默认端口）：错指纹拒绝、钉指纹配对、`/me`、用二维码带来的公钥在“手机”端造密文、建任务并跟事件流到 `done`、任务里查不到明文、陌生令牌被拒 |

顺带修正：gate 的 label、host、scope 等校验改用整串匹配（原来 `$` 会放过结尾换行），端口只接受 ASCII 数字。

**已知未完成**：Mac 端 Bonjour 在正式 bundle id 下需要用户在系统设置里授权“本地网络”；设置窗口截图里选中标签的文字没被截进去，推测是截图方式（`cacheDisplay`）画不出 macOS 26 的玻璃效果，需在真实窗口里确认；iPhone 端不能选线程（设计如此，只能删）、没有推送（自动播报等推送）；真机安装需要 Apple 开发者账号签名。

**安全审查（2026-09-24）。** 接入后对远程访问做了一轮审查并修复：
- 高：持设备令牌可经任务文件接口读出 Mac 上任意文件（含 gate 私钥）——工作目录检查原本不拒绝禁区的上级目录、也不解析真实路径。现在按真实路径和设备号+inode 拒绝禁区、其内部和任何上级目录；文件接口只给 `in/`、`out/` 和保留的产物；远程不能指定工作目录和 `ephemeral`。
- 高：本地 127.0.0.1 接口不检查 Host 和 Origin，任意网页都能跨站提交任务（还能设成自动审批），DNS 重绑定能读配对码（开发用 daemon 原本就有此问题）。现在本地入口只认本机 Host/Origin，写操作必须是 JSON。
- 中：同一应用开两份会互相杀 daemon（单实例锁 + 精确识别遗留进程）；远程能把任务审批改成全自动、能把线程改成立即过期（远程拒绝 `approval`，线程只能改标题）。
- 低：复制的配对链接经通用剪贴板同步、Release 版认 runtime 路径覆盖、远程常开无开关、构建依赖未按哈希校验并带出本机路径，均已修。
- 修复后：daemon vitest 943 项、secret-gate pytest 476 项、iPhone `swift test` 74 项、Mac `swift test` 82 项全过；修复版 `AgentSwitch.app` 冒烟 26/26、端到端通过；开发用 daemon 重启后实测跨站请求和重绑定 Host 均为 403。

**第二轮（2026-09-24，单输入框）**：手机首页改成“日志 + 一个输入框”，线程全自动，高级里删除会话和任务日志；手机可编辑 `CONTEXT.md`，保存时过 sealer；模型目录加 `claude-opus-5-5` 与 `[1m]`。审查后修复：锁屏时的弹出页、发送超时导致重复建任务、安静任务的事件流反复重连（加心跳）、从详情页返回前实时流被重新拉起、远程写和删除不留痕（加日志与 `context-history/`）、lint 对自己的占位符再报警。验证：daemon vitest 全过（含 `contextSave`、远程写日志、远程删除与 `CONTEXT.md`）；iPhone `swift test` 83 项（4 项按需开启）；应用 `xcodebuild` 通过；重新打包的 `AgentSwitch.app` 上 `e2e-live.sh` 通过（含远程写 `CONTEXT.md` 与删除任务，仅在临时运行时里做）；真机 iPhone 17 Pro（iOS 27）安装。

**仍是已知缺口**：iPhone 的 Face ID 锁只是界面锁（令牌未与生物识别绑定）；同一局域网的人可以连发错码作废 Mac 上正在显示的配对码（暴力猜码不可行：每码 5 次、40 位码空间）；本机进程抢先占住网关端口并伪造探测应答会被当成 gate 复用；手机发来的任务能用 ssh-agent。
