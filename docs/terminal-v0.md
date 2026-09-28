# terminal-v0：手动入口——AgentSwitch 自己的终端会话

2026-09-28 用户要求：在 Mac 和手机上统一管理 agent 的终端会话——看有哪些、回话、删除，权限请求直接点。决定做**两个入口**：

- **托管**：现在的对话框。说一句话，调度模型选执行器和模型、派活、验收（assistant-v0、loop-v0）。
- **手动**：你自己选 agent 和目录开终端会话，自己盯、自己回、自己批。模型还做不到完全托管，需要人直接上手的时候用这个。

两个入口并列，互不代替；本文只讲手动入口。本文是草案。

> 2026-09-28 演示已实现：服务端（§2–§4，`packages/daemon/src/terminals/`、`src/api/terminals.ts`）和网页演示页（控制台 › 终端，`ui/terminal.html`）。用真 Claude Code（Haiku）验证过：新建、信任对话框用按键条作答、网页上点“允许”后终端显示 “Allowed by PermissionRequest hook”、在终端里直接作答后卡片自动撤掉、`--resume` 续接后记得上一轮；Codex 能在终端里启动。Mac 窗口和 iPhone 页面未做。

## 0. 原则

- **终端进程归服务所有**：daemon 启动并持有每个会话的伪终端（像 tmux 的服务端），Mac 和手机都只是显示端。关掉窗口、手机断线，会话照跑；任一端连上都看到当前屏幕。
- **不做终端模拟器内核**：显示用 SwiftTerm（macOS 与 iOS 同一套），服务端用 `node-pty` 起进程、`@xterm/headless` 维护屏幕与回滚。
- **只能开 agent，不能开 shell**：可启动的程序限定为 `claude`、`codex`、`opencode`、`pi`（及它们的参数），手机上没有“开一个终端”这种能力。
- **会话同样在凭据网关后面**：环境与托管执行器相同（代理、CA、secret-gate MCP、禁区），所以密文在手动会话里也能用；回话先过 sealer（或本地前台，local-model-v0）。
- **权限请求直接给你**：手动入口里不经调度模型代批；按钮来自 agent 的 hook，不靠识别屏幕。

## 1. 界面

用词：界面上叫“终端”（“会话”已经是 thread 的叫法，ui-v0 §4）。

**iPhone**：底部两个标签页 **托管** · **终端**。

- 托管：现在的首页，不变。
- 终端：列表 = AgentSwitch 持有的终端（等你处理的在最前，状态点：进行中 / 等你 / 空闲 / 已结束）+ 一组“Mac 上的其他会话”（现在「设置 › 编码会话」的只读列表搬到这里）。右上角“新建”：选执行器（Claude Code / Codex / OpenCode / pi）、目录（最近用过的目录 + 默认工作目录 + 手动输入）、模型（可选，默认用该执行器自己的默认）。
- 终端页：SwiftTerm 实时显示（可滚动回看、可缩放）；底部回话框（多行，发送 = 粘贴进去再回车）；常用按键条（Esc、Tab、↑↓、Ctrl-C、回车）；有权限请求时上方出现卡片：请求原文 + 允许 / 拒绝（Claude Code 另有“本会话都允许”）。
- 提醒复用托管那一套：等你处理时提示音、实时活动一并显示终端的待处理项。
- 「设置 › 编码会话」移除（内容在终端标签页里）。

**Mac**：菜单栏面板不变，加“打开终端窗口”。窗口左侧列表（同手机），右侧 SwiftTerm，完整键盘；标签页可拖出成独立窗口。

