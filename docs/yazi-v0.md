# yazi：在终端旁边看 agent 做出的文件（v0，方案）

2026-10-15，catop 提出；同日确认，§3 用做法 2。

用户：考虑加入 yazi cli 的集成，方便在远程或在 agentswitch app 内就能看到工作效果文件（可以考虑按钮+侧边/分屏的方式）。

用户（同日，对方案的选择）：选 A。远程设备不能开 yazi 终端。

用户（同日，对 §3 的冲突）：可以按照你推荐的方法来。即做法 2：节点开关，默认关，只能在节点本机修改。

## 1. 做什么

在 agent 终端的旁边开一个**工具终端**，里面运行 `yazi <agent 当前的文件夹>`，用分屏放在这个终端的右边。agent 写了什么、改了什么，在旁边翻一下就能看到：目录、文本、代码，以及终端能显示的图片。

工具终端复用现有终端的全部机制：持有进程（服务重启时不断，terminal-v0 §10）、分屏、尺寸归属、流和快照、独立窗口。所以 Mac、网页控制台都不用新写界面。

**没有选的方案 B：** 原生的文件侧栏，带 QuickLook 预览。它预览图片、PDF、HTML 的效果最好，但需要一套新的"读节点上的文件"的 API，还要套用受保护目录的规则（`browser/rules.ts`），工作量大很多。以后如果 A 不够用再考虑。简略视图的侧栏已经列出了 agent 改动的文件和 diff（simple-view-v0 §5.2），覆盖了"agent 改了什么"这一半需求。

## 2. 工具终端和 agent 终端的区别

| | agent 终端 | 工具终端 |
|---|---|---|
| 程序 | claude-code / codex / opencode / pi | `yazi`（以后可以加别的，先只有它） |
| 会话记录、hook、配置（profile）、权限卡片 | 有 | 都没有 |
| 列表里 | 文件夹下的一行 | 挂在它的 agent 终端下面，像 subagent 那样缩进一行，标记是文件夹 |
| 结束 | 进程退出后留在列表里，可以恢复对话 | 在 yazi 里按 `q` 退出后**自动移除**；它的 agent 终端关闭时一起关闭 |
| 简略视图 | 有 | 没有（只有终端画面） |

服务端：`TerminalInfo` 加 `kind: "agent" | "tool"`、`tool: "yazi"`、`parent: <agent 终端 id>`。新增路由 `POST /terminals/:id/tool {tool: "yazi"}`，在这个 agent 终端的 `workdir` 里开工具终端，返回新终端。以后 agent `cd` 到别处，已经开着的 yazi 不跟着走；在 yazi 里自己跳过去，或者关掉再开一个。

## 3. 安全：远程设备不能开

yazi 能执行 shell 命令（`:`、`!`、用某个程序打开文件），等于在节点上开了一个**不经过审批**的 shell。按用户的决定：

- `POST /terminals/:id/tool` 只接受本机调用，配对设备（其他节点、手机）调用时返回 403。
- 本机开的工具终端，配对设备**看不到也碰不到**：列表里不返回，它的各条路由（流、`/write`、`/keys`、`/input`、改尺寸）对配对设备一律返回 404。只在"看"的层面放开也不行：能看到流，就能看到 yazi 里预览的任何文件。
- 审计：开、关各记一条（`via` 是本机的哪块屏幕）。

**这一条和 catop 的用法有冲突（已定：做法 2）：** Mac 看 dellarch 上的终端时，对 dellarch 来说 Mac 就是配对设备。所以按上面的规则，从 Mac 上**不能**给 dellarch 的终端开 yazi。而 dellarch 没有桌面应用，只剩 dellarch 本机浏览器里的网页控制台能开。也就是说，"远程看效果文件"这个场景用不了，只有 Mac 给自己本机的终端开 yazi 可以用。

可选的做法：

1. **严格按"远程不能开"**：只有本机（Mac 本机终端、Linux 节点本机的网页控制台）能开。最安全，但从 Mac 看 dellarch 时用不了。
2. **加一个节点开关，默认关**（推荐，2026-10-15 采用）：Linux 节点和 Mac 各自的设置里加 "Paired Nodes May Open yazi"（类似已有的 "Paired Nodes May Type"），只能在节点本机修改（`agentswitch config` 的 Node 页、Mac 的 设置 › Nodes），配对设备改不了。开着时，配对的**节点**可以开、可以用（手机仍然不能，它没有键盘）。不开就是方案 1。理由：一个节点已经允许配对节点打字时，对方本来就能让 agent 跑命令；是否再给一个不经审批的 shell，应该由节点的主人自己决定。

