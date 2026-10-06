# agents-v0：Agents——四个 agent CLI 的安装、更新与版本

2026-10-06 用户：我觉的 agent switch 应该自带一个 cli 管理功能，自动提示 Claude code、codex、opencode、pi 是否安装、点击安装功能、更新探测功能、一键更新功能、安装测试版功能、选中某个版本和删除某个版本的功能；测试版和正式版分开存放，分开更新，安装的正式版可以在命令行直接调用，然后在 agentswitch 设置里可以选择选中哪个版本使用，删除哪个版本（app 里的 codex 不可删除）（删除应该有警告）；然后做好缓存管理，不要留下一直堆积的垃圾。

随后定的两件事：已有的安装“AgentSwitch 管理，但是要求卸载了 AgentSwitch 也不影响原有的使用”；测试版“另起名字放到命令行”。

本文是草案；界面以演示页 `docs/design/concepts/agents.html` 为准。此前 app-v0 §4 的规定是“执行器需自行安装并登录，应用只检查、不代为运行安装命令”，本文取代其中“只检查”的部分；登录仍由用户自己在终端里完成。

## 0. 要点

- **正式版装在各家自己的地方**。AgentSwitch 替你安装、探测更新、更新、换版本、卸载，但装出来的东西和你自己照官方说明装的一模一样：同样的位置、同样的目录结构、同样的命令名，各家自带的更新照常工作。命令行和 CLI 之间不夹任何 AgentSwitch 的东西。**删掉 AgentSwitch 后，它们就是一套普通的官方安装**，照常能用、照常自己更新。
- **测试版和指定版本放在 AgentSwitch 自己的版本库里**，和正式版分开存放、分开更新。测试版在命令行里另起名字：`claude-beta`、`codex-beta`、`opencode-beta`（pi 没有测试通道）。版本库不在应用包里，也不在应用的数据目录里；它的启动脚本不依赖应用，删掉 AgentSwitch 后仍然能用，也可以整个删掉而不影响正式版。
- **AgentSwitch 自己用哪一个，在设置里选**：每个 agent 一项——正式版、测试版、某个指定版本，Codex 另有 ChatGPT App 自带的那份。命令行里用哪个和 AgentSwitch 用哪个互不相干。
- **只动程序文件**。登录、配置、会话记录、插件一概不碰；删除只在几处已知的程序目录里进行，每次删除先说清楚删什么、多大。
- **下载的东西先校验再使用**：只从各家的官方地址下载，按官方公布的校验值（SHA-256 / SHA-512）核对，不符就丢弃。
- **不留垃圾**：下载放在临时目录、用完即删、启动时清扫；测试版每个 agent 只留一个版本，更新即替换；指定版本只有你明确装的那些；各家自己攒下的旧版本可以一键清掉。

## 1. 四家怎么发布、怎么安装（2026-10-06 实测）

| | 正式版 | 测试版 | 官方安装位置 | 它自己的更新 | 校验 |
|---|---|---|---|---|---|
| Claude Code | `downloads.claude.ai/claude-code-releases/stable`（当日 2.1.285） | 同处的 `latest`（2.1.291） | `~/.local/share/claude/versions/<版本>`（单个可执行文件，约 230 MB），`~/.local/bin/claude` 是指向当前版本的链接 | 后台自动更新；`claude update`；`claude install <stable\|latest\|版本>` | `/<版本>/manifest.json` 里各平台的 SHA-256 与大小 |
| Codex | `releases.openai.com/codex/channels/latest`（0.160.1），与 GitHub `openai/codex` 的正式发布一致 | GitHub 上的预发布（`rust-v0.162.0-alpha.16`，一天数个） | 官方脚本装到 `~/.codex/packages/standalone/`，`~/.local/bin/codex` 链接过去；另一种是 ChatGPT App 自带的一份 | `codex update`（自己认得安装方式） | 发布文件各带 `sha256:` 摘要，另有 `codex-package_SHA256SUMS` |
| OpenCode | v2：npm `@opencode/cli-<平台>` 的 `latest`（2.0.24），`opencode.ai/update/api/latest/cli/npm` 给出当前版本 | 同一个包的 `beta`（`0.0.0-beta-19507`）、`dev` | `~/.opencode/bin/opencode`（单个可执行文件） | `opencode upgrade [版本]` | npm 的 `dist.integrity`（SHA-512） |
| pi | npm `@earendil-works/pi-coding-agent` 的 `latest`（1.0.4），`pi.dev/api/latest-version` | 没有 | `~/.pi/agent/install/releases/<版本>/`（一组 npm 包，需要 Node.js ≥ 22.19），`current-version` 记当前版本，`~/.local/bin/pi` 链接到 `~/.pi/agent/bin/pi` | `pi update self` | 发布清单里每个包的 `integrity` |