> 2026-09-28 第二轮（用户：点“继续”没反应、没反馈；“终端”标题和状态栏的“Claude Code · 默认模型”没用；窗口拖不动；新建不用选模型；按项目文件夹分类；接管会不会影响 iTerm 里的会话）：
> - **侧栏按项目文件夹分组**：每个文件夹下先列正在运行的终端，再列这个项目以前的会话（多于 3 个折叠成“还有 N 个会话”）；有终端的文件夹排前面，其余按最近活动。组标题可折叠，悬停出现“＋”在这个文件夹里新建。同名文件夹带上一级目录区分。顶部只有一行“新建终端 ⌘T”，不再有“终端”“最近会话”这类标题；状态栏只留操作图标。
> - **续接有反馈**：点下去立刻显示“正在打开「…」”，直到 agent 画出第一屏；终端名字先沿用原会话的标题。页面不用浏览器的 `confirm`/`alert`（Mac 窗口不显示它们，上一版的“继续”因此在会话仍活动时静默取消了），确认和报错都是页面内的对话框和提示条。
> - **窗口可以拖动**：页面顶部 30px 的标题带上盖一条原生的拖动条（`DragStrip`），拖动交给窗口，双击按系统设置缩放或最小化；标题带里不放任何按钮。
> - **链接**（用户：终端里的链接点不了，iTerm 里可以）：和 iTerm 一样 ⌘+点击打开，普通网址和 agent 状态栏里的 OSC 8 链接都认。Mac 窗口里网页链接交给默认浏览器；`file://` 链接只在访达里选中显示，不打开（链接来自 agent 的输出，打开文件可能会运行它）；其他协议不处理。xterm.js 默认用 `confirm()` 问要不要打开，Mac 窗口不显示它，所以原来点了没反应。
> - 终端区裁掉溢出：终端尺寸比窗口大时（在别的窗口或手机上开的），多出的行曾溢到新建面板下面；现在连上后先按快照原尺寸画，再按本窗口重新适配并通知服务。
> - 第六轮（用户：描述 AI 味重，应当正式或统一成简洁英文；新建时要能选模型；同一父目录的分组合并）：
>   - 文案按 ui-v0 §4.1 改成书面语：删除细栏里的说明句（移到悬停提示）；“还开在…里 / 接着写 / 岔开 / 原来的不动”等改为“正在…中运行 / 写入 / 分叉 / 原会话保持不变”。界面短词用中文还是英文待定（演示页可切换对比）。
>   - **同一父目录的项目合并**：侧栏按文件夹分组时，同一父目录下有两个及以上项目的，收在父目录下（`Worktop/` › `Codex`、`Claude`），父目录一行更淡、可折叠；父目录下只有一个项目的仍以项目名单列，重名的顶层项附上一级目录区分。⌘1–9 按侧栏里显示的顺序对应终端。
>   - **新建时选模型**（推翻第二轮的“新建不选模型”）：agent 下面一个下拉框，第一项“默认”（不传 `--model`，由 agent 自己的设置决定），其后是所选 agent 在目录里的全部可选模型，显示为人名（Opus 5.5、GPT-6 Astra），按 agent 记住上次的选择。模型来自 `GET /terminals` 的 `models`（`targets.yaml` 经发现后的目录，与“模型”设置同源；`/settings/models` 只对本机开放，手机取不到）。模型 id 服务端校验，不能以 `-` 开头（它作为 `--model` 的参数原样交给 agent，不能被读成别的开关）。
> - 第五轮（用户：加密发送要留一个入口；“继续”要像 Codex 的 CLI 和桌面版那样保证会话唯一）：“继续”改为接着写原会话、同一时刻只让一个程序写，见 §5。加密发送先放在侧栏底部，用户看过后要放在**每个终端的下方**：终端下面一条细栏（锁 + “加密发送” + 说明 + ⌘⇧V），点它或按 ⌘⇧V 原地展开成输入框，发送或 Esc 后收回；占终端一行，换来入口就在输入处旁边。
> - 顶边（用户：上面空出来这一坨是干什么的）：它是 Mac 窗口的拖动区（透明标题栏下，原生 `DragStrip` 盖在上面），不能放按钮、不能让终端顶上去（否则终端前两行点不到、选不了字）。原来画了一条分隔线，看上去像一条空栏；去掉线、和终端同底色，读作终端的上边距。
> - 第四轮（用户：这些状态和描述是否必要；行上的关闭和右下角的关闭有什么区别；链接依旧打不开；Codex 一堆重复；Codex 的“进行中”不对）：
>   - **去掉重复的信息**：顶部标题带在 Mac 上只作可拖动的顶边，不再写名字、路径、状态（侧栏选中行和组标题已经有了）；底部状态栏去掉（它的关闭和行上的 × 是同一个动作）；终端行只有“等你处理”“已结束”才出第二行；不再标“跳过权限”（agent 自己的状态栏写着）。改名（双击名字）、加密发送（⌘⇧V）、关闭（× / ⌘W）也都在右键菜单里。窄屏仍在标题带显示名字和状态。
>   - **链接**：终端库能打开 OSC 8 链接，打不开是因为屏幕快照（序列化）不保留链接，而 agent 的状态栏不会自己重画。现在屏幕连上终端后，尺寸没变也请服务“重画”一次（`POST /terminals/:id/redraw`：伪终端少一行再恢复，程序收到尺寸变化会重画，和 tmux 重新连接时一样）。文件夹链接在访达里打开，文件链接只在访达里选中。
>   - **Codex 的重复**是 Codex 桌面版在一个对话里派出的子 agent（记录里 `thread_source: subagent`，每个都复制了主对话的第一句话），现在不列出；“进行中”那条是 AgentSwitch 里 Codex 终端自己在写的分叉记录（Codex 没有 hook，服务不知道它属于哪个终端），现在按 `forked_from_id` 和“同目录、终端开着时新建”（Codex 的 id 是 UUIDv7，带时间）归到终端下，不单列；`notify` 回报的 `thread-id` 也记成终端的会话 id。
> - **关闭**（用户：怎么关掉终端；多出来的点结束还是删除）：“结束”和“删除”合成一个“关闭”——结束程序并从列表移除，agent 自己的会话记录保留、之后可以继续；已结束的直接移除，还在运行的先确认（可勾选同时删除会话记录）。入口：侧栏终端行悬停出现 ×、⌘W（关当前终端，不关窗口）、状态栏的 ×。`POST /terminals/:id/kill` 仍在，给手机和脚本用。
> - **新建不选模型**：用各 agent 自己的默认模型；新建面板只有 agent 和文件夹，未装的 agent 置灰。
>
> 2026-09-28 重做（用户：按键条和回话框放在电脑上太笨；字体不如 iTerm；侧栏和标题不一体；窗口里不该出现控制台首页；终端名字要好听）：
> - **一整块深色**：终端用用户 iTerm2 默认配置的字体、字号、行距和配色（有深浅两套时取深色；`GET /terminals/style`，读不到 iTerm 时用内置的一套）；侧栏和上下两条栏用同一底色略微提亮。Mac 窗口标题栏透明、页面铺到顶：红绿灯落在侧栏上，顶部标题带和红绿灯齐平，只放名字、路径和状态，不放按钮。终端用 DOM 渲染（字形交给 macOS 画，和 iTerm 一致；WebGL 在 Retina 上把字画成了两倍大）。
> - **电脑上没有按键条和回话框**：键盘直接进终端。加密发送（回话过 sealer）是底部状态栏的锁或 ⌘⇧V，弹出浮动输入框（第五轮改为终端下方的一条细栏，原地展开）。按键条和常驻输入框只在窄屏（手机）出现。
> - **权限请求**是右上角的浮动卡片（不挤压终端）：写成人话（创建文件、修改文件、运行命令），路径相对终端目录；⌘↩ 允许，⌘⌫ 拒绝。
> - **名字**：用户起的名字 > agent 给的有意义标题（去掉 ✳ 这类状态符号；agent 自己的名字、`user@host:` 不算）> 文件夹名。双击侧栏里的名字或点状态栏的笔改名（`PATCH /terminals/:id {name}`，空名字恢复自动命名）。
> - **侧栏**分“终端”和“最近会话”：状态点 + 名字 + agent 小标签 + “时间 · 文件夹”；“继续”在鼠标悬停时出现。新建是居中面板：四个 agent（未安装的置灰，`GET /terminals` 带 `agents`）、文件夹（Mac 上可用系统的“选择…”面板）、模型。
> - **窗口里只有终端页**：Mac 窗口拦下其他页面，也不显示“控制台”入口；标题跟随当前终端（调度中心、窗口菜单）。快捷键 ⌘T 新建、⌘1–9 切换。
>
> 2026-09-28 v0：菜单栏「打开终端」开一个原生窗口（`TerminalWindow.swift`），里面是服务的终端页（网页控制台同一页），用一次性控制台链接登录并直接落到这一页（`POST /local/console-link?next=/ui/terminal.html`，`next` 只收 `/ui` 下的页面，不收 `.`、`..` 段）；网页数据只存在这个窗口里，关窗即丢，下次重新登录。菜单栏应用没有“编辑”菜单，⌘C/⌘V/⌘X/⌘A/⌘Z 由窗口自己转给页面。关窗不影响终端，服务照样持有它们。SwiftTerm 原生视图以后替换。

