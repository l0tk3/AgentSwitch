# 网状连接与 Linux 主机 v0（草案）

> 状态：设想加一次可行性验证（2026-10-04），未拍板、未实现。演示页是 `docs/design/concepts/mesh.html`（2026-10-02）。
> 用户最初的话：手机可以连接多个电脑，电脑和多个电脑之间可以互相连接成为网状，可以使用对方的 terminal 和 dispatch。
> 这次的话：网状连接能构思验证一下不……是不是也可以适配一下 linux？没有桌面环境的话就纯服务端然后用 cli 配对？

## 0. 一句话

**不需要新协议**。现有的远程接口（`app-v0.md` §2：自签证书加钉指纹、一次性配对码、设备令牌、私网来源限制）已经是“一个使用端连一台主机”的完整通道，手机今天就是这样连 Mac 的。网状连接是把这条通道用在更多的两端之间；Linux 主机是把同一套服务端放到没有桌面的机器上。

## 1. 两种角色

- **主机**：跑服务（daemon 加凭据网关）的机器。今天只有 Mac 应用；加上 Linux 纯服务端。
- **使用端**：连到主机、用它的 Dispatch 与 Terminals 的一方。今天只有 iPhone；加上 Mac 主窗口，以后可以有命令行。

一台 Mac 两种角色都是：它自己是主机，它的主窗口又可以是别的主机的使用端。“网”就是若干条“使用端 → 主机”的有向边；两台 Mac 互相使用是两条边，各配一次对。

## 2. 一条边就是一次配对

沿用现有机制，不改：主机出一个 8 位配对码（5 分钟、一次有效），使用端凭码换设备令牌，并钉住主机证书的指纹。

- **逐对授权**是这个机制自然的结果：谁能用谁，以各主机自己的设备列表为准，可以单独吊销。“信任组”（一组机器互相全通）需要另一套密钥分发，不做。
- **被使用的一方说了算**：远程接口本来就不开放审批策略、设备管理、扩展注册表、`bypass` 模式等，只有主机本机能改。Mac 作为使用端先与手机同权。
- 设备的 `platform` 多两个取值：`macos`、`linux`（今天只有 `ios`）。

## 3. Linux 主机：纯服务端

- **组成**与 Mac 包里的 `runtime` 相同：Node、daemon、Python、secret-gate；没有菜单栏应用，由 systemd 用户服务看护，或前台运行 `agentswitch serve`。
- **配对用命令行**。本地接口都已经有（`POST /pairing`、`GET` / `DELETE /devices`、`GET /remote/info`），只差命令行外壳：
  - `agentswitch pair`：打印配对码、链接、指纹（可选在终端里画二维码）。
  - `agentswitch devices`、`agentswitch revoke <id>`。
  - `agentswitch remote`：名称、端口、指纹、地址。
- **发现**：没有 Bonjour（可选 avahi）。使用端靠配对载荷里的地址，连上后用 `/addresses` 更新，和今天一样。
- **凭据**：每台主机有自己的网关和密钥对，密文按主机封装，A 主机的密文在 B 主机解不开——凭据不随连接扩散，这是要的效果。使用端给哪台主机发密文，就用哪台主机的公钥（配对载荷里的 `gate` 本来就是每台主机一份）。

## 4. 使用端要做的事

- **iPhone**：从“同一时间只连当前 Mac”改成几台主机同时在线，每台一条连接和事件流。演示页建议的默认：界面按主机分开看，提醒汇总。
- **Mac 主窗口**：加主机选择（本机，加已配对的主机）。Dispatch 页的接口层当初就按“可以连别的主机”写的（视图只依赖 `DispatchService`），需要一份走远程接口的实现——配对、钉指纹、事件流这些逻辑 iPhone 的 `AgentSwitchKit` 里已有，移到 Mac。Terminals 页连远程主机时走远程的终端流（手机今天的路径）。
- **命令行**：以后再说。

## 5. 不做

- 信任组。
- 中转（relay）：只走局域网、Tailscale、其他私网的直连；来源网段白名单已经覆盖。
- 跨主机调度（A 主机的调度把任务派给 B 主机的 agent）：是另一件事，这里的“使用对方的 Dispatch”指的是直接对 B 主机说话。

## 6. 验证记录（2026-10-04）

环境：这台 Mac（经 VPN）→ 一台 Linux（Ubuntu 24.04、x86_64、无桌面、系统 Node 18）。

做法：在 Linux 的 `Scratch` 下建一个目录，里面放校验过的便携 Node 24.21.0、在 Linux 上现编的 daemon（`npm ci`、`tsc`）、装在虚拟环境里的 secret-gate；`HOME` 与各种缓存都指进这个目录。验证完整个目录删除，机器恢复原样。