几件要紧的事：

- **OpenCode 只认 v2 这条线**。GitHub 上标为最新的是 v1（1.18.x），而 AgentSwitch 的 OpenCode 集成按 v2 写（`session_v2`、`serve` 的接口、`session delete`）。找到的 v1 只列出来、标明不支持，不提供安装和更新。
- **Claude Code 的两个通道**：`latest` 是它默认跟的通道，`stable` 大约晚一周、跳过出过问题的版本。它没有公开的预发布，这里把 `stable` 当正式版、`latest` 当测试版。原位安装跟哪个通道是 Claude Code 自己的设置（`autoUpdatesChannel`），AgentSwitch 显示它、不替你改；所以原位安装的版本可能比 `stable` 新，这时不算“有更新”。
- **各家自带的更新**：原位安装的照常工作（这正是“不影响原有的使用”）。版本库里的副本由 AgentSwitch 启动或经 `*-beta` 启动时关掉它们的自更新（Claude Code `DISABLE_AUTOUPDATER=1`，OpenCode `OPENCODE_DISABLE_AUTOUPDATE=1`），否则一个测试版会在后台把原位的正式版换掉。
- **本机当日的样子**：Claude Code 原生安装 2.1.291，自己攒了 3 个版本共 660 MB；Codex 只有 ChatGPT App 里那份（当晚随 App 从 0.158.0-alpha.2.1 变成 0.160.1）；OpenCode 2.0.18；pi 0.87.1（落后一个大版本）。

## 2. 三种来源

每个 agent 在设置里是一张表，每行一个“安装”：

| 来源 | 在哪 | 命令行 | 谁更新 | 能删吗 |
|---|---|---|---|---|
| **Stable**（原位安装） | 各家的官方位置（§1） | `claude` `codex` `opencode` `pi` | 它自己，或你在这里点 Update | 能（卸载；先警告） |
| **Beta** | 版本库 `beta/` | `claude-beta` `codex-beta` `opencode-beta` | 只在这里点 Update | 能 |
| **Pinned**（指定版本） | 版本库 `pinned/<版本>/` | 没有 | 不更新（它就是那个版本） | 能 |
| **ChatGPT App**（仅 Codex） | `ChatGPT.app` 里 | 没有 | 随 App | 不能 |
| **Other**（别处找到的，如 Homebrew、npm 装的，或 OpenCode v1） | 原处 | 原样 | 它自己的安装方式 | 不在这里删；写出它在哪、怎么卸 |

- 版本库在 `~/.local/share/agentswitch/cli/`（不带空格的路径；不随应用的数据目录走）：`<agent>/beta/<版本>/`、`<agent>/pinned/<版本>/`、`downloads/`（进行中的下载）。
- `*-beta` 是写在 `~/.local/bin/` 里的几行 shell 脚本：设好关掉自更新的变量，`exec` 版本库里那个版本的程序。脚本第二行是固定的记号，AgentSwitch 只改写、只删除带这个记号的文件；同名文件不是它写的就不动，并在界面上说明。`~/.local/bin` 不在登录 shell 的 PATH 里时，界面写出要加的那一行，不替你改 shell 配置。
- Pinned 是“给 AgentSwitch 用的某个确定版本”：某个新版本出问题时退回去用，或固定在验证过的版本上。它不上命令行。pi 的程序是一组 npm 包，暂不做 Beta 与 Pinned（它也没有测试通道）；要换版本就把原位安装换成那个版本（官方脚本的 `?version=`）。

## 3. AgentSwitch 用哪一个