## 2. 会话宿主（daemon）

```
SessionHost
  spawn(harness, cwd, model?, resume?) → TerminalSession
  TerminalSession {id, harness, cwd, argv, pid, cols, rows, status, title,
                   agentSessionId?, createdAt, lastOutputAt, origin: "new"|"resumed"}
  write(id, bytes) · resize(id, cols, rows) · kill(id) · snapshot(id) · subscribe(id, afterSeq)
```

- `node-pty` 启动，工作目录按 control-v0 §2 的规则检查（不能是主目录、禁区）。环境 = 托管执行器的 gate 环境 + `AGENTSWITCH_TERMINAL_ID=<id>`（hook 靠它把事件对上会话）。
- `@xterm/headless` 维护屏幕，`@xterm/addon-serialize` 出快照；输出按序号切块保存在内存环形缓冲（默认 2 MB/会话），供断线续传。
- 输出只在转义序列之间切块：程序的一块输出可能停在一个序列中间，从快照接着画的屏幕会把序列后半截当文字显示（实测出现过 `27;2H`）。没写完的尾巴留到下一块一起发，50 毫秒内没有下一块就照发。
- 状态：
  - 进行中 / 等你 / 空闲来自 hook（§3）；没有 hook 的执行器按“最近 N 秒有输出”估计进行中，其余为空闲。
  - 已结束：进程退出，保留最后屏幕与退出码，直到你删除。
