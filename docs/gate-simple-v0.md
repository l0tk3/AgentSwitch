# gate-simple-v0：凭据网关简化——最小服务账户、两处出口、一条规矩（草案）

2026-11-23 安全审查之后定的（审查报告在房间“完善安全网关”共享目录的 `secret-gate-review-*.md`）。本稿收窄 `docs/gate-service-v0.md`：独立服务账户保留，只留最小的一部分。三个平台用同一个模型（macOS、Linux、Windows）。§3.1、§3.2 已做（`packages/secret-gate/secret_gate/redact.py`，测试 `tests/test_no_reconstruct.py`），§3.3、§3.4 已做，§1、§2（含 §2.1）在网关和 daemon 一侧已做（见各节末尾），§5 的 Linux 一列已做（§5 末尾），§5 的 Windows 一列**开发中**（§5 末尾），其余未做。

本稿只管网关，路由器的 sealer 不在本稿范围（用户定：先不管）。

## 0. 目标

用户定的目标（原话）：

> 模型正常工作情况下看不到明文密码，并且根据完整上下文也不可能推出来完整密码，除非它刻意去偷。

拆成三条：

1. **看不到**：模型上下文里出现的一切（工具结果、网页快照、截图、日志、报错）都不含明文。
2. **推不出**：把这些内容全部拼起来，也还原不出完整的值。零碎片段、换了编码的回显、长度都不行。
3. **私钥不在顺手可及之处**：私钥加上密文就等于明文。私钥要是 agent 账户下的一个文件，agent 正常干活时（`grep -r ~`、“看看我的配置”）就可能把它读进上下文，第 2 条随之失效。所以私钥放在另一个系统账户里，agent 的账户读不到。

**明确不防**：同账户、刻意去偷的程序。它可以冒充浏览器组件，经服务接口取出能填网页的值（§4）。另外，安装或更新那一刻 App 包如果已被篡改，服务装上的就是被改过的程序（§6）。这两条写明，不假装能防。

## 1. 结构：最小服务账户

服务账户只做三件事：

1. **保管私钥**：一对密钥，加上代理的 CA 私钥，只有服务账户读得到。
2. **跑代理**：mitmproxy 以服务账户运行，请求发出前把密文换成真值。
3. **答一个很小的本机接口**（§2）。

agent 的账户（也就是登录用户）这边只有：公钥（公开文件）、CA 证书、接口地址。

**删掉的**（相对现状）：

| 删掉 | 原因 |
|---|---|
| 多钥匙与旧钥匙（`keys new/use/retire/restore`、legacy、`keys.json` 多条） | 只剩一把。轮换走管理员操作：重新生成，旧密文作废，重新封装 |
| 安装时的迁移（`migrate.py`、`user_dir.py`，用户目录里的 refs、模板、例外名单、旧私钥） | 用户现在没有密文；装服务时直接生成新钥匙，不从用户目录搬任何东西，root 也不再读用户目录 |
| 凭据修复与重新签发（`credential.*`、`mcp.repair`、`secret_repair`、`totp_seed_import`） | 用得少，而且是第 3 条缺口所在。网站需要种子本身时，用户在 Mac 或手机上把种子另封一份“密码类”密文（`fill` 用途，只给那个网站）（用户定，2026-11-23） |
| 本地网关退路 | 装了服务就只走服务（今天已修，`48fa7df`）；没装服务的机器只用于测试和开发 |

已做（2026-11-23，网关与 daemon）：一把钥匙，就是钥匙目录顶层的 `key.priv`、`key.pub`（`secret_gate/keyring.py`；旧的 `keys/`、`current` 不再读）。`secret-gate keys --json` 仍是数组，恰好一行 `{"name": "main", "public", "current": true, "legacy": false, "created"}`，没有钥匙时是 `[]`；`keys new/use/retire/restore` 删除。没装服务时 `secret-gate keygen` 生成这一把，已有时拒绝，`--force` 替换（旧密文作废，命令会提示）。装了服务时钥匙由 `system install` 在服务目录里生成（服务启动时没有也会自己生成），换钥匙是 `secret-gate system rotate-key`（root，与安装同一条管理员授权路径）：生成新钥匙、重写 `keys.json`、`launchctl kill SIGHUP` 让代理重新加载。安装不再迁移任何东西（`migrate.py`、`user_dir.py`、`--import-config`、`MOVED.txt` 删除；`--migrate-from`、`--user-home` 照收不用，给还在传它们的 App）。`credential-info`、`credential-reissue`、`secret_repair`、`totp_seed_import` 删除；旧密文里的 `seed_import_hosts` 照样能解开，字段忽略，新封装不再写它。daemon 去掉修复桥、sealer 的种子导入用途，TUI 的密钥页只显示这一把（没有时可 `keygen`）。

