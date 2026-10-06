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
| OpenCode | v2：npm `@opencode/cli-<平台>` 的 `latest`（2.0.24），`opencode.ai/update/api/latest/cli/npm` 给出当前版本 | 同一个包的 `beta`（`0.0.0-beta-19507`）、`dev` | `~/.opencode/bin/opencode`（单个可执行文件），旁边一个三行的 `opencode2`（启动同一个程序） | `opencode upgrade [版本] [--method curl]` | npm 的 `dist.integrity`（SHA-512） |
| pi | npm `@earendil-works/pi-coding-agent` 的 `latest`（1.0.4），`pi.dev/api/latest-version` | 没有 | `~/.pi/agent/install/releases/<版本>/`（一组 npm 包，需要 Node.js ≥ 22.19），`current-version` 记当前版本，启动脚本是 `~/.pi/agent/bin/pi`；**命令放在哪由它的安装脚本看 PATH 决定**（见下） | `pi update self` | 发布清单里每个包的 `integrity` |

几件要紧的事：

- **OpenCode 只认 v2 这条线**。GitHub 上标为最新的是 v1（1.18.x），而 AgentSwitch 的 OpenCode 集成按 v2 写（`session_v2`、`serve` 的接口、`session delete`）。找到的 v1 只列出来、标明不支持，不提供安装和更新。
- **Claude Code 的两个通道**：`latest` 是它默认跟的通道，`stable` 大约晚一周、跳过出过问题的版本。它没有公开的预发布，这里把 `stable` 当正式版、`latest` 当测试版。原位安装跟哪个通道是 Claude Code 自己的设置（`autoUpdatesChannel`），AgentSwitch 显示它、不替你改；所以原位安装的版本可能比 `stable` 新，这时不算“有更新”。
- **各家自带的更新**：原位安装的照常工作（这正是“不影响原有的使用”）。版本库里的副本由 AgentSwitch 启动或经 `*-beta` 启动时关掉它们的自更新（Claude Code `DISABLE_AUTOUPDATER=1`，OpenCode `OPENCODE_DISABLE_AUTOUPDATE=1`），否则一个测试版会在后台把原位的正式版换掉。
- **pi 的命令不在固定位置**。它的安装脚本在 PATH 里找第一个可写的 `~/.local/bin`、`~/bin`、`~/.bin`、`~/local/bin`，没有就用 Homebrew 的 bin（`/opt/homebrew/bin`），在那里放一个指向 `~/.pi/agent/bin/pi` 的链接；都没有时命令就是 `~/.pi/agent/bin/pi` 本身。放在哪记在 `~/.pi/agent/install/managed-install.json` 的 `entrypoint.path` 里。所以认 pi 的原位安装看的是启动脚本和这个记号，不是某个固定的命令路径；记号指向的东西不是那个启动脚本时不信它。其余三家的命令位置是固定的。
- **各家安装脚本对 PATH 的做法不同**（命令所在的目录不在 PATH 里时）：Codex 的脚本往 shell 配置里加一段带记号的 `export PATH=…`（当日实测写进了 `.zprofile`）；OpenCode 的脚本往已有的 `.zshrc` 等文件里加一行（有 `--no-modify-path`）；Claude Code 只打印一句提示；pi 没有终端时不改。
- **OpenCode 的更新要指明安装方式**：`~/.opencode/bin` 不在 PATH 里时 `opencode upgrade <版本>` 认不出自己是怎么装的（“Could not detect the installation method”），加 `--method curl` 就是官方脚本那一种。
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
- 版本库里每个版本的文件夹里有一个启动脚本 `launch`：几行 shell，设好关掉自更新的变量，`exec` 这个版本的程序。AgentSwitch 选用版本库里的版本时运行的就是它。`*-beta` 是 `~/.local/bin/` 里指向当前测试版 `launch` 的符号链接；AgentSwitch 只改写、只删除指向版本库的链接，同名的东西不是它放的就不动，并在界面上写 `Not on the Command Line`。`~/.local/bin` 不在登录 shell 的 PATH 里时，界面写出要加的那一行，AgentSwitch 自己不改 shell 配置。
- Pinned 是“给 AgentSwitch 用的某个确定版本”：某个新版本出问题时退回去用，或固定在验证过的版本上。它不上命令行。pi 的程序是一组 npm 包，暂不做 Beta 与 Pinned（它也没有测试通道）；要换版本就把原位安装换成那个版本（官方脚本的 `?version=`）。