- 服务重启（含 Mac 应用换新版）时伪终端随之结束。v0 不保存终端列表，重启后列表为空；agent 自己的会话记录仍在，出现在会话列表里，可“继续”（§5）。（原计划标“已中断”，未实现。）Mac 的终端窗口在页面收到 401 或网页进程退出时自动重新登录。
- 打包：`node-pty` 是原生模块，Mac 应用的运行时要带 darwin-arm64 的预编译产物，`build-app.sh` 加检查。

## 3. hook：状态与权限

AgentSwitch 启动的会话，hook 通过**会话自己的配置**注入（命令行参数或会话专用的配置目录），**不改用户的全局配置**；用户在 iTerm 里自己开的 agent 不受影响。

| 执行器 | 状态 | 权限请求 | 注入方式 |
|---|---|---|---|
| Claude Code | `SessionStart`→空闲（并报会话 id），`PreToolUse`→进行中（并过禁区），`UserPromptSubmit`→进行中，`Notification`/`Stop`→等你/空闲，`PostToolUse`（撤掉在终端里答过的请求） | `PermissionRequest` hook 返回 `{"behavior":"allow"}` 或 `{"behavior":"deny","message":…}`（结构化，不按键） | `--settings <会话专用 settings.json>`，有 gate 时另加 `--mcp-config` |
| Codex | `notify`（一轮结束） | 终端界面里的确认：显示屏幕上的确认原文，按键作答 | `-c notify=…`、`-c default_permissions=…` 等命令行覆盖 |
| OpenCode | 按输出估计（2.x 的插件接口未核实，见下） | 终端界面里的确认，按键作答 | `--standalone` + `OPENCODE_CONFIG=<会话专用配置>`（只加禁区的拒绝规则） |
| pi | 扩展：`agent_start`→进行中，`agent_end`→空闲；`tool_call` 过禁区 | 无权限层 | `--extension <AgentSwitch 自带的扩展>` |