## 2. 本机接口

只留下面这些方法。调用方按对端账户放行（与现在相同），每次调用记审计（不写值）：

| 方法 | 用途 | 返回明文？ |
|---|---|---|
| `status` | 服务是否在、代理端口、钥匙指纹 | 否 |
| `refs.register` / `refs.release` | daemon 为任务登记、释放短引用 | 否 |
| `mcp.describe` / `mcp.otp` / `mcp.http` | agent 的网关工具：查看密文元信息、取 6 位验证码、经代理发请求（结果先脱敏） | 否（验证码 30 秒失效，推不出种子） |
| `exec.resolve` | `secret_exec` 取值：只认 `exec` 用途的密文（封装时用户明确勾选），把值交给登录用户这边的 MCP 进程，由它带着环境变量跑命令（§2.1） | **是**，与 `browser.resolve` 同类 |
| `browser.register` / `browser.config` | 浏览器组件登记引用、读遮罩配置 | 否 |
| `browser.resolve` | 浏览器组件填网页时取值 | **是**，见 §4 |
| `logs.tail` | Mac 应用看服务日志（已脱敏） | 否 |

去掉的方法：`keys.new/use/retire/restore`、`keys.list`（改读公开的公钥文件）、`credential.info/reissue`、`mcp.repair`、`mcp.exec`（换成 `exec.resolve`，§2.1）。

### 2.1 `exec`：不要模板，值只走环境变量（用户定，2026-11-23）

- 工具：`secret_exec(argv, env)`。`argv` 是 agent 自己写的命令，里面不许出现密文；`env` 是 `{变量名: 密文或引用}`，例如 `{"PGPASSWORD": "enc:ref:…"}`。
- 命令**以登录用户身份**运行，不在服务账户里跑：如果让 agent 写的任意命令以服务账户运行，它一个 `ls`、`cat` 就能把服务目录里的私钥读进上下文，§0 第 3 条随之失效。值经 `exec.resolve` 从服务交给登录用户这边的 MCP 进程（`secret-gate mcp`），由它启动子进程。
- 子进程的环境只有 `PATH`、`HOME`、`LANG` 等基本变量，外加 `env` 里解出的这几个；标准输入为空。
- stdout、stderr 过 §3 的脱敏器（片段、编码、大小写都遮），超过上限就扣下。
- 只有封装时勾了 `exec` 用途的密文能这样用；网站密码默认只有 `http` + `fill`，不能被 exec 取出。
- 已知不防：agent 刻意变换后再输出（倒序、逐字拆开），或者把值发到别处、写进文件。这些属于“刻意去偷”，§0 已写明。正常使用中，`env`、`printenv`、`set -x` 这类调试输出都会被脱敏器遮住。

原来的模板（`exec_templates.json`）删除。

已做（2026-11-23）：`gate.sock` 只答上表的方法（`rpc_methods.METHODS`，测试 `tests/test_rpc.py::test_the_socket_answers_exactly_the_methods_of_gate_simple_v0`）。`exec.resolve {token, scope?}` → `{value, label}`，只认 `exec` 用途，审计只记 label。`secret_exec(argv, env)` 在 `secret_gate/gate_ops.py`：`argv` 里出现 `enc:`（任何大小写、URL 编码）就拒绝；`env` 1–32 个，名字须大写、不在加载器与解释器变量的拒绝名单里（`LD_*`、`DYLD_*`、`PATH`、`HOME`、`PYTHON*`、`NODE_*`、`BASH_ENV`、`GIT_*`、`LC_*` 等），每个值恰好一个密文或引用；子进程的 `PATH` 固定为 `/usr/local/bin:/opt/homebrew/bin:/usr/bin:/bin:/usr/sbin:/sbin`，另有本进程的 `HOME`、`LANG`、`LC_ALL`、`TZ`、`TMPDIR`；标准输入为空，工作目录是 MCP 进程的，60 秒超时；输出过同一个 `Redactor`，超过 4 MiB 整段扣下。没装服务时 MCP 进程自己解密，装了服务时经 `exec.resolve` 取值，命令都在 MCP 进程里以登录用户身份跑（测试 `tests/test_secret_exec.py`）。

## 3. 脱敏器：一条规矩

所有回到模型的文本都过同一个 `redact()`：代理的响应头和响应体、浏览器快照、`browser_find`、控制台、网络日志、工具报错。截图另走遮罩（§3.5）。脱敏不了就扣下，绝不原样放行。