## 4. 各端

- **Mac**：每块的标题栏加一个 Files 按钮（像素外观是字符，Classic 是文件夹图标），列表里 agent 终端的右键菜单加 `Open Files Beside`。点了以后在这块的右边分出一块，放这个终端的 yazi；已经开着的就把焦点移过去。⌘W 关闭。不能开的时候（远程且节点没开开关、节点上没装 yazi）按钮变灰，悬停提示原因。
- **网页控制台**：同样的按钮和菜单。
- **手机**：不做（按第 3 节，手机也不能开）。
- **`agentswitch doctor`**：列出 yazi，作为可选项（没装时提示安装方法，不算错误）。`GET /node` 的 `has` 里加 `yazi`，Mac 据此决定按钮是否可用。

## 5. 图片预览（需要在 Mac 上实测）

yazi 根据环境变量和对终端的查询来选图片协议（kitty、iTerm2 内联图片、sixel），预览的大小还需要终端告诉它每个格子有多少像素。这里中间隔着服务：

- 实时输出原样送到 SwiftTerm。SwiftTerm 1.18 支持 kitty 图片协议和 sixel，iTerm2 协议要实测。
- yazi 的查询由显示端的 SwiftTerm 回答，经 `/write` 回去。多块屏幕同时在看、或者一块都没有时，回答可能乱或者没有。
- 快照里不带图片：换终端回来、重连之后，要在 yazi 里动一下才会重画预览。
- 可能需要在工具终端的环境里指定协议（比如设置 `TERM_PROGRAM`），或者在 yazi 的配置里写死协议。

如果图片在 SwiftTerm 里显示不了，退一步：文本和代码照常预览；图片在 yazi 里按 `o` 交给节点上的程序打开（Mac 本机终端会用预览.app 打开），远程时提示用编辑器按钮。

## 6. 实现顺序（确认之后）

1. 服务：`kind`/`tool`/`parent`、`POST /terminals/:id/tool`、远程过滤、随 agent 终端关闭、退出后移除；doctor 和 `has`。vitest 用一个假的 yazi（回显程序）测试。
2. 节点开关（第 3 节的做法 2）：服务、`agentswitch config`、Mac 设置。
3. Mac：按钮、菜单、列表里的子行、分屏。规则放在 AgentSwitchMacCore 里并写测试；fork 上的 CI 编译和测试；catop 在 Mac 上实测，图片预览按第 5 节处理。
4. 网页控制台。

这部分基于 `terminal-hold`（#3）的持有进程来做。

## 7. 实现记录

### 第 1、2 步：服务和节点开关（2026-10-15）