- hook 命令（`src/terminals/hookClient.ts`，用服务自己的 node 运行）只做一件事：把事件 POST 到本机 `/terminals/hook`，带 `AGENTSWITCH_TERMINAL_ID` 和**这个终端自己的 hook 令牌**（`AGENTSWITCH_TERMINAL_HOOK_TOKEN`）。**不能用本机令牌**：终端里的 agent 读得到自己的环境变量，拿到本机令牌就能调任何本机接口。hook 令牌只能给自己这个终端报事件、提权限请求，不能替自己作答；本机令牌检查对这一条路由放行，由路由自己核对 hook 令牌。权限请求的 hook 等服务回答（最长 30 分钟），没人回答就不给结论，agent 照常在终端里问。hook 命令出任何问题都静默退出，不影响 agent。
- 实测（Claude Code 2.1.283）：`PermissionRequest` hook 运行期间，终端里**同时**显示 Claude 自己的确认框，两边谁先答算谁的。在终端里答了，Claude 不会结束那个 hook，所以服务端靠随后的事件撤卡片：工具执行了（`PostToolUse`，按工具名和输入对上那一条）、这一轮结束（`Stop`）、用户又发了话（`UserPromptSubmit`）。
- 环境：去掉“当前是某个 Claude Code 会话”的标记（`CLAUDECODE`、`CLAUDE_CODE_CHILD_SESSION`、`CLAUDE_CODE_SESSION_*`、`CLAUDE_CODE_MESSAGING_*` 等）。服务从 Claude Code 里启动时（开发者这样跑过）会被新终端继承，Claude 会以为自己是子会话、不存会话记录，还会拿到上层会话的消息通道令牌。用户自己的设置（`ANTHROPIC_*`、`CLAUDE_CONFIG_DIR`）保留。
- **权限模式**（2026-09-28，用户：iTerm 里用 `claude --dangerously-skip-permissions`，AgentSwitch 的终端却回到了自动或逐项确认）：新建和“继续”时选“逐项确认 / 自动 / 跳过权限”，页面记住上次的选择，第一次跟随 Mac 的审批模式（control-v0 §1：manual→逐项确认，scoped/auto→自动，skip→跳过权限）。对应参数：Claude Code `--permission-mode manual|auto` 或 `--dangerously-skip-permissions`；Codex 逐项确认为 `-a on-request -s read-only`（2026-09-28 审计：原先不带参数，实际权限取决于用户的 `config.toml`，可能是从不询问），自动为 `-a on-request -s workspace-write`，跳过为 `--dangerously-bypass-approvals-and-sandbox`；OpenCode 自动和跳过都是 `--auto`；pi 没有这一层。跳过权限只能在 Mac 上选（手机请求 403，同审批模式里的 skip）；标题带上显示“跳过权限”。
- **继续沿用原会话的模式**（用户：点“继续”没地方选跳过权限，进去就是 auto）：会话列表从记录里读出每个会话最后用的模式（Claude Code 取最后一条 `permissionMode`；Codex 取最后一次的 `approval_policy` 与沙箱，`never` + `danger-full-access` 即跳过权限），“继续”就用它，读不出时才用记住的选择。归入三个词时只能收紧、不能放宽（2026-09-28 审计）：Claude Code 的 `acceptEdits`、`dontAsk`、`plan` 都比 auto 窄，一律按逐项确认继续；Codex 只读沙箱或记录里没有沙箱的，按逐项确认继续，可写沙箱才算自动。侧栏里跳过权限的会话和终端标“跳过权限”。在 Mac 上开的 Claude Code 终端另带 `--allow-dangerously-skip-permissions`，以别的模式启动后也能在终端里按 ⇧Tab 切到跳过权限（和 iTerm 一样；手机开的不带）。
- **不重复继续**：对已经在终端里打开（或已分叉出终端）的会话再点“继续”，直接切到那个终端（服务端同样：`/terminals/resume` 返回已开着的那个）。现在“继续”接着写原会话，不再每次多出一份记录；分叉只在用户选了“分叉一份”时发生（§5）。
- **禁区**（2026-09-28 审计后补齐；用户决定不另加系统沙箱，各用 agent 自己的机制）：
  - Claude Code：`PreToolUse` hook 把每次工具调用交给服务，按托管执行器同一套规则（`decideTool` + 禁区表）判断，碰到本机令牌、gate 密钥、浏览器会话目录等就拒绝，其余不给结论、交回 agent 自己的模式决定；任何模式下都在（实测跳过权限模式下让它读本机令牌，被这一层拒绝）。会话配置另带 `permissions.deny` 的 `Read`/`Edit` 规则，服务无响应（hook 放行）时仍挡直接读取。
  - Codex：用它自己的权限配置（`default_permissions` + `[permissions.agentswitch]`，逐项确认继承 `:read-only`、自动继承 `:workspace`），禁读目录设 `deny`、其余禁区设 `read`。由 Codex 的系统沙箱执行，换写法（`cd` 后用通配符、脚本）也读不到（实测，codex 0.158）；但只管沙箱里跑的命令：跳过权限模式没有沙箱，用户批准到沙箱外运行的命令也不受限。gate 代理与 CA 只经 `shell_environment_policy.set` 给它执行的命令，不放进 Codex 进程自己的环境（同托管执行器）。
  - OpenCode：会话专用配置里的 `permission` 拒绝规则（读按路径、bash 按命令文本、写与外部目录按路径），与托管执行器同一份禁区表；只加拒绝，不改用户其余的权限设置；`--auto` 下同样生效。终端里的 OpenCode 带 `--standalone`：2.x 默认把会话放进用户共用的后台服务（`opencode serve --service`）里跑，终端进程的环境（这份配置、gate 代理）到不了那里（2026-09-28 实测：私有服务的 agent 权限里有这些拒绝规则，后台服务里没有）。2.x 的插件接口未核实（1.x 的文件插件在 2.0.18 不加载），核实后可改用插件，顺带上报状态。
  - pi：没有权限层；AgentSwitch 自带扩展在 `tool_call` 时把工具与参数交给服务，按 `decideTool` 判断，拒绝即 `block`。扩展出错或服务无响应时拦截（pi 的约定：处理出错即拦截）。
  - 除 Codex 外都是按字符串比对工具参数，挡直接的读取，挡不住有意绕过（BOUNDARY.md）；同一系统账户下真正的隔离只有网关的独立账户。