### 3.1 匹配什么

对每个本次用到过的值 v：

1. **整值的各种编码**：原样、URL 编码、表单编码、HTML、JSON、JS 字符串转义、base64（标准与 URL 安全、有无填充、任意偏移）、十六进制。
2. **大小写不敏感**：回显被转成大写或小写也认。
3. **片段**：v 中任意一段连续 ≥ 4 个字符的子串，出现就遮掉。输出里最多留下 3 个字符的碎片，拼不出完整值。代价是会多遮一些无害文字，可以接受。
4. **按元素遮**：浏览器里网关填过的输入框，不论现在框里是什么，一律显示为 `[REDACTED:label]`（今天已做，`6a91506`）。

### 3.2 失败即扣下

- 响应体超过上限：整体替换成“内容过大，已扣下”。现在是超过 4 MiB 就原样放行，这一条要改。
- WebSocket 帧、HTTP trailer、不认识的压缩格式：只要这次请求用过值，就扣下或断开连接。
- 脱敏器自身出错：扣下。

### 3.3 封装下限

值短于 **8** 个字符时，拒绝封装成 `http`/`fill` 用途。太短的值遮不住，片段规则会把整页遮掉，长度本身也容易猜。现在的下限是 4（`MIN_REDACT_LENGTH`、daemon `MIN_VALUE_LENGTH`、手机端），一并改成 8。

已做（2026-11-23）：`secret-gate enc` 对 `http`、`fill`、`exec` 用途拒绝短于 8 个字符（按码位计）的值，报“值至少需要 8 个字符（过短的值遮不住，也容易被猜到）”；Mac 的封装表单、iPhone 与 Android 的 `SecretDraft` 和代理密码用同一句话先拦下。只用于 `otp` 的种子照旧只查 base32。daemon 的 sealer 不把短于 8 的值交给网关（只用于验证码的仍是 4），这样的值原样留在任务里，和以前短于 4 的值一样。脱敏器的 `MIN_REDACT_LENGTH` 另算，不在这一步。

### 3.4 不泄露长度

现在密文长度随明文长度变化（`crypto.py` 不做填充），模型从密文长短能推出密码位数。改为：封装前把明文补齐到 64 字节的整数倍，解密后去掉填充。Python、Swift（iPhone、Mac）、Kotlin（Android）三处封装代码一起改。用户现在没有密文，不需要兼容旧格式。

已做（2026-11-23）：封装的明文是 JSON，就在末尾补 ASCII 空格到 64 字节的整数倍（JSON 允许尾随空白，JSON 本身不以空格结尾，所以不含糊），格式仍是 `enc:v1:`；网关解密后先去掉尾随空格再解析，不补的旧密文照样能开。Python（`tokens.sealed_plaintext`）、iPhone 与 Android（`SecretPayload.sealedData`）补法相同，Mac 与 daemon 经 `secret-gate enc`。跨语言测试：1–200 个字符的值，密文长度都落在 64 字节的台阶上，且与 Python 自己封的长度相同。

### 3.5 截图

保留现有遮罩：先盖住，再截图；盖不住就拒绝截图。不变。

## 4. 浏览器出口

浏览器以登录用户身份运行（要有图形界面），所以填网页时，明文得经 `browser.resolve` 交给登录用户这边的浏览器组件。这是唯一一处服务会把明文交出账户边界的地方。约束如下：

- 只认 `fill` 用途、只认密文里封好的网站。
- 只用在网页表单里要填的值（网站密码），所以叫 `fill`。只放进请求头的 API key 只给 `http` 用途，这条路取不到它。
- 拿到值的组件只做一件事：按 ref 找到输入框、当场核对页面、写进去（今天的“一次调用完成”，`6a91506`）。值不进任何返回给模型的输出（§3.1 第 4 项）。
- 今天修好的都保留：在填过值的网站上只放行不改内容的按键；复制快捷键规范化后拦截；选择器里禁止转义和 `[value…]`；填过值后只能用 ref 指定元素。

已知：同账户的程序可以冒充浏览器组件调用 `browser.resolve`。这属于“刻意去偷”，§0 已写明不防。

## 5. 三个平台