- 每个 agent 选一行（单选）。默认：有 Stable 用 Stable；Codex 没有 Stable 时用 ChatGPT App 那份；都没有就是没装。
- 选择记在应用的设置里；应用启动服务时把四个路径交给它（`CLAUDE_BIN`、`CODEX_BIN`、`OPENCODE_BIN`、`PI_BIN`，后两个是新加的；Codex 原来写死在模型目录文件里，现在环境变量优先）。**改选择要重启服务才生效**：界面上写“重启服务后生效”，有任务在跑时先问；已经开着的终端继续用它启动时的那个程序。
- 选了版本库里的版本时，交给服务的是那个版本的启动脚本（同 `*-beta`，关掉自更新），所以服务不需要知道这些变量。
- 选中的那一行被删掉、或它的程序不见了：退回默认，并在这一页和环境检查里标出来。
- **低于验证过的版本时提醒**：每个 agent 记一个 AgentSwitch 验证过的最低版本（Codex 0.158、OpenCode 2.0.18、Claude Code 2.1.280、pi 0.87）。选更旧的不拦，只在那一行写“低于 AgentSwitch 验证过的版本”。

## 4. 更新探测

- 应用问各家的发布地址（§1 表里的那些）：打开这一页时、点 `Check Now` 时、以及应用运行期间每 12 小时一次。结果连同时间记在应用的数据目录里，下次打开先显示上次的结果。
- 一行“有更新”的条件：它跟的通道有比它新的版本。Stable 行按正式版比（Claude Code 的原位安装按它自己跟的通道比）；Beta 行按测试版比；Pinned 和 ChatGPT App 不比。
- 有更新时：这一页的那一行出 `Update → 版本`；设置侧栏的 `Agents` 带数字；环境检查清单多一项“有 N 个更新”。**不自动安装**，只提示。
- 探测只读发布信息，不带任何本机信息；GitHub 的匿名接口每小时 60 次，12 小时一次绰绰有余，失败就保留上次的结果并标出时间。

## 5. 操作

每个操作是一个任务：有进度（下载的字节数）、有日志的末尾几行、能取消（下载阶段）、同一个 agent 同时只做一个。失败不留半成品。

| 操作 | Claude Code | Codex | OpenCode | pi |
|---|---|---|---|---|
| 装 Stable | 下载 `stable` 那个版本的程序、校验，然后运行它的 `install stable`（官方脚本就是这么做的） | 运行官方安装脚本（非交互） | 运行官方 v2 安装脚本，指定版本、不改 shell 配置 | 运行官方安装脚本（需要 Node.js ≥ 22.19，没有就说明并停下，不替你装 Node） |
| 更新 Stable | `claude update` | `codex update` | `opencode upgrade <版本>` | `pi update self` |
| 装 / 更新 Beta | 下载 `latest` 的程序、校验，放进版本库 | 下载最新预发布的 `codex-package`、校验、解包进版本库 | 下载 `beta` 的 npm 包、校验、取出程序 | — |
| 装 Pinned | 同上，指定版本 | 同上，指定版本（正式或预发布） | 同上，指定版本（v2） | — |
| 删 Stable（卸载） | 删 `~/.local/share/claude/` 与 `~/.local/bin/claude` | 删 `~/.codex/packages/standalone/` 与 `~/.local/bin/codex`、`codex-code-mode-host` | 删 `~/.opencode/bin/opencode` | 删 `~/.pi/agent/install/`、`~/.pi/agent/bin/pi` 与 `~/.local/bin/pi` |
| 清旧版本 | 删 `versions/` 里不是当前的那些 | — | — | 删 `releases/` 里不是当前的那些 |

- 官方脚本从各家的地址取到临时目录再运行，日志里记下地址和脚本的 SHA-256；运行时不带 `sudo`，不在终端里弹问题（各家的非交互开关）。
- 装完、更新完都跑一次 `--version` 确认，再重新扫描这一页。更新 Beta 时新版本确认能跑之后才删旧的。
- **删除先警告**：对话框写明删的是哪个版本、哪些路径、多大，以及“登录、配置和会话记录不受影响”；删 Stable 另写“命令行里的 `claude` 将不可用”；正被 AgentSwitch 选用的那一行写“删除后改用 …”。有终端或任务正在用那个程序时不让删，写出是谁在用。ChatGPT App 那一行没有删除。
- 删除只认这几处：版本库之内；§1 表里各家的程序目录；`~/.local/bin` 里指向这些目录的链接和带记号的 `*-beta` 脚本。路径先解析成真实路径再比对，目录本身是符号链接的不删。`~/.claude`、`~/.codex` 的其余部分、`~/.pi/agent` 的其余部分、`~/.local/share/opencode` 永远不碰。

## 6. 不留垃圾