- 各家 hook 名称与返回格式随版本变化：实现前逐家核实并在测试里固定样例；探测不到 hook 能力的版本退回“按键作答 + 屏幕原文”。
- 权限按钮的底线同托管：删除、推送、付款、禁区相关的请求在手机上二次确认；禁区照拒（执行器层直接拒，不出按钮）。

## 4. 接口

本机与远程同一组路由（远程只给配对设备，走现有 TLS + 钉指纹）：

- `GET /terminals` → `{terminals, agents, models}`：AgentSwitch 持有的终端（含 `name`、`customName`、`title`）、本机装了的 agent、每个 agent 可选的模型（`[{id, name}]`，新建时的模型菜单）；其他会话仍从 `GET /sessions` 取。
- `GET /terminals/style` → 屏幕的字体与配色（§1）。`PATCH /terminals/:id {name}` → 改名，`null` 或空串恢复自动命名。
- `POST /terminals {harness, cwd, model?}` → 新建；`POST /terminals/resume {harness, agentSessionId, cwd, fork?}` → 续接（§5）：接着写同一个会话；它已开在 AgentSwitch 的终端里时返回那个终端（200，`existing: true`）；开在别的程序里时 409 `{error, elsewhere: {app, pid}}`；`fork: true` 分叉一份。会话 id 与模型 id 一样不得以 `-` 开头（它跟在 `--resume` 后面，否则可被当成参数，例如借此绕过“跳过权限只能在 Mac 上选”）；agent 不支持的续接或分叉返回 400（pi 不能续接，OpenCode 不能分叉）。服务在启动进程前再查一次“已开在这里”，两个画面同时续接同一会话只得到一个终端。`cwd` 规范化后保存（`~/p/` 与 `~/p` 是同一个文件夹）。
- `GET /terminals/:id/stream?after=<seq>`（SSE）：先发快照 `{seq, cols, rows, data}`，再发输出块 `{seq, data}`（UTF-8 文本）、状态变化、权限请求；断线按 `after` 续传，缓冲外的旧序号直接给新快照。某个画面积压超过 5000 条未发出的事件时服务断开它，重连后从新快照开始。
- `POST /terminals/:id/input {text, submit?}`：回话，先过 sealer（发现凭据就换成密文再写入；本地前台可用时由它处理）。程序开了 bracketed paste 时整段粘贴再回车，多行回复不会被拆成几次发送。`POST /terminals/:id/keys {keys:["esc","ctrl-c",…]}`：控制键，不过 sealer；方向键跟随程序的光标键模式。
- `POST /terminals/:id/write {data}`：原始按键，给本机的完整键盘（网页、Mac 窗口），**不在手机可用的路由里**（手机只走 `/input` 和 `/keys`）。
- `POST /terminals/:id/resize {cols, rows}`：多个显示端同时连着时以最后一次交互的那一端为准。
- `POST /terminals/:id/permissions/:pid {decision: "allow"|"deny"}`。（`allow_session` 未实现。）
- `POST /terminals/:id/kill`：结束进程（SIGHUP，3 秒后 SIGKILL；发给整个进程组，agent 启动的子进程一并结束），终端留在列表里、保留最后的屏幕。
- `DELETE /terminals/:id`：结束进程并从列表移除；`DELETE /terminals/:id?transcript=1`：同时删除 agent 自己的会话记录文件（不可恢复，界面二次确认）。只删这个终端自己开出的会话：新终端或分叉的 agent 第一次报告的会话 id；之后在终端里 `/resume` 切过去的会话只跟随、不归它，关闭时不删（2026-09-28 审计：原先删的是最后报告的 id，会删掉别的会话）。等进程退出后再删，免得 agent 最后几次写入又把文件建出来。
- 审计：每次新建、续接、回话（只记长度和换成密文的个数，不记内容）、控制键、权限决定、结束、删除，一行一条记在 `$AGENTSWITCH_HOME/terminals/audit.jsonl`，带来源（`local` 或配对设备的 id）。本机原始按键不逐键记录。