| | macOS | Linux | Windows |
|---|---|---|---|
| 服务账户 | `_agentswitchgate`（现有） | 系统用户 `agentswitch-gate`（`useradd --system`） | 服务的虚拟账户 `NT SERVICE\AgentSwitchGate` |
| 服务管理 | LaunchDaemon（现有） | systemd 单元 | Windows 服务 |
| 私钥、CA 私钥 | 服务目录，0700 / 0600 | 服务目录，0700 / 0600 | 服务目录，ACL 只给服务账户（与 SYSTEM、Administrators，见 §5 末尾） |
| 本机接口 | unix socket `gate.sock`，按对端 uid 放行（现有） | 同左（`SO_PEERCRED`） | 命名管道，ACL 只给登录用户，并核对对端 SID |
| 公开文件 | 公钥、CA 证书 | 同左 | 同左 |
| 安装 | 一次管理员授权（现有） | 安装脚本一次 `sudo` | 管理员身份的终端里一次 `secret-gate system install`（还没有安装程序） |
| 运行时来源 | App 包里的副本，复制到 root 拥有的目录（§6） | 包管理器或安装脚本装到 root 拥有的目录，没有 App 包问题 | 装到 `Program Files`，只有管理员可写 |

代码组织：账户、服务管理、接口传输、文件权限按平台各写一层薄的适配；接口方法、脱敏器、代理、浏览器 gate 三个平台共用一份。Windows 是新增。AgentSwitch 的 daemon 与终端还没有 Windows 版本，网关先行，测试在 Windows CI 上跑。

Linux 没有 sudo 权限时的退路：网关以登录用户身份运行，私钥放在 0600 文件里。界面上明确提示：“此节点只防误看，不防顺手读取”。

**Linux 已做（2026-11-23，第 3 步）**：