- `downloads/`：每个任务一个文件夹，成功、失败、取消都删掉；应用启动时把里面剩下的全部删掉。
- Beta 每个 agent 只有一个版本。Pinned 只有你装的那些，每行写出大小。页面底部写版本库的总大小。
- 各家自己攒下的旧版本（Claude Code 的 `versions/`、pi 的 `releases/`）在 Stable 行下面单列一行：几个、多大、`Clean Up…`。
- 官方脚本的临时副本用完即删；每个 agent 的操作日志只留最近一次。
- 探测结果是一个小文件，覆盖写。

## 7. 安全

- **来源固定**：只连 §1 表里的主机（`downloads.claude.ai`、`releases.openai.com`、`api.github.com` 与 GitHub 的发布文件、`registry.npmjs.org`、`opencode.ai`、`pi.dev`、`chatgpt.com`），全部 HTTPS；重定向只允许落在各家的发布主机上。
- **先校验后使用**：放进版本库的每个文件先按官方校验值核对；清单里的版本号、平台名、文件名按固定格式检查后才拼进地址和路径；解包拒绝带 `..` 和绝对路径的条目。
- **安装和删除只在这台 Mac 上点**：这些操作不经服务，手机和网页上没有入口（手机上以后只显示“有更新”）。
- **不提权**：不用 `sudo`，不装系统级的东西。
- **凭据不相干**：这一页不读任何登录文件；“是否登录”仍是环境检查里原来那套只看存在与否的检查。
- 版本库和各家的安装一样是用户自己的文件；执行器能不能改它，和它能不能改 `~/.local/bin/claude` 是同一个问题，不在本文解决。

## 8. 界面

设置窗口侧栏新的一页 `Agents`（在 `Environment` 上面）。系统表单保持原生，短词按 ui-v0 §7.2.7，说明是正式中文。

- 顶上一行：上次检查的时间、`Check Now`；有更新时 `N Updates`。
- 每个 agent 一组：标题是它的标记和名字；下面每行一个安装——单选标记（AgentSwitch 用哪个）、来源（`Stable` `Beta` `Pinned` `ChatGPT App` `Other`）、版本、命令名或位置、大小，右边是这一行的按钮（`Update → 2.1.292`、`Delete…`）。没装的来源是一行淡色的 `Not Installed` 加 `Install`。组尾 `Install Version…`。
- 进行中的操作占住那一行：进度条和一句话（“下载 112 / 233 MB”“校验”“安装”），`Cancel`。失败时那一行下面一句原因，`Show Log`。
- 没装任何一个 agent 时，环境检查清单和首次运行向导里的那几项从“安装：curl …”变成 `Install` 按钮，点了跳到这一页并开始装 Stable。
- 改了选用的版本：页面顶上出一条“重启服务后生效”和 `Restart Service`。
- 页面底部：版本库的位置与总大小；`*-beta` 命令所在的目录不在 PATH 里时的那一行提示。

## 9. 落在哪里、分几步

**在 Mac 应用里做，不在服务里做**：下载要走系统的网络设置，安装和删除只该在这台 Mac 上点，选择在启动服务时生效——这几件都是应用已经在做的事（环境检查、把 `claude` 和 `opencode` 的路径交给服务）。服务只多认两个环境变量。Linux 纯服务端主机（mesh-v0）没有这一页，照旧自己装。

- `AgentSwitchMacCore/Agents/`：四家的发布信息怎么取、怎么读（纯函数，带测试）；扫描本机的安装；版本库与启动脚本；每个操作的步骤；删除的路径检查。
- `AgentSwitchMac/AgentsView.swift`：这一页。
- 服务：`CODEX_BIN`、`PI_BIN`。

1. **看得见**：扫描四个 agent 的所有安装（含 pi 与 ChatGPT App 的 Codex）、探测更新、这一页列出来、选 AgentSwitch 用哪个。不装不删。
2. **Beta 与 Pinned**：版本库、下载校验、`*-beta`、删除。
3. **Stable 的安装、更新、卸载与清旧版本**。
4. 环境检查清单、首次运行向导接上 `Install`；手机设置里显示“有更新”。

## 10. 没定的

- Claude Code 的原位安装要不要在这里切通道（改它自己的 `autoUpdatesChannel`）。现在只显示。
- pi 的 Pinned：要在版本库里装一组 npm 包，等它的发布方式稳定再说。
- 版本库里的程序要不要对执行器只读（同受保护路径一类的事）。