## 5. Mac 上的其他会话

用户在 iTerm 等终端里自己开的 Claude Code / Codex / OpenCode 会话（control-v0 §3 已能读到）：

- 在终端标签页的“Mac 上的其他会话”里只读显示（最近消息、目录、时间），不能回话、不能批权限——进程不在 AgentSwitch 手里。
- “继续”：**接着写同一个会话**——Claude Code `claude --resume <id>`，Codex `codex resume <id>`，OpenCode `--session <id>`。记录只有一份，在这里聊过的，之后在 iTerm 里 `claude --resume`、在 Codex 桌面版里打开都看得到，反过来也一样（2026-09-28 第五轮改回，用户：要像 Codex 的 CLI 和桌面版那样保证会话唯一；上一版为了不碰 iTerm 里开着的原会话一律分叉，结果每点一次“继续”就多一份记录）。
- **同一时刻只让一个程序写**（2026-09-28 实测，Claude Code 2.1.283、codex 0.158）：
  - Codex 自己有写入锁：写一个对话的进程持有 `~/.codex/thread-writer-locks/<id>.lock`，第二个进程打开同一对话时显示“This conversation is open in another app”，可重试或分叉。桌面版也持有它载入的对话的锁。
  - Claude Code 没有锁：两个 `claude --resume <同一 id>` 同时开都不提示，两边各写各的，记录会岔开（记录是按 `parentUuid` 连的树，下次续接只沿其中一枝）。但每个运行中的 Claude 在 `~/.claude/sessions/<pid>.json` 登记 `sessionId`，退出时删掉。
  - 所以服务在续接前查这两处（登记的进程已不在、或 pid 已被别的程序占用的不算）：开着的是 AgentSwitch 自己的终端就直接给那个终端；开在别处则返回 409，带上是哪个程序（沿父进程往上找到的第一个 `.app` 的名字，如 iTerm2、ChatGPT），页面说明“先在那边退出再继续”，也可以选“分叉一份”（`fork: true`，即 `--fork-session` / `codex fork`：新会话带上完整历史，原会话不动）。OpenCode 查不到别处的进程，原会话还在活动时仍先确认。
  - 不是实时互见：两个在跑的进程各有自己的上下文，另一边写进记录的内容，要重新打开才看得到（所以才只让一个写）。真正实时共用只能是一个进程、多个画面——AgentSwitch 的 Mac 窗口和手机看的就是同一个终端；要让 iTerm 也接进同一个终端，需要 `agentswitch attach`（以后，同 tmux attach）。