- **平台层**：`secret_gate/platform/base.py` 的 `GatePlatform` 是每个系统要给的东西：路径（`system_root`、`runtime_dir`、`services_dir`）、属主（`root_owner`、服务账户）、建账户（`account_ops`、`gather_account`）、两个服务的定义与启停（`service_files`、`stop_ops`、`start_ops`、`reload_proxy_ops`）、对端 uid（`peer_uid`）。只产出数据（`system_ops` 的操作），不执行命令。`platform/macos.py` 是原来的 dscl / sysadminctl / launchctl / LaunchDaemon / `LOCAL_PEERCRED`，搬过去后安装、更新、换钥匙、卸载的计划与搬之前逐字节相同（macOS 的测试只改了导入，一行没动）；`platform/linux.py` 是新的；Windows 在这里加第三个模块。`system_plan` 只写一份，`SystemLayout(prefix, platform)`、`SystemLayout.native()` 给出各系统的路径，`rpc_protocol.peer_uid` 交给平台层。
- **账户**：系统用户 `agentswitch-gate`，`useradd --system --user-group --no-create-home --home-dir /nonexistent --shell /usr/sbin/nologin`（没有 `useradd` 时用 Debian 的 `adduser --system --group`；nologin 按 `/usr/sbin`、`/sbin`、`/usr/bin` 找，都没有用 `/bin/false`）。已有同名账户只在 shell 是 nologin/false、uid 不是 0 时沿用。装完用 `getent passwd`、`getent group` 核对。
- **目录**：`/var/lib/agentswitch/`（root 0755）下 `gate/`（服务账户 0700，同 macOS）、`gate-public/`（服务账户所有，**属组是登录用户的主组，0750**：只有登录用户的组进得去，其他本机账户连公钥和 CA 证书都读不到；socket 仍是 0666，靠对端 uid 放行）、`gate-service.json`（root 0644，是否装了服务只看它）。程序在 `/opt/agentswitch/gate-runtime/`（root 所有）。日志文件安装时预先建好再交给服务账户，免得 systemd 以 root 建（单元用 `StandardOutput=append:`）。
- **运行时**：Linux 节点的运行时装在登录用户可写的 `~/.local/share/agentswitch/runtime/<stamp>`。`system install|update --runtime <它>` 以 root 把其中的 `python/`、`secret-gate/`、`VERSIONS` 用与 macOS 相同的加固复制到 `/opt/agentswitch/gate-runtime`（不跟随链接、每项须属于运行时的属主），单元只运行这份副本。上表“没有 App 包问题”一格不对：问题一样在，只是包换成了用户自己的运行时——`sudo` 运行的就是它，那一刻它若已被 agent 改过，装进去的就是改过的程序（同 §6 的“已知不防”）。
- **systemd**：`/etc/systemd/system/agentswitch-gate-{rpc,proxy}.service`：`User=`/`Group=agentswitch-gate`，环境同 LaunchDaemon（`SECRET_GATE_HOME`、`HOME`、`SECRET_GATE_PUBLIC`、root 拥有的 `PATH`），`UMask=0077`、`Restart=always`，加固 `NoNewPrivileges`、`ProtectSystem=strict`（`ReadWritePaths` 只有网关目录和公开目录）、`ProtectHome`、`PrivateTmp`、`PrivateDevices`、内核与控制组保护、`RestrictAddressFamilies`、空的 `CapabilityBoundingSet`（`systemd-analyze security`：4.9 OK）。装、更新时 `daemon-reload` 再 `enable --now`；换钥匙 `systemctl kill --signal=SIGHUP`；卸载 `disable --now` 后 `daemon-reload`，账户和（默认）钥匙保留。
- **接口**：`gate.sock` 的对端 uid 由 `SO_PEERCRED` 给出，放行规则不变（root 与 `ownerUid`）。
- **命令**：`sudo …/secret-gate system install --owner-uid <uid> --port <端口> --runtime <运行时>`（不给 `--owner-uid` 时取 `SUDO_UID`）、`update`、`rotate-key`、`uninstall`、`status`，与 macOS 同一套；测试用 `--root <前缀> --platform linux` 在 Mac 上也能跑全套。拒绝信息按平台说：Linux 上是“凭据网关由系统服务管理，请用 sudo secret-gate system install|update|rotate-key|uninstall 操作。”
- **daemon（Linux 节点）**：`src/keeper/gateService.ts` 与网关同样只看 `gate-service.json`（读不了也按已装算）。装了时看护进程不起自己的网关、不在用户目录建钥匙，服务无响应时只记日志、不兜底；把服务的 `SECRET_GATE_PUBLIC`、`SECRET_GATE_CA` 和端口交给 daemon。配置出现、消失或服务端口变了（`update --port`），看护进程在下一次探测时交接：停掉或起回自己的网关，带新环境重启 daemon。`agentswitch gate`（新）、`doctor`、`config` 的 Keys 页说明网关在哪个账户下，并打印要用户自己运行的确切命令（本机的路径、uid、端口都填好）；AgentSwitch 从不运行 sudo。没装时三处用五种语言明说“此节点的网关以你的账户运行：只防误看，不防顺手读取”（daemon `src/i18n/`）；装了时 Keys 页不再给“创建密钥对”，改给 `rotate-key` 命令。`install.sh` 结尾运行 `agentswitch gate`（服务的运行时比节点的旧时打印 `system update`）。顺手修了看护进程第一次运行时建钥匙仍用已删除的 `keys new` 的问题（改为 `keygen`）。
- **实机验证**（OrbStack 里一台随手建的 Ubuntu 24.04 arm64，systemd 255，验证后删除）：`install.sh` 造运行时、起用户服务，`agentswitch gate` 与 doctor 说出同用户一档和安装命令；照打印的命令 `sudo … system install` 14 步全过（4 秒），看护进程下一次探测就停掉自己的网关、让出 8080，daemon 带上服务的 `SECRET_GATE_PUBLIC`、`SECRET_GATE_CA` 重启；两个进程以 `agentswitch-gate` 运行在 `/opt/agentswitch/gate-runtime`；登录用户读 `gate/`、`key.priv`、CA 私钥都是 Permission denied，`keys --json`、`enc --batch`、`system status`、`logs tail` 照常，`keygen` 被拒；经服务的代理对本机回显服务替换了密文、回显被遮成 `[REDACTED:vm/test]`；另一个本机用户进不了 `gate-public`，把它加进登录用户的组后能连到 socket，被 `SO_PEERCRED` 拒绝（rpc 日志 `uid 1000 is not allowed`）；`systemd-analyze verify` 通过；`rotate-key` 后公钥变了、代理日志 `key reloaded`；`update --port 8181` 换了端口（实机发现看护进程仍探测 8080，已修：端口变了也交接）；`uninstall` 停掉并去掉单元，看护进程回到同用户一档、重新起自己的网关。网关的 pytest 在这台机器上 678 项通过（只跳过 macOS 的 `LOCAL_PEERCRED` 一项和两项要 Chromium 的）。

**Windows：开发中**

**开发中（2026-11-23，用户定）**：Windows 一列的代码已在 main 上，网关全套测试在 Windows CI 和一台真实的 Windows 11（非管理员）上都通过；在 Windows 上实际安装服务的 smoke（`scripts/windows_service_smoke.ps1`）还没通过，修到一半停了。CI 的 Windows 任务设为不阻断（`continue-on-error`）。在它通过之前，不要在 Windows 上把服务模式当成可用。

下面是已写好的部分：