- **终端的种类**：`TERMINAL_TOOLS = ["yazi"]`，`TerminalInfo.harness` 可以是 agent，也可以是 `yazi`；新加 `parent`（agent 终端为 null）。`TerminalHost.spawnTool(parent, "yazi")` 在 agent 当前的文件夹里开（文件夹不在了就用启动时的），尺寸默认跟 agent 终端一样；同一个 agent 终端已经开着 yazi 时返回开着的那个。工具终端照样交给持有进程，`meta.json` 里记着 `parent`，服务重启后接回；agent 终端没能接回的，工具终端一起删掉。
- **结束**：yazi 退出后终端立即移除（屏幕先收到 `exit`，再收到 `removed`）；删除 agent 终端时，它旁边的工具终端一起删除。
- **启动**：`toolLauncher` 用服务的环境加上 `TERM`、`AGENTSWITCH_TERMINAL_ID`，不带 hook、代理、配置和浏览器。yazi 的位置依次找 `YAZI_BIN`、PATH、`/opt/homebrew/bin`、`/usr/local/bin`、`~/.cargo/bin`。
- **yazi 启动时等终端回答**（实测发现）：yazi 一启动就向终端发一串查询（`CSI ?996n`、`OSC 11;?`、kitty 图片协议的查询、`CSI 16t`、`CSI ?u`，最后是 DA1 `CSI 0c`），**收到 DA1 的回答之前不处理任何按键**。这些查询在任何屏幕连上之前就发出去了，快照里也不带，所以没有人回答，按键全被吞掉（按 `q` 退不出）。现在由服务自己的终端（xterm headless）回答它能回答的（DA1、光标位置）。屏幕如果也回答了，yazi 会丢掉第二个 DA1 回答，用真的 yazi 试过，画面不受影响。测试里的假 yazi 也照这个行为写：去掉服务的回答，测试就会失败。
- **路由**：`POST /terminals/:id/tool {tool, cols?, rows?}`。本机调用随时可以；配对设备只有在节点打开开关时才可以，而且只限节点（设备的 platform 是 `macos` 或 `linux`），手机总是 403。不让看的调用方：`GET /terminals` 里没有工具终端；工具终端的各条路由一律 404（只对形如终端 id 的路径生效，`/terminals/open` 这类不受影响）。实时活动（`/live`）不算工具终端。审计记一条 `tool`。
- **开关**：`mesh.json` 加 `tools`，默认 false（起初叫 `files`；合进主线时主线已有同名的 `files`——配对设备能不能读这台节点的文件，files-v0 §7.5——这里改名为 `tools`，界面上是 `Paired Nodes May Open yazi`）。`PUT /settings/mesh` 只认本机调用，原来就是这样；`PUT` 只改请求里带的开关，只带 `keyboard` 的旧屏幕不会改动 `tools`。`GET /node` 的 `has` 加 `yazi`（这台节点装了 yazi）和 `tools`（开关开着）。`agentswitch config` 的 Node 页加 `Paired Nodes May Open Files`，打开前要确认，关闭不用确认；服务较旧、没有 `files` 时不显示这一行。`agentswitch doctor` 在 tools 一节列出 yazi，作为可选项。
- **验证**：新加 `tests/toolTerminals.test.ts` 7 个测试：同一个 agent 终端只开一个、退出后移除、随 agent 终端一起关闭、各种拒绝、启动环境、实时活动不算；节点和手机在开关关、开两种状态下能看到什么、能开什么、各条路由的状态码；只带 `keyboard` 的请求保留 `tools`。TUI 加 1 个测试。全部 1842 个通过。在 dellarch 上用真的 yazi（`/usr/bin/yazi`）开过：三栏照常画出，按 `q` 后终端被移除。
- 还没做：Mac 和网页控制台的按钮（第 3、4 步）；图片预览（§5）。

### 第 3 步：Mac（2026-10-15）

- **按钮**：窗口顶栏多一个三栏图标（起初是文件夹图标，合进主线时文件夹已是主线文件栏的图标，改为三栏），对当前这块的终端（2026-10-15 补：原来只放在每块的标题栏里，只有一块时没有标题栏，所以看不到）；分屏后每块的标题栏也有一个（agent 终端在运行时才有），列表里 agent 终端的右键菜单多一项 `Open yazi Beside`（起初叫 `Open Files Beside`，同样为了和文件栏分开改名）。点了以后在这块的右边分出一块放 yazi；已经开着的，焦点移过去。不能开时（节点上没装 yazi、远程节点没打开开关），页脚显示服务给的原因。没有按 §4 原来写的那样把按钮变灰：那样要多读一次节点的 `has`，而服务本来就会说明原因。
- **列表**：工具终端不算它所在文件夹的终端，不计入数量，没有 ⌘ 数字，也不出现在 agent 筛选里。它列在自己的 agent 终端下面，排在 subagent 之后，树枝线照常接上。
- **分屏**：工具终端总是显示终端画面，没有简略视图（切换按钮不显示，快捷键也不起作用）。yazi 退出后，服务移除终端，它所在的那块随之关闭（列表里没有了的终端带走自己的那块，原来就是这样）。
- **设置**：设置 › Nodes › This Mac 加 `Paired Nodes May Open yazi`（mesh.json `tools`）。打开前弹出确认，关闭直接生效；服务较旧、不认识这个开关时不显示。改其他开关时保留 `tools` 原来的值。
- **验证**：Core 加 3 个测试：工具终端在列表里的位置和树枝线、`parent` 的解码、`tools` 未知时请求里不带它。编译和测试交给 fork 上的 CI；在 Mac 上实际点击、yazi 的图片预览还要 catop 在 Mac 上试。
- 还没做：网页控制台（第 4 步）。

### 第 4 步：网页控制台（2026-10-15）

- 终端的右键菜单加 `Open yazi Beside`（起初叫 `Open Files Beside`，与 Mac 一起改名）：开 yazi，有分屏时放在右边新分出的一块，没有分屏时直接切过去；服务拒绝时提示它给的原因。只有一块时网页没有标题栏，所以只放在菜单里。
- 列表和 Mac 一样：工具终端不进文件夹，没有 ⌘ 数字，列在 agent 终端的 subagent 后面；标记位置写程序名 `yazi`（它没有图标）。
- 验证：语法检查和全部测试通过；**没有在浏览器里点过**。