- 已经在 AgentSwitch 里打开的会话不在列表里重复出现（`TerminalInfo.agentSessionId` / `resumedFrom`）。分叉出来的终端 `forked: true`。
- 删除会话记录（2026-09-28 改，用户：终端产生的副本删不掉）：侧栏里的会话行悬停出现 ×，确认后删掉 agent 自己保存的这段记录（Claude Code 的 `<project>/<id>.jsonl`、Codex 的 `rollout-…-<id>.jsonl`；OpenCode 存在数据库里，暂不支持），`DELETE /sessions/:harness/:id`。正在使用中（刚有活动）、开在终端里，或被别的程序持有（Claude 的会话登记、Codex 的写入锁）的会话不能删。删的是列表读到的那个文件；一个文件都没删到时返回 404，有文件删不掉时返回 500 并说明删了几个，不再笼统回成功。无论终端功能开没开，每次删除都记审计。已知未删：Codex 在对话里派生的子代理记录（带着对话历史的副本，列表里不显示）和 Claude 的 `<project>/<id>/` 子目录（子代理、工具结果）。原来只准删 AgentSwitch 建的记录，但分不清谁建的（旧版“继续”用普通 `--resume`，Claude 另存了一份副本，删除终端时没有算在内），而删除本来就是用户要的管理动作之一。
- “关闭”和“删除会话记录”是两件事：关闭结束进程、从终端列表移除，历史保留（同 iTerm 关标签页，`claude --resume` 里仍在）；删除会话记录是抹掉历史，无法恢复。关闭不默认删历史，需要时在关闭确认里勾选。只有记录是这个终端新建的（新建的会话、分叉）才给这个选项；接着写原会话的终端没有——关一个终端不该把原来的对话删掉，要删在会话列表里删（服务端同样拒绝）。

## 6. 与托管入口的关系

- 两个入口的数据分开：终端不进任务表、不经调度模型、不写战绩和 `MEMORY.md`。
- 托管里的调度模型仍能看到这些会话的目录元数据（control-v0 §3 那一节），作为项目背景。
- 托管的任务不能往终端里写字；手动入口也不会替你建任务。以后若要互通（把一个终端交给托管接手，或把托管任务开成终端），另行设计。

## 7. 安全边界

- 只能启动白名单里的 agent；参数由服务端拼，客户端只给执行器名、目录、模型、续接 id。
- 只有配对设备和本机能访问；手机的每一次回话、按键、权限决定都进审计。
- 回话过 sealer；终端输出流不入库，只在内存缓冲里，经 TLS 给自己的设备（同 control-v0 §3 的规则）。
- 会话有 gate 环境与禁区保护（各 agent 的做法与强度见 §3）；手动会话里 agent 的权限模式默认是“逐项问你”。

## 8. 分阶段

1. 会话宿主 + hook（Claude Code 先行）+ 接口 + 审计；单元测试用假 agent（一个会打印、会等输入、会发 hook 的小脚本），不打真模型。**已做**（附网页演示页）；测试 `tests/terminals.test.ts`。
2. Mac 终端窗口（SwiftTerm）。**v0 已做**：原生窗口里嵌终端页（见 §1），SwiftTerm 版待做。
3. iPhone 终端标签页：列表、实时终端、回话框、按键条、权限卡片、提醒。
4. Codex、OpenCode、pi 的 hook；“在 AgentSwitch 里继续”。

## 9. 待拍板

1. 手机底部两个标签页叫“托管”“终端”，还是别的名字。
2. 删除时是否默认连 agent 的会话记录一起删（默认不删，单独勾选）。
3. 同一个会话允许几端同时输入（默认都允许，尺寸以最后交互的一端为准）。
4. 回话里发现凭据：换成密文写入（默认），还是拦下来让你改。