| 项 | 结果 |
|---|---|
| daemon 在 Linux 上启动（echo 路由与执行器，远程开启） | 通过，**没改一行代码**；证书由系统的 `openssl` 生成；名称回退到主机名 |
| 命令行配对 | 通过：在 Linux 上调本地的 `POST /pairing` 拿到配对码与链接 |
| 手机的客户端代码连 Linux 主机 | 通过：用 `AgentSwitchKit` 的 `LiveDaemonTests` 从这台 Mac 连过去——配对、钉指纹、造密文、建任务并跟完事件流、陌生令牌被拒、Terminals 列表与样式、CONTEXT、上传、助理、删除任务。唯一失败的断言是“`bypass` 应回 403”：Linux 上没装 Claude Code，先回了 400，是环境差异 |
| 第二个使用端 | 通过：这台 Mac 用 `curl`（核对指纹后）配对成另一个设备，`/me`、`/terminals`、`/targets`、`/addresses` 正常 |
| 远程新建终端 | 部分通过：Linux 上的伪终端进程起来了，输出经远程流回到这台 Mac；但 agent 本身没跑起来，见下一行 |
| 真 agent、真模型 | **没做成**：公开发行的 OpenCode 是 1.18.34，AgentSwitch 驱动的是 2.0.8（`serve --stdio`、终端的启动参数都是 2.x 的），1.18 收到这些参数直接打印帮助退出。OpenCode 2 的 Linux 版没找到公开下载。复制过去的两条凭据（DeepSeek、OpenRouter）随即删除 |
| 另一台 Mac | **还没验证**：后来拿到用户名，SSH 可用（macOS 27.0.1、arm64，装着 OpenCode 2.0.18，AgentSwitch 的凭据网关服务已在运行）。只看了环境，没往上面放任何东西 |

## 7. 验证里发现要改的地方（Linux 适配清单）

1. 命令行缺 `pair`、`devices`、`revoke`、`remote`（§3）。
2. **地址**：配对载荷和 `/addresses` 的 `lan` 把 Docker 网桥的地址也列了进去（那台机器上 11 个里有 10 个是）。使用端会逐个去试。Linux 上要按网卡过滤（`docker0`、`br-*`、`veth*`、`virbr*`）。
3. **名称**：回退出来是 `reg737-Standard-PC-i440FX-PIIX-1996`。要能在安装时或用命令行起名（今天只有环境变量 `AGENTSWITCH_REMOTE_NAME`）。
4. **文案**：`is not installed on this Mac` 这类写死 Mac 的句子。
5. **node-pty** 没有 Linux 的预编译包：安装包要带按架构编好的，或安装时现编（需要 gcc、make、python3）。
6. **Python 依赖锁**（`python-requirements.txt`）只有 macOS 的 wheel 哈希，Linux 要另出一份。
7. **agent 版本**：OpenCode 见 §6；Claude Code 与 Codex 在 Linux 上没试。
8. 这台 Mac 上 AgentSwitch 终端的环境带凭据网关的代理（`HTTPS_PROXY`）：使用端连别的主机的远程口不能走它（网关不认自签证书）。Mac 使用端实现时要注意。
9. 没验证的：systemd 看护、浏览器（无桌面时）、受保护路径规则里 macOS 专有的目录、Tailscale。

## 8. 待拍板

1. 逐对授权（建议）还是信任组。
2. Mac 作为使用端的权限与手机相同（建议），还是更多。
3. 手机上按主机分开看、提醒汇总（建议），还是合并成一张列表。
4. 远程终端只发文字和指定按键，还是完整键盘（演示页里的开关；手机今天是前者）。
5. Linux 的安装形态：一个压缩包加安装脚本（systemd 用户服务）？
6. 先后：建议 ① Linux 纯服务端加命令行配对（改动最小，这次已验证可行）→ ② 手机几台主机同时在线 → ③ Mac 主窗口连别的主机。

## 9. 暂存（2026-10-04 夜）

用户：网状的实现先落盘暂存，先把交互修好。到此为止只有这份文档和上面的验证，没有改任何产品代码；两台远端机器上都没有留下东西。

接着做时从这里开始：

1. **在另一台 Mac 上补“真 agent”那一步**（Linux 上因 OpenCode 版本没做成）。做法同 §6：把这台 Mac 应用包里的 `runtime`（Node、daemon、Python、secret-gate，自包含）拷到那台 Mac 的一个临时目录，`HOME` 与缓存都指进去，用非默认端口起一套一次性的网关和服务；从这台 Mac 配对后远程新建 OpenCode 终端、发一句话、读回答，再发一个钉住 OpenCode 的 Dispatch 任务。那台 Mac 上已经装着正式的 AgentSwitch 网关服务，一次性的那套要用自己的空目录（`SECRET_GATE_PUBLIC` 指向空目录），不碰它。做完删除临时目录。
2. OpenCode 2 的凭据在 `~/.local/share/opencode/opencode.db` 的 `credential` 表里（1.x 是 `auth.json`，`type` 的取值也不同）；要用的话经加密连接直接写过去，不显示，用完即删。
3. 之后按 §8 的先后做：Linux 纯服务端加命令行配对 → 手机多主机 → Mac 主窗口连别的主机。