- **平台层**：`secret_gate/platform/windows.py` 是第三个 `GatePlatform`。`base.py` 为它多了几个钩子（`root_owned_ops`、`directory_ops`、`ownership_ops`、`key_access_ops`、`service_definition_ops`、`remove_service_ops`、`preflight`、`is_admin`），默认实现就是原来 POSIX 的 chown/chmod 与写服务定义文件，所以 macOS 和 Linux 的安装、更新、换钥匙、卸载计划与之前逐字节相同（新旧代码各渲染一遍比对过）。`--root <前缀> --platform windows` 在 Mac 上也能跑全套（Windows 路径去掉盘符放到前缀下）。
- **账户与服务（决定：一个服务、一个账户）**：虚拟账户只属于一个服务（`NT SERVICE\<服务名>`），两个服务就是两个都要读钥匙的账户。所以只有一个 Windows 服务 `AgentSwitchGate`，以 `NT SERVICE\AgentSwitchGate` 运行（SID 是 S-1-5-80 加服务名大写 UTF-16 的 SHA-1，不用查就知道，`fsacl.service_sid`，用 TrustedInstaller 的 SID 核对过算法）。服务本身是个小宿主（`secret_gate/win_service.py`）：pywin32 的 servicemanager 跑在运行时自己的 `python.exe -I -X utf8 -m secret_gate.win_service` 里（不用 pythonservice.exe，不在注册表里登记 Python 类），由它启动 `secret-gate rpc` 和 `secret-gate proxy` 两个子进程，任一退出 2 秒后重启（相当于 KeepAlive / Restart=always），子进程放进“宿主一走就全结束”的作业对象；宿主自己挂了由 `sc failure … restart` 重启。子进程的环境同 LaunchDaemon（`SECRET_GATE_HOME`、`HOME`、`SECRET_GATE_PUBLIC`、由运行时和 Windows 目录组成的 `PATH`），另有 `USERPROFILE`、`TEMP` 指向网关目录，没有代理变量；`-I` 让 `PYTHONPATH` 之类不起作用。注册用 `sc.exe create/config AgentSwitchGate binPath= … obj= "NT SERVICE\AgentSwitchGate" start= auto`，启停用 `net stop|start`（会等到真的停下、起来；`sc stop` 不等），卸载 `sc.exe delete`；都用 Windows 目录（`GetWindowsDirectoryW`）下的绝对路径。
- **目录与 ACL**：`%ProgramData%\AgentSwitch\`、`%ProgramFiles%\AgentSwitch\gate-runtime\` 取自外壳的已知文件夹，不读环境变量（提权运行的安装命令带着用户的环境）。每个目录一建好就写上受保护的 ACL（pywin32 整个写入，不用 icacls 增删；属主 Administrators；下面的东西只继承）：根目录 SYSTEM、Administrators 完全控制，Users 与服务只读；`gate\` 只有 SYSTEM、Administrators、服务账户，在写进钥匙之前就设好；`gate-public\` 服务修改、`ownerSid` 的登录用户只读，不给 Users（同 Linux 的 0750）；`gate-service.json` 继承根目录，只有管理员能写，是否装了服务只看它，字段是 `ownerSid`（不是 `ownerUid`）。**与原定不同**：`gate\` 的 ACL 留了 Administrators（原定只有 SYSTEM 与服务账户）。安装和 `rotate-key` 由管理员的提权进程写钥匙，同 POSIX 上 root 能读；不留就得每次夺取所有权。UAC 下管理员的非提权进程里这个组只用于拒绝，所以以管理员身份登录、非提权运行的 agent 仍读不到；关了 UAC 或 agent 提权运行就读得到（BOUNDARY“已知缺口”）。普通用户能在 ProgramData 里建文件夹，所以安装前已存在、属主不是 Administrators/SYSTEM/TrustedInstaller 的 `%ProgramData%\AgentSwitch` 直接拒绝（可能藏着别人放的钥匙）。
- **运行时**：`--runtime` 是一个含 `python\`（装了 secret-gate 的完整 Python，不是 venv；pip 会带上 `pywin32`，pyproject 里 `sys_platform == "win32"` 的依赖）和 `VERSIONS` 的目录。复制到 Program Files 时每一项先 lstat，符号链接、联接点和其他重解析点一律拒绝；打开后须仍是看过的那个文件（卷号、文件号相同）且只有一个硬链接（Windows 上没有目录描述符和 `O_NOFOLLOW`，这是对应的做法）。没有 sh 包装脚本，服务直接运行副本里的 `python.exe`。和 Linux 一样，运行时在用户可写的位置，授权那一刻它若已被改过就防不住。
- **本机接口：命名管道**：`gate.sock` 在 Windows 上是 `\\.\pipe\agentswitch-gate`（`secret_gate/winpipe.py`；其他公开目录按路径哈希各有自己的名字，测试互不干扰）。代码里仍以 `<public>/gate.sock` 这个路径称呼接口，到传输层才换成管道名，所以 `client_socket`、`RpcClient`、`system status` 的调用处都没变。服务端：每个实例的安全描述符属主是服务账户，服务账户完全控制，`ownerSid` 与 SYSTEM 只能读写数据（不给 `FILE_APPEND_DATA`，它在管道上就是“新建实例”，给了等于让人往服务的管道里加自己的实例）；第一个实例带 `FILE_FLAG_FIRST_PIPE_INSTANCE`，拒绝远程客户端；读到第一行后模拟客户端，取其令牌的用户 SID，不是 SYSTEM 或 `ownerSid` 就不答断开（Windows 只在读过数据后才允许模拟；原计划的 GetNamedPipeClientProcessId → OpenProcessToken 行不通：虚拟账户打不开别的用户的进程）。客户端：只以识别级别连接（服务不能冒用它），发任何东西之前读管道的属主，装了服务时必须是服务账户、否则是自己；抢先建同名管道的程序过不了这一关（只造成服务起不来）。是否走服务与其他平台一样只看 `gate-service.json`，服务账户自己的进程除外，不退回本地网关。
- **换钥匙**：Windows 没有 SIGHUP。代理每 2 秒看一次 `key.priv` 和 `upstream-insecure.txt`（mtime、大小、文件号），变了就重新加载，加载失败保留原来的（`reload.py`）；所以 `rotate-key` 的“通知代理”一步在 Windows 上没有命令。`upstream-insecure.txt` 的可信与否看 ACL（`fsacl.write_problem`），不看 Windows 没有的 group/other 位；`proxy.pid` 不看属主和权限位，存活用 `OpenProcess`/`GetExitCodeProcess`（Windows 上 `os.kill(pid, 0)` 会结束那个进程）。
- **没装服务时（登录用户一档）**：`secret-gate keygen` 建的 `%USERPROFILE%\.secret-gate` 有只给本人的受保护 ACL，里面的文件继承它；私钥的 ACL 让本人、SYSTEM、Administrators、服务账户以外的人能读（或能改 ACL）就拒绝加载（`secret_gate/fsacl.py`，POSIX 上照旧是 0700/0600）。`secret-gate proxy` 在 Windows 上在本进程里跑 mitmdump（Windows 的 `os.execv` 会另起进程再退出，看护它的宿主会以为它死了）。CLI 往管道、文件写 UTF-8（Windows 默认用 ANSI 代码页，中文提示会编码失败）。
- **`secret_exec`**：子进程环境的基础来自系统：`SystemRoot`、`windir`、`SystemDrive`、`ComSpec` 取 Windows 目录，`PATHEXT` 固定为 `.COM;.EXE;.BAT;.CMD`，`PATH` 固定为 `System32`、Windows 目录、`Wbem`、Windows PowerShell、`OpenSSH`，另取本进程的 `TEMP`、`TMP`、`USERPROFILE`、`HOMEDRIVE`、`HOMEPATH`、`APPDATA`、`LOCALAPPDATA`、`USERNAME`、`LANG`、`LC_ALL`、`TZ`。拒绝名单在 Windows 上多了这些名字本身和会让 cmd、PowerShell、.NET 运行时、加载器换个东西跑的变量（`PATHEXT`、`COMSPEC`、`PSModulePath`、`__COMPAT_LAYER`、`_NT_SYMBOL_PATH`、`COR_*`、`CORECLR_*`、`COMPLUS_*`、`DOTNET_*` 等）；macOS、Linux 的名单不变。
- **命令**：管理员身份的终端里 `secret-gate system install --runtime <目录> [--port N] [--owner-sid S-1-5-21-…]`（不给 `--owner-sid` 取运行命令的用户，UAC 提权不换用户），`update`、`rotate-key`、`uninstall [--delete-keys]`、`status [--json]`（报告多一个 `ownerSid`）同其他平台。拒绝信息：“凭据网关由系统服务管理，请在以管理员身份运行的终端里用 secret-gate system install|update|rotate-key|uninstall 操作。”
- **没有移植的**：AgentSwitch 的 daemon、看护进程、终端、Mac 与手机应用没有 Windows 版本，本步也不做；所以 Windows 上没有任何东西替用户运行安装、交接端口或配置 agent（`secret-gate bootstrap` 与 harness 配置在 Windows 上未做也未测，它们的测试在 Windows 上不收集）。
- **在本机（Mac）验证了的**：全套 pytest（Windows 专用的跳过）；Windows 的计划、`--root --platform windows` 的整套 CLI（安装、状态、换钥匙、更新、卸载）、运行时复制拒绝链接与硬链接、宿主的进程看护、ACL 判定、服务 SID、管道命名与客户端该认谁、`secret_exec` 的 Windows 环境与拒绝名单、代理的文件监视，都靠注入在 Mac 上跑（`tests/test_system_windows.py` 等）；把 POSIX 才有的属性（`os.getuid`、`O_NOFOLLOW`、`AF_UNIX`、`SIGHUP`…）删掉后导入每个模块，都能导入；macOS、Linux 的计划逐字节不变。pywin32 的函数名对照 pywin32 312 的 Windows 轮子核对过。
- **只在 Windows CI 上验证的**（`.github/workflows/ci.yml` 的 `secret-gate-windows`，`windows-latest`）：pytest 在 Windows 上的结果，其中 `windows` 标记的测试只在那里跑（ACL 的设置与读取、`keygen` 的目录 ACL、可读私钥被拒、联接点不跟随、已知文件夹；管道的放行与拒绝、客户端拒绝别人建的管道、管道名只能占一次、协议错误与超大请求、`secret-gate rpc` 进程端到端；`secret_exec` 用 cmd 与 PowerShell 的真实回显、环境、以本人身份运行、经服务取值）；然后 `scripts/windows_service_smoke.ps1` 在运行器上真的安装服务：用 setup-python 的 Python 造运行时、`system install`、核对服务和两个子进程以 `NT SERVICE\AgentSwitchGate` 运行且跑的是 Program Files 的副本、`gate\` 的 ACL 只有三个账户且不继承、`gate-public\` 没有 Users；以本人身份 `system status`、`keys`、`enc`，`keygen` 被拒；经服务的代理用 curl 和发布的 CA 访问本机的 HTTPS 回显站（自签名，写进 `upstream-insecure.txt`，代理自己发现），站点收到真值、curl 看到 `[REDACTED:echo/pass]`；`rotate-key` 后旧密文失效、新密文可用（代理自己发现了新钥匙）；`uninstall --delete-keys` 后服务和目录都没了。**写这段时这个任务还没在 CI 上跑过**；运行器是关了 UAC 的管理员，所以“登录用户读不到 `gate\`”只按 ACL 核对，没有以非管理员账户实际读一次。

## 6. 安装与更新（macOS）

- 安装：一次管理员授权，建账户、建目录、生成新钥匙、复制运行时、装 LaunchDaemon。不碰用户目录。
- 复制运行时保留今天的加固（`00f5253`）：不跟随符号链接、只收属主正确的文件、不改权限。
- 网关运行时单独带版本号，只有网关自己的版本变了才提示更新，App 其他部分更新时不动服务。这样需要管理员授权的次数降到最少，伪造“需要更新”提示的机会也少了。
- 已知不防：授权那一刻 App 包已被篡改。改成 Developer ID 签名、提权前由 App 校验，是以后的事。

## 7. 落地顺序

1. **脱敏器补齐**（§3.1、§3.2）与**封装下限、长度填充**（§3.3、§3.4）。它直接对应“推不出”，与服务的去留无关，先做。
2. **精简服务**（§1、§2）：删方法、删多钥匙、删迁移、删 repair；daemon、Mac、iPhone、Android 同步改。
3. **Linux 服务账户**（§5）：安装脚本、systemd 单元、`SO_PEERCRED`。——已做（2026-11-23，见 §5 末尾，含实机验证）。
4. **Windows**（§5）：服务、命名管道、ACL，以及 Windows CI。——**开发中**（2026-11-23：测试通过，服务安装 smoke 未通过，见 §5 末尾）。
5. 重写 `BOUNDARY.md`：按“出口 × 输出”列表，开头写明 §0 的“不防”。`gate-service-v0.md` 标为“已被本稿收窄”。

每一步都要有测试。“推不出”专门有一组：模拟网站按各种方式回显（整值、截断、分段、大小写、base64、十六进制、超大响应、WebSocket），断言模型能看到的输出里拼不出原值。

## 8. 待用户定

- ~~Q1~~：已定——`exec` 保留，不要模板、值只走环境变量（§2.1）；凭据修复删除，种子需要填写时由用户另封一份密码类密文。
- ~~Q2~~：已定——最短 8 个字符。