## 3. AgentSwitch 用哪一个

- 每个 agent 选一行（单选）。默认：有 Stable 用 Stable；Codex 没有 Stable 时用 ChatGPT App 那份；都没有就是没装。
- 选择记在应用的设置里；应用启动服务时把四个路径交给它（`CLAUDE_BIN`、`CODEX_BIN`、`OPENCODE_BIN`、`PI_BIN`，后两个是新加的；Codex 原来写死在模型目录文件里，现在环境变量优先）。**改选择要重启服务才生效**：界面上写“重启服务后生效”，有任务在跑时先问；已经开着的终端继续用它启动时的那个程序。
- 选了版本库里的版本时，交给服务的是那个版本的启动脚本（同 `*-beta`，关掉自更新），所以服务不需要知道这些变量。
- 选中的那一行被删掉、或它的程序不见了：退回默认，并在这一页和环境检查里标出来。
- **低于验证过的版本时提醒**：每个 agent 记一个 AgentSwitch 验证过的最低版本（Codex 0.158、OpenCode 2.0.18、Claude Code 2.1.280、pi 0.87）。选更旧的不拦，只在那一行写“低于 AgentSwitch 验证过的版本”。

## 4. 更新探测

- 应用问各家的发布地址（§1 表里的那些）：应用启动时、打开这一页时、点 `Check Now` 时，以及应用运行期间上次的结果满 12 小时时（每小时看一眼，结果还新就谁也不问）。某一家上次没答复的，满 1 小时就再问。结果连同时间记在应用的数据目录里，下次打开先显示上次的结果。
- 一行“有更新”的条件：它跟的通道有比它新的版本。Stable 行按正式版比（Claude Code 的原位安装按它自己跟的通道比）；Beta 行按测试版比；Pinned 和 ChatGPT App 不比。
- 有更新时：这一页的那一行出 `Update → 版本`；设置侧栏的 `Agents` 带数字；环境检查清单多一行 `Agents  2 Updates  [ Show ]`（不算未完成：更新与否由你定）。**不自动安装**，只提示。
- 探测只读发布信息，不带任何本机信息；GitHub 的匿名接口每小时 60 次，12 小时一次绰绰有余，失败就保留上次的结果并标出时间。

## 5. 操作

每个操作是一个任务：有进度（下载的字节数）、有日志、能取消（下载阶段；各家的安装程序一旦开始运行就让它跑完）、同一个 agent 同时只做一个。失败不留半成品。

| 操作 | Claude Code | Codex | OpenCode | pi |
|---|---|---|---|---|
| 装 Stable | 下载 `stable` 那个版本的程序、校验摘要与签名，然后运行它的 `install stable`（官方脚本就是这么做的） | 运行官方安装脚本（`CODEX_NON_INTERACTIVE=1`） | 运行官方 v2 安装脚本，`--version <版本>` | 运行官方安装脚本（需要 Node.js ≥ 22.19，没有就说明并停下，不替你装 Node；脚本没有终端时本来也不装） |
| 更新 Stable | `claude update` | `codex update` | `opencode upgrade <版本> --method curl` | `pi update self` |
| 装 / 更新 Beta | 下载 `latest` 的程序、校验，放进版本库 | 下载最新预发布的 `codex-package`、校验、解包进版本库 | 下载 `beta` 的 npm 包、校验、取出程序 | — |
| 装 Pinned | 同上，指定版本 | 同上，指定版本（正式或预发布） | 同上，指定版本（v2） | — |
| 删 Stable（卸载） | 删 `~/.local/share/claude/` 与 `~/.local/bin/claude` | 删 `~/.codex/packages/standalone/` 与 `~/.local/bin/codex`、`codex-code-mode-host` | 删 `~/.opencode/bin/opencode` 和脚本放的那个 `opencode2`；`bin/`、`~/.opencode/` 空了就一并删 | 同它自己安装脚本的卸载：删命令的链接（在哪看它的记号）、`~/.pi/agent/bin/pi`、`~/.pi/agent/install/`；`bin/` 里它的工具下载的 `fd`、`rg` 留着 |
| 清旧版本 | 删 `versions/` 里不是当前的那些 | — | — | 删 `releases/` 里不是当前的那些 |

- 官方脚本从各家的地址取到临时目录再运行，日志里记下地址和脚本的 SHA-256；运行时不带 `sudo`，不在终端里弹问题（各家的非交互开关）。取到的东西不是脚本（比如一页拦截页）就不运行。
- **安装程序拿到的是你的终端里的 PATH**（登录 shell 自己报的那个，不是应用给服务补过目录的那个），其余只有 `HOME`、`USER`、`SHELL`、`LANG` 这几样：所以它做的事和你在终端里亲手运行它完全一样，包括 §1 说的——命令所在的目录不在 PATH 里时，Codex 与 OpenCode 的脚本会往你的 shell 配置里加它那一行。这是“装出来和自己装的一模一样”和“装完在命令行里直接能用”的一部分；AgentSwitch 自己不写 shell 配置。装完后重新问一次登录 shell 的 PATH；仍有命令所在的目录不在 PATH 里的（Claude Code 和 pi 不改配置），页面底部写出要加的那一行。
- 每个 agent 一份操作日志 `~/Library/Logs/AgentSwitch/agent-<agent>.log`，下一次操作覆盖它：取了什么地址、脚本的摘要、运行了什么命令（环境变量只记名字）、输出的末尾 80 行（去掉颜色和转圈）、怎么结束的。
- 装完、更新完都跑一次 `--version` 确认，再重新扫描这一页。更新 Beta 时新版本确认能跑之后才删旧的。
- **删除先警告**：对话框写明删的是哪个版本、哪些路径、多大，以及“登录、配置和会话记录不受影响”；删 Stable 另写“命令行里的 `claude` 将不可用”；正被 AgentSwitch 选用的那一行写“删除后改用 …”。那个程序正在运行时不让删，写明请先关闭使用它的终端或任务。ChatGPT App 那一行没有删除。
- **“正在运行”怎么认**：看每个进程的程序的真实路径（内核记的那个，链接已解开——从 `~/.local/bin/claude` 启动的进程，程序是 `~/.local/share/claude/versions/2.1.291`），再看命令行（pi 是 `node` 运行的脚本，路径在参数里）。按整段路径比，`2.1.28` 不是 `2.1.288`。
- 删之前再看一次：那个命令还是当初问的那个安装（期间变成了别的东西就不动，说“安装已有变化”）。
- 删除只认这几处：版本库之内；§1 表里各家的程序目录；`~/.local/bin` 里指向这些目录的链接和带记号的 `*-beta` 脚本。路径先解析成真实路径再比对，目录本身是符号链接的不删。`~/.claude`、`~/.codex` 的其余部分、`~/.pi/agent` 的其余部分、`~/.local/share/opencode` 永远不碰。

## 6. 不留垃圾

- `downloads/`：每个任务一个文件夹，成功、失败、取消都删掉；应用启动时把里面剩下的全部删掉。
- 版本库里空了的文件夹不留：没有测试版、没有指定版本、没有进行中的下载时，磁盘上就没有版本库（`rmdir`，里面刚放进东西的不会被删）。
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
- 进行中的操作占住那一行：进度条和它在做什么（`Downloading 112 / 233 MB`、`Verifying`、`Unpacking`、`Checking`、`Installing`、`Updating`、`Removing`），`Cancel`（过了下载阶段是灰的）。失败时那一行写原因，`Show Log` 打开这个 agent 的操作日志，`OK` 收起；失败只占住它自己那一行，这个 agent 的其他按钮照常可用。
- 环境检查清单和首次运行向导里没装的那几项（Claude Code、Codex、OpenCode），原来是一行安装命令加 `Copy Command`，现在是 `Install`：点了跳到这一页并开始装它的 Stable（通道还没读到时安装自己先问）。安装期间那一行写 `Installing`、不算未完成；没装成时那一行下面写原因，仍可再点。装好后环境检查自动重测，那一行变成 `Signed Out` 和 `Sign In`——登录仍在终端里由你完成。
- 改了选用的版本：页面顶上出一条“重启服务后生效”和 `Restart Service`。
- 页面底部：版本库的位置与总大小；命令（各家的和 `*-beta`）所在的目录不在登录 shell 的 PATH 里时，每个目录一句：哪些命令还不能直接用、要加的那一行。登录 shell 问不到时不写。

## 9. 落在哪里、分几步

**在 Mac 应用里做，不在服务里做**：下载要走系统的网络设置，安装和删除只该在这台 Mac 上点，选择在启动服务时生效——这几件都是应用已经在做的事（环境检查、把 `claude` 和 `opencode` 的路径交给服务）。服务只多认两个环境变量。Linux 纯服务端主机（mesh-v0）没有这一页，照旧自己装。

- `AgentSwitchMacCore/Agents/`：四家的发布信息怎么取、怎么读（纯函数，带测试）；扫描本机的安装；版本库与启动脚本；每个操作的步骤；删除的路径检查。
- `AgentSwitchMac/AgentsView.swift`：这一页。
- 服务：`CODEX_BIN`、`PI_BIN`。

1. **看得见**：扫描四个 agent 的所有安装（含 pi 与 ChatGPT App 的 Codex）、探测更新、这一页列出来、选 AgentSwitch 用哪个。不装不删。**已做**（2026-10-06）：`AgentSwitchMacCore/Agents/`（`AgentCLI` 与版本比较、`AgentInventory` 扫描、`AgentReleases` 发布信息与 `AgentUpdates`、`AgentSelection`、`AgentText` 与行的顺序；`AgentsTests`，`AGENTSWITCH_AGENTS_LIVE=1 swift test --filter AgentsTests/testLive` 扫描本机并真去问四家），`AgentsView`，服务认 `CODEX_BIN` 与 `PI_BIN`（`tests/agentBinaries.test.ts`）。这一步里有更新的行只写 `版本 Available`、没装的行只写通道的最新版本，按钮随后两步加上。`-designPreview <目录> -designPreviewOnly agents` 出这一页的三种状态。
2. **Beta 与 Pinned**：版本库、下载校验、`*-beta`、删除。**已做**（2026-10-06）：`AgentArtifacts`（一个版本是哪个文件、该是什么摘要）、`AgentTransfer`（下载，重定向只跟到名单上的主机）、`AgentStore`（下载 → 核对大小与摘要 → 解包（拒绝出界的条目和链接）→ 核对签名的开发者团队与 `--version` → 写启动脚本、整个文件夹挪到位 → `*-beta` 改指、旧测试版删掉；删除；启动时清扫）、`AgentJob`（行上的进度、可否取消）。`AgentStoreTests` 用假的发布方走完全部路径；`AGENTSWITCH_AGENTS_LIVE=store swift test --filter AgentStoreTests/testLiveStore` 在临时目录里真下载三家的测试版（当日 754 MB，全部通过摘要、签名、版本三道检查并能运行）。
3. **Stable 的安装、更新、卸载与清旧版本**。**已做**（2026-10-06）：`AgentNative`（运行各家自己的安装程序与更新命令；卸载与清旧版本只删 §5 表里的那几处）、`AgentLog`、页面上的 `Install` `Update →` `Delete…` `Clean Up…` `Show Log` 与三个确认对话框。`AgentNativeTests` 用几行 shell 充当各家的安装程序，放的文件与实测的布局一致；`AGENTSWITCH_AGENTS_LIVE=native swift test --filter AgentNativeTests/testLiveNative` 在临时目录里用四家真的安装程序走一遍 安装 → 它自己的更新 → 卸载（当日全部通过；装齐 936 MB，卸载后剩 33 MB，是各家自己的配置与缓存）。这一遍测出了 §1 里新写的三件事（pi 的命令位置、OpenCode 的 `--method curl`、各家对 PATH 的做法）。
4. 环境检查清单、首次运行向导接上 `Install`；手机设置里显示“有更新”。**Mac 这一半已做**（2026-10-06）：`SetupAction.installAgent` / `.showAgents`、清单的 `Installing` 与失败原因、`Agents  N Updates` 一行、启动时与满 12 小时的自动探测（`AgentReleaseInfo.isDue`）。**手机上显示“有更新”没做**：要先让服务知道这台 Mac 上装了什么、各家出了什么（现在只有应用知道），是另一件跨服务与 iPhone 的事。

## 10. 没定的

- Claude Code 的原位安装要不要在这里切通道（改它自己的 `autoUpdatesChannel`）。现在只显示。注意它自己的 `install stable` 会把这个设置写成 `stable`：在这里装的 Stable 跟 `stable` 通道。
- 卸载后各家留下的缓存（`~/.npm`、`~/.cache` 里它们的东西）不清：那和手动卸载一样，也不是越积越多的东西。
- pi 的 Pinned：要在版本库里装一组 npm 包，等它的发布方式稳定再说。
- 版本库里的程序要不要对执行器只读（同受保护路径一类的事）。
